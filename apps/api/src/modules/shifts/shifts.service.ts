import { Injectable, Logger } from '@nestjs/common';
import type {
  CurrentWorkPassportDto,
  ReworkPassportDto,
  ShiftMetaDto,
  ShiftSessionDto,
} from '@sewing/shared/shifts';
import { PassportEventType, PassportStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  EmployeeInactiveException,
  EmployeeNotFoundException,
  EquipmentInactiveException,
  EquipmentNotFoundException,
  OperationInactiveException,
  OperationNotFoundException,
  ShiftAlreadyActiveException,
  ShiftHasActivePassportsException,
  ShiftNotActiveException,
  ShiftOperationNotAllowedForEquipmentException,
} from '../../common/errors.js';
import { SalaryService } from '../salary/salary.service.js';
import { closeShiftSegments, openShiftSegment } from './shift-segments.js';

type ShiftRow = Prisma.ShiftSessionGetPayload<{
  include: { employee: true; equipment: true; operation: true };
}>;

@Injectable()
export class ShiftsService {
  private readonly logger = new Logger(ShiftsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly salary: SalaryService,
  ) {}

  // -------------------------------------------------------------------------
  // START
  // -------------------------------------------------------------------------

  async start(dto: {
    employeeId: string;
    equipmentId: string;
    operationId: string;
  }): Promise<ShiftSessionDto> {
    const [employee, equipment, operation] = await Promise.all([
      this.prisma.employee.findUnique({ where: { id: dto.employeeId } }),
      this.prisma.equipment.findUnique({ where: { id: dto.equipmentId } }),
      this.prisma.operation.findUnique({ where: { id: dto.operationId } }),
    ]);
    if (!employee) throw new EmployeeNotFoundException();
    if (!employee.active) throw new EmployeeInactiveException();
    if (!equipment) throw new EquipmentNotFoundException();
    if (!equipment.active) throw new EquipmentInactiveException();
    if (!operation) throw new OperationNotFoundException();
    if (!operation.active) throw new OperationInactiveException();

    // Allow-list `EquipmentOperation` (ADR-0017). Источник правды
    // тот же, что у `getMeta`: связь должна существовать и быть
    // `isActive=true`. Без этой проверки backend пропускал любую
    // активную операцию на любом активном оборудовании, в обход
    // UI-фильтра /shifts/meta. Закрывает finding из
    // `docs/operations-test-findings.md` (`ShiftsService.start`).
    const allowed = await this.prisma.equipmentOperation.findFirst({
      where: {
        equipmentId: dto.equipmentId,
        operationId: dto.operationId,
        isActive: true,
      },
      select: { id: true },
    });
    if (!allowed) {
      throw new ShiftOperationNotAllowedForEquipmentException();
    }

    const current = await this.findActiveByEmployee(dto.employeeId);
    if (current) throw new ShiftAlreadyActiveException();

    try {
      const created = await this.prisma.shiftSession.create({
        data: {
          employeeId: dto.employeeId,
          equipmentId: dto.equipmentId,
          operationId: dto.operationId,
        },
        include: { employee: true, equipment: true, operation: true },
      });
      // Первый отрезок смены (табель дня, см. `shift-segments.ts`).
      // Границу берём из самой смены, чтобы «присутствие» сходилось с
      // суммой сегментов до миллисекунды.
      await openShiftSegment(this.prisma, {
        shiftSessionId: created.id,
        employeeId: created.employeeId,
        equipmentId: created.equipmentId,
        operationId: created.operationId,
        at: created.startedAt,
      });
      // Окладные начисления (ADR-0021): SALARY/MIXED-сотруднику
      // создаётся/обновляется запись `SalaryEntry` за день старта
      // смены. fail-soft: ошибки sync не должны валить старт смены —
      // зарплата выровняется на следующем `start/stop`.
      await this.safeSyncSalary(created.employeeId, created.startedAt);
      return this.toDto(created);
    } catch (e) {
      // Гонка между check и insert: partial unique index
      // `shift_session_active_employee_uniq` (см. PrismaService) защищает
      // инвариант «одна активная смена на сотрудника» на уровне БД.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ShiftAlreadyActiveException();
      }
      throw e;
    }
  }

  // -------------------------------------------------------------------------
  // SWITCH OPERATION (на активной смене)
  // -------------------------------------------------------------------------

  /**
   * Меняет `operationId` у активной смены сотрудника без stop/start.
   *
   * Сценарий: на одном оборудовании у швеи разрешено несколько операций
   * (например, «Распошив подгиб» и «Распошив рукава» на распошивальной
   * машине). Чтобы не закрывать и не открывать смену заново, она
   * переключает операцию одним движением.
   *
   * Инварианты:
   *   - активная смена должна существовать (`SHIFT_NOT_ACTIVE`);
   *   - целевая операция активна (`OPERATION_INACTIVE`/`OPERATION_NOT_FOUND`);
   *   - целевая операция входит в allow-list `EquipmentOperation` для
   *     текущего оборудования смены
   *     (`SHIFT_OPERATION_NOT_ALLOWED_FOR_EQUIPMENT`);
   *   - у сотрудника не должно быть паспортов
   *     `currentEmployeeId = me AND status = IN_PROGRESS`
   *     (`SHIFT_HAS_ACTIVE_PASSPORTS`). Это критично: на завершении
   *     операции `PassportsService.completeOperationByEmployee` берёт
   *     `session.operationId` (а не `passport.currentOperationId`), и
   *     если переключить смену прямо во время работы — паспорт «уехал
   *     бы» на новую операцию в событии `OPERATION_FINISHED`.
   *
   * Идемпотентность: переключение на ту же операцию не пишет update,
   * возвращает текущий DTO. Окладные начисления не зависят от
   * `operationId`, поэтому `syncDailySalary` не вызываем.
   */
  async switchOperation(dto: {
    employeeId: string;
    operationId: string;
  }): Promise<ShiftSessionDto> {
    const current = await this.findActiveByEmployee(dto.employeeId);
    if (!current) throw new ShiftNotActiveException();

    // No-op: тот же operationId — просто отдаём текущий DTO.
    if (current.operationId === dto.operationId) {
      return this.toDto(current);
    }

    const operation = await this.prisma.operation.findUnique({
      where: { id: dto.operationId },
    });
    if (!operation) throw new OperationNotFoundException();
    if (!operation.active) throw new OperationInactiveException();

    const allowed = await this.prisma.equipmentOperation.findFirst({
      where: {
        equipmentId: current.equipmentId,
        operationId: dto.operationId,
        isActive: true,
      },
      select: { id: true },
    });
    if (!allowed) throw new ShiftOperationNotAllowedForEquipmentException();

    // Защита от записи OPERATION_FINISHED на «не ту» операцию (см. JSDoc
    // и `ShiftHasActivePassportsException`). Достаточно одного попадания.
    //
    // Исключение для substitute-перехода: если новая операция в
    // `OperationSubstitution` помечена substitute'ом для ТЕКУЩЕЙ, это
    // легитимный fallback (сценарий «сломался станок Подгиб низа,
    // швея-рукав закрывает full Распошив»). Швея добивает паспорта на
    // руках уже под new op, EarningsService при `createPendingForCompletedOperation`
    // вычитает уже выплаченную сдельную за satisfied-op (substitute credit),
    // двойной оплаты не будет. См.
    // `prisma/migrations/20260729200000_add_operation_substitution`.
    const isSubstituteTransition =
      (await this.prisma.operationSubstitution.findFirst({
        where: {
          satisfiesOpId: current.operationId,
          substituteOpId: dto.operationId,
        },
        select: { id: true },
      })) !== null;
    if (!isSubstituteTransition) {
      const stuck = await this.prisma.passport.findFirst({
        where: {
          currentEmployeeId: dto.employeeId,
          status: PassportStatus.IN_PROGRESS,
        },
        select: { id: true },
      });
      if (stuck) throw new ShiftHasActivePassportsException();
    }

    const updated = await this.prisma.shiftSession.update({
      where: { id: current.id },
      data: { operationId: dto.operationId },
      include: { employee: true, equipment: true, operation: true },
    });

    // Табель дня: режем смену на отрезки — иначе всё её время досталось
    // бы последней операции (см. `shift-segments.ts`). Обе границы —
    // один и тот же момент, чтобы отрезки шли встык без «дыры».
    const switchedAt = new Date();
    await closeShiftSegments(this.prisma, current.id, switchedAt);
    await openShiftSegment(this.prisma, {
      shiftSessionId: updated.id,
      employeeId: updated.employeeId,
      equipmentId: updated.equipmentId,
      operationId: updated.operationId,
      at: switchedAt,
    });

    this.logger.log(
      `event=shift.switch-operation employeeId=${dto.employeeId} from=${current.operationId} to=${dto.operationId}`,
    );
    return this.toDto(updated);
  }

  // -------------------------------------------------------------------------
  // STOP
  // -------------------------------------------------------------------------

  async stop(dto: { employeeId: string }): Promise<ShiftSessionDto> {
    const current = await this.findActiveByEmployee(dto.employeeId);
    if (!current) throw new ShiftNotActiveException();
    const endedAt = new Date();
    const updated = await this.prisma.shiftSession.update({
      where: { id: current.id },
      data: { endedAt },
      include: { employee: true, equipment: true, operation: true },
    });
    // Табель дня: последний отрезок закрывается ровно концом смены.
    // Через `stop` идёт и принудительное завершение мастером
    // (`MasterEmployeeStatsService.closeActiveShift`), так что отдельной
    // врезки там не нужно.
    await closeShiftSegments(this.prisma, updated.id, endedAt);
    // Окладные начисления (ADR-0021): подстраховка на стороне stop —
    // если start был до внедрения sync (legacy-данные) или прошёл
    // мимо по любой причине, на stop запись будет создана. Берём
    // дату `startedAt` смены, а не `now()`, чтобы не сдвинуть оклад
    // на следующий день при ночном завершении.
    await this.safeSyncSalary(updated.employeeId, updated.startedAt);
    return this.toDto(updated);
  }

  /**
   * fail-soft обёртка над `SalaryService.syncDailySalary`. Ошибки в
   * окладной синхронизации не должны валить shift-операцию: для
   * сменщика интерфейс остаётся отзывчивым, а зарплата выровняется
   * на следующем `start/stop`. Любая ошибка логируется и съедается.
   */
  private async safeSyncSalary(employeeId: string, startedAt: Date) {
    try {
      await this.salary.syncDailySalary(employeeId, startedAt);
    } catch (err) {
      this.logger.warn(
        `syncDailySalary failed (employeeId=${employeeId}, date=${startedAt.toISOString()}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // CURRENT
  // -------------------------------------------------------------------------

  async getCurrent(employeeId: string): Promise<ShiftSessionDto | null> {
    const row = await this.findActiveByEmployee(employeeId);
    return row ? this.toDto(row) : null;
  }

  // -------------------------------------------------------------------------
  // CURRENT WORK (Шаг 6.1: «текущий крой в работе у сотрудника»)
  // -------------------------------------------------------------------------

  /**
   * Возвращает кройи, закреплённые за сотрудником прямо сейчас.
   *
   * Правило: `Passport.currentEmployeeId = employeeId` И
   * `status = IN_PROGRESS`. Любое перемещение паспорта дальше по цепочке
   * (другой исполнитель скан-нул на следующей операции, упаковка
   * закрыла паспорт в коробку) автоматически выводит его из этого
   * списка — без отдельного «возврата кроя» (см. `docs/flows.md §F3a/§F4`).
   *
   * Сортировка — по `updatedAt desc`: самый свежий приём кроя сверху.
   * `acceptedAt` подтягивается из последнего `ISSUED_TO_EMPLOYEE`
   * события самого сотрудника — нужно UI, чтобы показать «когда я это
   * взяла». Если такого события нет (например, паспорт получен ещё до
   * введения этого поля), отдаём `null`.
   *
   * Источник истины — БД. Backend сам вырезает по `employeeId` из
   * сессии — клиент не может запросить чужой список (ADR-0014).
   */
  async getCurrentWork(employeeId: string): Promise<CurrentWorkPassportDto[]> {
    const rows = await this.prisma.passport.findMany({
      where: {
        currentEmployeeId: employeeId,
        status: PassportStatus.IN_PROGRESS,
      },
      include: {
        product: { select: { name: true } },
        size: { select: { id: true, code: true } },
        currentOperation: { select: { id: true, code: true, name: true } },
        // Soft-route MVP: подтягиваем snapshot маршрута заказа, чтобы
        // отдать UI «текущий шаг / следующий шаг». Без этого UI пришлось
        // бы делать N отдельных запросов в /api/orders/:id.
        order: {
          select: {
            routeSteps: {
              orderBy: { index: 'asc' },
              include: { operation: { select: { id: true, code: true, name: true } } },
            },
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });
    if (rows.length === 0) return [];

    // Подтягиваем последний ISSUED_TO_EMPLOYEE этого сотрудника по
    // каждому паспорту одним батч-запросом. Используется только как
    // вспомогательная подпись «принят в HH:MM» — отсутствие события
    // не должно ронять основной ответ, поэтому fail-soft.
    const issuedAt = new Map<string, string>();
    try {
      const events = await this.prisma.passportEvent.findMany({
        where: {
          passportId: { in: rows.map((r) => r.id) },
          employeeId,
          type: PassportEventType.ISSUED_TO_EMPLOYEE,
        },
        select: { passportId: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      });
      for (const ev of events) {
        // findMany уже отдал по DESC; первое попавшееся — самое свежее.
        if (!issuedAt.has(ev.passportId)) {
          issuedAt.set(ev.passportId, ev.createdAt.toISOString());
        }
      }
    } catch {
      // ignore: подпись «принят» опциональна
    }

    return rows.map((r) => {
      const steps = r.order.routeSteps;
      const currentIndex = r.currentRouteStepIndex;
      const currentStep =
        currentIndex !== null
          ? steps.find((s) => s.index === currentIndex) ?? null
          : null;
      const nextStep =
        currentIndex !== null
          ? steps.find((s) => s.index === currentIndex + 1) ?? null
          : steps[0] ?? null;
      return {
        id: r.id,
        number: r.number,
        productName: r.product.name,
        color: r.color,
        sizeId: r.size.id,
        sizeCode: r.size.code,
        qtyCut: r.qtyCut,
        qtyGood: r.qtyGood,
        qtyDefect: r.qtyDefect,
        rollNumber: r.rollNumber,
        status: r.status,
        currentOperationId: r.currentOperation?.id ?? null,
        currentOperationCode: r.currentOperation?.code ?? null,
        currentOperationName: r.currentOperation?.name ?? null,
        acceptedAt: issuedAt.get(r.id) ?? null,
        updatedAt: r.updatedAt.toISOString(),
        currentRouteStepIndex: r.currentRouteStepIndex,
        routeCurrentStep: currentStep
          ? {
              index: currentStep.index,
              operationId: currentStep.operation.id,
              operationCode: currentStep.operation.code,
              operationName: currentStep.operation.name,
            }
          : null,
        routeOperationIds: steps.map((s) => s.operation.id),
        routeNextStep: nextStep
          ? {
              index: nextStep.index,
              operationId: nextStep.operation.id,
              operationCode: nextStep.operation.code,
              operationName: nextStep.operation.name,
            }
          : null,
      };
    });
  }

  /**
   * Список паспортов, возвращённых ОТК на переделку этому сотруднику
   * (см. `QcService.returnToRework`, `docs/flows.md §F5a`).
   *
   * Источник — `PassportEvent(OPERATION_REWORK_OPENED)` с
   * `employeeId = me`, без последующего `OPERATION_FINISHED` для
   * той же пары `(passportId, operationId)`. То есть «открытый rework».
   *
   * Используется на `/work` для секции «К переделке от ОТК» —
   * подсказка швее, какие паспорта нужно забрать у ОТК и довести.
   * После того как швея сосканирует паспорт у станка и завершит
   * операцию повторно, событие `OPERATION_FINISHED` закроет открытый
   * rework, и паспорт автоматически уйдёт из этого списка.
   */
  async getMyReworkPassports(
    employeeId: string,
  ): Promise<ReworkPassportDto[]> {
    const reworks = await this.prisma.passportEvent.findMany({
      where: {
        employeeId,
        type: PassportEventType.OPERATION_REWORK_OPENED,
      },
      select: {
        passportId: true,
        operationId: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    if (reworks.length === 0) return [];

    // Дедуп по (passport, operationId) — оставляем самый свежий rework
    // на эту пару. Если ОТК делал несколько циклов rework, нас
    // интересует только последний.
    const seen = new Set<string>();
    const latest: typeof reworks = [];
    for (const r of reworks) {
      if (!r.operationId) continue;
      const key = `${r.passportId}:${r.operationId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      latest.push(r);
    }

    // Оставляем только «открытые» — те, после которых не было
    // `OPERATION_FINISHED` для той же (passport, operation).
    const open: typeof latest = [];
    for (const r of latest) {
      const finished = await this.prisma.passportEvent.findFirst({
        where: {
          passportId: r.passportId,
          operationId: r.operationId,
          type: PassportEventType.OPERATION_FINISHED,
          createdAt: { gt: r.createdAt },
        },
        select: { id: true },
      });
      if (!finished) open.push(r);
    }
    if (open.length === 0) return [];

    const passportIds = open.map((r) => r.passportId);
    const passports = await this.prisma.passport.findMany({
      where: {
        id: { in: passportIds },
        status: PassportStatus.IN_PROGRESS,
      },
      include: {
        product: { select: { name: true } },
        size: { select: { code: true } },
        order: { select: { id: true, number: true } },
      },
    });
    const passportById = new Map(passports.map((p) => [p.id, p]));

    const operationIds = Array.from(
      new Set(open.map((r) => r.operationId).filter((x): x is string => !!x)),
    );
    const operations = await this.prisma.operation.findMany({
      where: { id: { in: operationIds } },
      select: { id: true, code: true, name: true },
    });
    const operationById = new Map(operations.map((o) => [o.id, o]));

    const items: ReworkPassportDto[] = [];
    for (const r of open) {
      const p = passportById.get(r.passportId);
      if (!p) continue;
      const op = r.operationId ? operationById.get(r.operationId) : null;
      if (!op) continue;
      items.push({
        passportId: p.id,
        passportNumber: p.number,
        orderId: p.order.id,
        orderNumber: p.order.number,
        productName: p.product.name,
        color: p.color,
        sizeCode: p.size.code,
        qtyCut: p.qtyCut,
        qtyGood: p.qtyGood,
        operationCode: op.code,
        operationName: op.name,
        reworkedAt: r.createdAt.toISOString(),
      });
    }
    return items;
  }

  // -------------------------------------------------------------------------
  // META (справочники для UI формы смены)
  // -------------------------------------------------------------------------

  async getMeta(): Promise<ShiftMetaDto> {
    const [employees, equipment, operations] = await Promise.all([
      this.prisma.employee.findMany({
        where: { active: true },
        orderBy: { fullName: 'asc' },
      }),
      this.prisma.equipment.findMany({
        where: { active: true },
        orderBy: { code: 'asc' },
        // Источник истины для seamstress flow на /work — таблица
        // `EquipmentOperation` (см. ADR-0017). Возвращаем
        // `allowedOperationIds` уже отсортированными по
        // `EquipmentOperation.sortOrder`, чтобы UI не делал лишний
        // sort. Неактивные операции отдельно фильтруем — их в
        // /work показывать нельзя.
        include: {
          allowedOperations: {
            where: { isActive: true, operation: { active: true } },
            orderBy: { sortOrder: 'asc' },
            select: { operationId: true },
          },
        },
      }),
      this.prisma.operation.findMany({
        where: { active: true },
        orderBy: { sortOrder: 'asc' },
      }),
    ]);
    return {
      employees: employees.map((e) => ({
        id: e.id,
        login: e.login,
        fullName: e.fullName,
        role: e.role,
      })),
      equipment: equipment.map((q) => ({
        id: q.id,
        code: q.code,
        name: q.name,
        active: q.active,
        allowedOperationIds: q.allowedOperations.map((l) => l.operationId),
      })),
      operations: operations.map((o) => ({
        id: o.id,
        code: o.code,
        name: o.name,
        category: o.category,
        sortOrder: o.sortOrder,
        active: o.active,
        pricingMode: o.pricingMode,
        fixedRate: o.fixedRate != null ? o.fixedRate.toNumber() : null,
        // Признак «это коробочная упаковка» (`Operation.boxPacking`).
        // Отдаём в meta, потому что /packing по операции активной
        // смены решает, какой терминал показать: окно коробок
        // (`true`) или обычный passport-flow скан + завершение
        // (`false` — так работает «Распаковка», операция категории
        // PACKING первым шагом маршрута). Раньше развилка шла по
        // `category === 'PACKING'` и ловила обе операции разом.
        boxPacking: o.boxPacking,
      })),
    };
  }

  // -------------------------------------------------------------------------
  // INTERNAL
  // -------------------------------------------------------------------------

  /**
   * Активная смена сотрудника, если есть. Правило «не более одной активной
   * смены на сотрудника» enforce-ится и на сервисе, и на БД (partial
   * unique index `shift_session_active_employee_uniq`, см. ADR-0015).
   */
  private findActiveByEmployee(employeeId: string) {
    return this.prisma.shiftSession.findFirst({
      where: { employeeId, endedAt: null },
      include: { employee: true, equipment: true, operation: true },
    });
  }

  private toDto(row: ShiftRow): ShiftSessionDto {
    return {
      id: row.id,
      employeeId: row.employeeId,
      employeeFullName: row.employee.fullName,
      equipmentId: row.equipmentId,
      equipmentCode: row.equipment.code,
      equipmentName: row.equipment.name,
      operationId: row.operationId,
      operationCode: row.operation.code,
      operationName: row.operation.name,
      startedAt: row.startedAt.toISOString(),
      endedAt: row.endedAt ? row.endedAt.toISOString() : null,
      active: row.endedAt === null,
    };
  }
}
