import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  MasterCallStatus,
  PassportStatus,
  Prisma,
} from '@prisma/client';
import {
  EMPLOYEE_QR_PREFIX,
  parseEmployeeQr,
  type CreateMasterCallDto,
  type MasterCallDto,
  type MasterCallPassportDto,
  type ResolveMasterCallByQrDto,
} from '@sewing/shared/master-calls';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';

/**
 * MVP «Мастер цеха» — регистр и резолв вызовов рабочих.
 *
 * Контракт (см. `apps/api/src/modules/master-calls/master-calls.controller.ts`,
 * `prisma/schema.prisma::MasterCall`, `docs/flows.md §«Вызов мастера»`):
 *
 *   - `create(employee)` — рабочий нажал «Мастер» на своём терминале.
 *     Идемпотентно: если у сотрудника уже есть `OPEN`-вызов, мы НЕ
 *     плодим дубль, а возвращаем существующий. Пишем `MASTER_CALLED`
 *     в audit только при реальном создании.
 *   - `listOpen()` — мастер цеха / SHOP_MANAGER / ADMIN видят очередь
 *     открытых вызовов с контекстом «кого, на каком станке, какие
 *     паспорта».
 *   - `resolveByEmployeeQr(qr, actor)` — мастер закрыл вызов сканом
 *     QR сотрудника. Пишем `MASTER_CALL_RESOLVED` в audit.
 *
 * Транзакционность: и создание, и закрытие вызова идут в одном
 * `prisma.$transaction(...)` вместе с записью в `AuditLog` —
 * инвариант «либо и операция, и аудит, либо ничего» (см. ADR
 * audit-log + `audit.service.ts`).
 */
@Injectable()
export class MasterCallsService {
  private readonly logger = new Logger(MasterCallsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  // CREATE
  // -------------------------------------------------------------------------

  /**
   * Создать вызов мастера для сотрудника-инициатора.
   *
   * Backend подтягивает активную `ShiftSession` сотрудника и копирует
   * `equipmentId`/`operationId` в карточку вызова — это нужно, чтобы
   * `/master` сразу показал контекст («Оверлок 3, операция Шов»), а
   * `/shopfloor/display` мог подсветить плитку этого станка
   * (`display-equipment-tile--master-call`).
   *
   * Идемпотентность: если у `employeeId` уже есть вызов в статусе
   * `OPEN`, возвращаем его без изменений и без новой audit-записи.
   * Это важно для UX «нажал ещё раз — ничего не сломалось»: кнопка
   * на рабочем терминале не должна блокировать работу и не должна
   * плодить дубли при двойном тапе.
   */
  async create(
    actor: AuthPrincipal,
    dto: CreateMasterCallDto,
  ): Promise<MasterCallDto> {
    const employeeId = actor.employeeId;

    const existing = await this.prisma.masterCall.findFirst({
      where: { employeeId, status: MasterCallStatus.OPEN },
      orderBy: { createdAt: 'asc' },
      include: masterCallInclude,
    });
    if (existing) {
      const passports = await this.loadCurrentPassports(employeeId);
      return toMasterCallDto(existing, passports);
    }

    const shift = await this.prisma.shiftSession.findFirst({
      where: { employeeId, endedAt: null },
      orderBy: { startedAt: 'desc' },
      select: { equipmentId: true, operationId: true },
    });

    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.masterCall.create({
        data: {
          employeeId,
          equipmentId: shift?.equipmentId ?? null,
          operationId: shift?.operationId ?? null,
          message: dto.message ?? null,
        },
        include: masterCallInclude,
      });
      await this.audit.log(
        {
          event: 'MASTER_CALLED',
          entityType: 'MASTER_CALL',
          entityId: row.id,
          employeeId,
          payload: {
            employeeId,
            equipmentId: row.equipmentId,
            operationId: row.operationId,
            // Сообщение храним в payload только если оно реально
            // прислано — для будущего расширения. Сейчас всегда null.
            message: row.message,
          },
        },
        tx,
      );
      return row;
    });

    this.logger.log(
      `event=master_call.create id=${created.id} employeeId=${employeeId} equipmentId=${created.equipmentId ?? '-'}`,
    );
    const passports = await this.loadCurrentPassports(employeeId);
    return toMasterCallDto(created, passports);
  }

  // -------------------------------------------------------------------------
  // READ
  // -------------------------------------------------------------------------

  /**
   * Очередь открытых вызовов для `/master`.
   *
   * Сортировка по `createdAt asc` — самый давний вызов сверху, чтобы
   * мастер цеха видел очередь FIFO (никто не ждёт дольше, чем должен).
   * `currentPassports` подгружаются одним батчем (см.
   * `loadCurrentPassportsForEmployees`), чтобы не плодить N+1 при
   * длинной очереди.
   */
  async listOpen(): Promise<MasterCallDto[]> {
    const calls = await this.prisma.masterCall.findMany({
      where: { status: MasterCallStatus.OPEN },
      orderBy: { createdAt: 'asc' },
      include: masterCallInclude,
    });
    if (calls.length === 0) return [];

    const employeeIds = Array.from(new Set(calls.map((c) => c.employeeId)));
    const passportsByEmployee =
      await this.loadCurrentPassportsForEmployees(employeeIds);

    return calls.map((c) =>
      toMasterCallDto(c, passportsByEmployee.get(c.employeeId) ?? []),
    );
  }

  // -------------------------------------------------------------------------
  // RESOLVE
  // -------------------------------------------------------------------------

  /**
   * Закрыть вызов сотрудника по сканированному QR.
   *
   * Алгоритм:
   *   1. Распарсить `qr` (`EMPLOYEE:<id>`); если payload не подходит —
   *      `400 INVALID_EMPLOYEE_QR` (Zod уже отсекает большую часть, но
   *      здесь страхуемся ещё раз);
   *   2. Найти `Employee` по id; нет — `404 EMPLOYEE_NOT_FOUND`;
   *   3. Найти его самый давний `OPEN`-вызов; нет — `404
   *      MASTER_CALL_NOT_FOUND` (закрывать нечего);
   *   4. В транзакции: перевести в `RESOLVED`, записать `resolvedAt`,
   *      `resolvedById`, эмитнуть `MASTER_CALL_RESOLVED` в audit.
   */
  async resolveByEmployeeQr(
    actor: AuthPrincipal,
    dto: ResolveMasterCallByQrDto,
  ): Promise<MasterCallDto> {
    const employeeId = parseEmployeeQr(dto.qr);
    if (!employeeId) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'INVALID_EMPLOYEE_QR',
        message: `Некорректный QR сотрудника (ожидается ${EMPLOYEE_QR_PREFIX}<id>).`,
      });
    }

    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true },
    });
    if (!employee) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'EMPLOYEE_NOT_FOUND',
        message: 'Сотрудник по этому QR не найден.',
      });
    }

    const open = await this.prisma.masterCall.findFirst({
      where: { employeeId, status: MasterCallStatus.OPEN },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (!open) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'MASTER_CALL_NOT_FOUND',
        message: 'У этого сотрудника нет открытого вызова мастера.',
      });
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.masterCall.update({
        where: { id: open.id },
        data: {
          status: MasterCallStatus.RESOLVED,
          resolvedAt: new Date(),
          resolvedById: actor.employeeId,
        },
        include: masterCallInclude,
      });
      await this.audit.log(
        {
          event: 'MASTER_CALL_RESOLVED',
          entityType: 'MASTER_CALL',
          entityId: row.id,
          employeeId: actor.employeeId,
          payload: {
            masterCallId: row.id,
            employeeId,
            equipmentId: row.equipmentId,
            operationId: row.operationId,
            resolvedById: actor.employeeId,
          },
        },
        tx,
      );
      return row;
    });

    this.logger.log(
      `event=master_call.resolve id=${updated.id} employeeId=${employeeId} resolvedById=${actor.employeeId}`,
    );
    const passports = await this.loadCurrentPassports(employeeId);
    return toMasterCallDto(updated, passports);
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  private async loadCurrentPassports(
    employeeId: string,
  ): Promise<MasterCallPassportDto[]> {
    const map = await this.loadCurrentPassportsForEmployees([employeeId]);
    return map.get(employeeId) ?? [];
  }

  /**
   * Один батч-запрос за паспортами, которые сейчас «на руках» у
   * сотрудников из списка. Тот же контракт, что использует
   * `ShopfloorService.listEquipmentStatus` для `currentSizes`:
   * `Passport.currentEmployeeId IN (...)` + `status = IN_PROGRESS`.
   *
   * Это самый честный «срез сейчас» без необходимости заглядывать в
   * `ShiftSession`/`PassportEvent` — паспорт, у которого швея именно
   * сейчас в работе, помечен `currentEmployeeId`. После
   * `completeOperationByEmployee` поле обнуляется, и такой паспорт
   * сюда не попадёт (это ровно та семантика, что нужна `/master`:
   * показать, на чём стоит работа того, кто позвал).
   */
  private async loadCurrentPassportsForEmployees(
    employeeIds: string[],
  ): Promise<Map<string, MasterCallPassportDto[]>> {
    const out = new Map<string, MasterCallPassportDto[]>();
    if (employeeIds.length === 0) return out;
    const rows = await this.prisma.passport.findMany({
      where: {
        currentEmployeeId: { in: employeeIds },
        status: PassportStatus.IN_PROGRESS,
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        color: true,
        qtyCut: true,
        status: true,
        orderId: true,
        currentEmployeeId: true,
        currentRouteStepIndex: true,
        size: { select: { code: true } },
        order: { select: { number: true } },
        currentOperation: { select: { id: true, name: true } },
        currentCell: { select: { id: true, code: true } },
      },
    });
    if (rows.length === 0) return out;

    // Stage 2 «Действия мастера»: snapshot маршрута заказа нужен в
    // bottom-sheet «Назначить операцию» — мастер должен выбирать только
    // шаги, реально известные паспорту. Грузим один батч-запросом по
    // всем заказам, чтобы не плодить N+1 при длинной очереди.
    const orderIds = Array.from(new Set(rows.map((r) => r.orderId)));
    const stepRows = await this.prisma.orderRouteStep.findMany({
      where: { orderId: { in: orderIds } },
      orderBy: [{ orderId: 'asc' }, { index: 'asc' }],
      select: {
        orderId: true,
        index: true,
        operation: { select: { id: true, name: true } },
      },
    });
    const stepsByOrder = new Map<
      string,
      Array<{ index: number; operationId: string; operationName: string }>
    >();
    for (const s of stepRows) {
      let arr = stepsByOrder.get(s.orderId);
      if (!arr) {
        arr = [];
        stepsByOrder.set(s.orderId, arr);
      }
      arr.push({
        index: s.index,
        operationId: s.operation.id,
        operationName: s.operation.name,
      });
    }

    for (const r of rows) {
      const emp = r.currentEmployeeId;
      if (!emp) continue;
      let arr = out.get(emp);
      if (!arr) {
        arr = [];
        out.set(emp, arr);
      }
      // Ограничиваем длину — на телефоне карточка с десятком паспортов
      // визуально расползается. 6 — практический лимит «реалистичного
      // числа открытых паспортов на одной швее».
      if (arr.length >= 6) continue;
      const orderSteps = stepsByOrder.get(r.orderId) ?? [];
      arr.push({
        id: r.id,
        number: r.order.number,
        size: r.size.code,
        color: r.color ?? null,
        qtyCut: r.qtyCut,
        status: r.status,
        orderNumber: r.order.number,
        currentOperation: r.currentOperation
          ? { id: r.currentOperation.id, name: r.currentOperation.name }
          : null,
        currentCell: r.currentCell
          ? { id: r.currentCell.id, code: r.currentCell.code }
          : null,
        currentRouteStepIndex: r.currentRouteStepIndex,
        routeSteps: orderSteps.map((s) => ({
          index: s.index,
          operationId: s.operationId,
          operationName: s.operationName,
          isCurrent: s.index === r.currentRouteStepIndex,
        })),
      });
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// helpers (private to module)
// ---------------------------------------------------------------------------

const masterCallInclude = {
  employee: { select: { id: true, fullName: true, role: true } },
  equipment: {
    select: { id: true, code: true, name: true, displayNumber: true },
  },
  operation: { select: { id: true, name: true } },
} as const;

type MasterCallRow = Prisma.MasterCallGetPayload<{
  include: typeof masterCallInclude;
}>;

function toMasterCallDto(
  row: MasterCallRow,
  passports: MasterCallPassportDto[],
): MasterCallDto {
  return {
    id: row.id,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    message: row.message,
    employee: {
      id: row.employee.id,
      fullName: row.employee.fullName,
      role: row.employee.role,
    },
    equipment: row.equipment
      ? {
          id: row.equipment.id,
          code: row.equipment.code,
          name: row.equipment.name,
          displayNumber: row.equipment.displayNumber,
        }
      : null,
    operation: row.operation
      ? { id: row.operation.id, name: row.operation.name }
      : null,
    currentPassports: passports,
  };
}
