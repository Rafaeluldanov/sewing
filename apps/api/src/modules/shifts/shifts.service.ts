import { Injectable, Logger } from '@nestjs/common';
import type {
  CurrentWorkPassportDto,
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
  ShiftNotActiveException,
} from '../../common/errors.js';
import { SalaryService } from '../salary/salary.service.js';

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
  // STOP
  // -------------------------------------------------------------------------

  async stop(dto: { employeeId: string }): Promise<ShiftSessionDto> {
    const current = await this.findActiveByEmployee(dto.employeeId);
    if (!current) throw new ShiftNotActiveException();
    const updated = await this.prisma.shiftSession.update({
      where: { id: current.id },
      data: { endedAt: new Date() },
      include: { employee: true, equipment: true, operation: true },
    });
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
