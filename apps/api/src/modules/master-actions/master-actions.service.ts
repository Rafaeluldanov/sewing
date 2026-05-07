import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  PassportStatus,
  type Prisma,
} from '@prisma/client';
import {
  parseEmployeeQr,
  type MasterActionPassportSnapshotDto,
  type MasterActionResultDto,
  type ReturnPassportToCellDto,
  type SetRouteStepDto,
  type TransferPassportDto,
  type UnassignPassportDto,
} from '@sewing/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OrderCutIssueRulesService } from '../order-cut-issue-rules/order-cut-issue-rules.service.js';
import {
  CellInactiveException,
  CellNotFoundException,
  MasterBackwardRouteRequiresCellException,
  MasterOrderHasNoRouteSnapshotException,
  MasterRouteStepNotInSnapshotException,
  MasterTargetEmployeeInactiveException,
  MasterTargetEmployeeNotFoundException,
  PassportTerminalForMasterException,
} from '../../common/errors.js';
import type { AuthPrincipal } from '../auth/auth.types.js';

/**
 * Stage 2 «Мастер цеха» — ручные действия мастера над паспортами.
 *
 * Контракт (см. `docs/domain.md §«Действия мастера»`,
 * `docs/flows.md §«F-Master actions»`,
 * `apps/api/src/modules/master-actions/master-actions.controller.ts`):
 *
 *   - `unassign(passportId, actor, dto)` — снять паспорт с сотрудника.
 *   - `transferToEmployee(...)`         — передать паспорт другому сотруднику.
 *   - `returnToCell(...)`               — вернуть паспорт в активную ячейку.
 *   - `setRouteStep(...)`               — назначить шаг маршрута.
 *
 * Для всех действий обязательны:
 *   - `reason` (Zod-валидация в DTO; без неё backend отдаёт 400);
 *   - идущий внутри `prisma.$transaction(...)` audit-лог с before/after
 *     снэпшотом (`MASTER_PASSPORT_*` события, `entityType = 'PASSPORT'`);
 *   - запрет на терминальные паспорта (`PACKED` / `CANCELLED`) — это
 *     общий safety-инвариант ТЗ §5 «SAFETY RULES».
 *
 * Сервис сознательно ничего не делает с `currentSizes` smartсcreen-
 * подсветкой и не двигает счётчики начислений — Stage 2 правит
 * только владельца / ячейку / шаг маршрута паспорта.
 */
@Injectable()
export class MasterActionsService {
  private readonly logger = new Logger(MasterActionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly orderCutIssueRules: OrderCutIssueRulesService,
  ) {}

  // -------------------------------------------------------------------------
  // 1. UNASSIGN — снять с сотрудника
  // -------------------------------------------------------------------------

  /**
   * Снять паспорт с сотрудника (`currentEmployeeId = null`).
   *
   * Ничего больше не трогаем: `currentOperationId` /
   * `currentRouteStepIndex` сохраняются — это точечная коррекция
   * владельца, не движение по маршруту. Статус остаётся `IN_PROGRESS`,
   * чтобы `current-work` следующего сотрудника не сломался.
   */
  async unassign(
    actor: AuthPrincipal,
    passportId: string,
    dto: UnassignPassportDto,
  ): Promise<MasterActionResultDto> {
    const passport = await this.loadPassportOrThrow(passportId);
    this.assertNotTerminal(passport);

    const before = this.snapshot(passport);

    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.passport.update({
        where: { id: passport.id },
        data: { currentEmployeeId: null },
        include: passportInclude,
      });
      await this.audit.log(
        {
          event: 'MASTER_PASSPORT_UNASSIGNED',
          entityType: 'PASSPORT',
          entityId: passport.id,
          employeeId: actor.employeeId,
          payload: this.auditPayload({
            reason: dto.reason,
            comment: dto.comment,
            before,
            after: this.snapshot(next),
          }),
        },
        tx,
      );
      return next;
    });

    this.logger.log(
      `event=master.unassign passportId=${passportId} actor=${actor.employeeId} reason=${dto.reason}`,
    );
    return {
      passport: this.snapshot(updated),
      before: this.beforeSnapshot(before),
    };
  }

  // -------------------------------------------------------------------------
  // 2. TRANSFER — передать паспорт другому сотруднику
  // -------------------------------------------------------------------------

  /**
   * Переназначить паспорт другому сотруднику.
   *
   * Если у target есть активная смена и её `operationId` входит в
   * snapshot маршрута заказа — двигаем `currentRouteStepIndex` /
   * `currentOperationId` (route-WIP логика, та же, что в
   * `passports.scanOnOperation`). В противном случае меняем только
   * владельца и обнуляем `currentCellId` (паспорт уходит «на руки»).
   *
   * `currentCellId` всегда обнуляем: паспорт переходит к человеку,
   * физически в ячейке его уже нет — это инвариант issue-flow.
   */
  async transferToEmployee(
    actor: AuthPrincipal,
    passportId: string,
    dto: TransferPassportDto,
  ): Promise<MasterActionResultDto> {
    const passport = await this.loadPassportOrThrow(passportId);
    this.assertNotTerminal(passport);

    const targetEmployeeId = await this.resolveEmployeeId(dto);
    const targetEmployee = await this.prisma.employee.findUnique({
      where: { id: targetEmployeeId },
      select: { id: true, fullName: true, active: true },
    });
    if (!targetEmployee) {
      throw new MasterTargetEmployeeNotFoundException();
    }
    if (!targetEmployee.active) {
      throw new MasterTargetEmployeeInactiveException();
    }

    // Ищем активную смену цели и сверяем её операцию с snapshot маршрута.
    // Soft-route MVP: переключаем шаг только при совпадении, иначе
    // оставляем `currentOperationId` без изменений (как в issue-flow
    // `passports.service.ts §F3a`).
    const targetShift = await this.prisma.shiftSession.findFirst({
      where: { employeeId: targetEmployeeId, endedAt: null },
      select: { operationId: true },
    });
    let nextOperationId: string | null = passport.currentOperationId ?? null;
    let nextRouteStepIndex: number | null =
      passport.currentRouteStepIndex ?? null;
    if (targetShift) {
      const matched = await this.prisma.orderRouteStep.findFirst({
        where: {
          orderId: passport.orderId,
          operationId: targetShift.operationId,
        },
        select: { index: true, operationId: true },
      });
      if (matched) {
        nextOperationId = matched.operationId;
        nextRouteStepIndex = matched.index;
      }
    }

    const before = this.snapshot(passport);

    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.passport.update({
        where: { id: passport.id },
        data: {
          currentEmployeeId: targetEmployeeId,
          currentCellId: null,
          status: PassportStatus.IN_PROGRESS,
          currentOperationId: nextOperationId,
          currentRouteStepIndex: nextRouteStepIndex,
        },
        include: passportInclude,
      });
      await this.audit.log(
        {
          event: 'MASTER_PASSPORT_TRANSFERRED',
          entityType: 'PASSPORT',
          entityId: passport.id,
          employeeId: actor.employeeId,
          payload: this.auditPayload({
            reason: dto.reason,
            comment: dto.comment,
            before,
            after: this.snapshot(next),
            targetEmployeeId,
          }),
        },
        tx,
      );
      return next;
    });

    this.logger.log(
      `event=master.transfer passportId=${passportId} actor=${actor.employeeId} targetEmployeeId=${targetEmployeeId} reason=${dto.reason}`,
    );
    return {
      passport: this.snapshot(updated),
      before: this.beforeSnapshot(before),
    };
  }

  // -------------------------------------------------------------------------
  // 3. RETURN TO CELL — вернуть паспорт в активную ячейку
  // -------------------------------------------------------------------------

  /**
   * Вернуть паспорт в активную ячейку.
   *
   * Это «обратное» действие к issue-flow: `currentCellId = cell.id`,
   * `currentEmployeeId = null`, `CellContent[size] += qtyCut`. Статус
   * сохраняем `IN_PROGRESS` (см. `docs/domain.md §«Действия мастера»`):
   * формальный backstep до `CREATED` ломает аналитику и противоречит
   * физической реальности — паспорт уже был в работе.
   *
   * Идемпотентность: если паспорт уже лежит в этой же ячейке, ничего
   * не делаем (только пишем audit с пометкой `noop = true`), чтобы
   * двойной тап мастера не задвоил `CellContent`.
   */
  async returnToCell(
    actor: AuthPrincipal,
    passportId: string,
    dto: ReturnPassportToCellDto,
  ): Promise<MasterActionResultDto> {
    const passport = await this.loadPassportOrThrow(passportId);
    this.assertNotTerminal(passport);

    const cell = await this.resolveCell(dto);
    if (!cell.active) throw new CellInactiveException();

    const before = this.snapshot(passport);
    const alreadyInThisCell = passport.currentCellId === cell.id;

    const updated = await this.prisma.$transaction(async (tx) => {
      if (!alreadyInThisCell) {
        const existing = await tx.cellContent.findUnique({
          where: {
            cellId_sizeId: { cellId: cell.id, sizeId: passport.sizeId },
          },
        });
        if (existing) {
          await tx.cellContent.update({
            where: { id: existing.id },
            data: { quantity: existing.quantity + passport.qtyCut },
          });
        } else {
          await tx.cellContent.create({
            data: {
              cellId: cell.id,
              sizeId: passport.sizeId,
              quantity: passport.qtyCut,
            },
          });
        }
      }

      const next = await tx.passport.update({
        where: { id: passport.id },
        data: {
          currentCellId: cell.id,
          currentEmployeeId: null,
          // Статус оставляем как есть для CREATED-паспортов (например,
          // мастер пересортировал ячейку до выдачи). Для IN_PROGRESS
          // — тоже сохраняем, см. doc-comment выше.
        },
        include: passportInclude,
      });
      // Откат счётчика очереди выдачи кроя: возврат в ячейку
      // эквивалентен «un-issue» — `OrderCutIssueRule.issuedQty`
      // декрементится на ту же величину, на которую был
      // инкрементирован при выдаче. Идемпотентно (см. releaseInTx).
      await this.orderCutIssueRules.releaseInTx(tx, {
        passportId: passport.id,
        orderId: passport.orderId,
        sizeId: passport.sizeId,
        employeeId: actor.employeeId,
      });
      await this.audit.log(
        {
          event: 'MASTER_PASSPORT_RETURNED_TO_CELL',
          entityType: 'PASSPORT',
          entityId: passport.id,
          employeeId: actor.employeeId,
          payload: this.auditPayload({
            reason: dto.reason,
            comment: dto.comment,
            before,
            after: this.snapshot(next),
            cellId: cell.id,
            cellCode: cell.code,
            qtyReturned: alreadyInThisCell ? 0 : passport.qtyCut,
            noop: alreadyInThisCell || undefined,
          }),
        },
        tx,
      );
      return next;
    });

    this.logger.log(
      `event=master.returnToCell passportId=${passportId} actor=${actor.employeeId} cellId=${cell.id} reason=${dto.reason}${alreadyInThisCell ? ' noop=true' : ''}`,
    );
    return {
      passport: this.snapshot(updated),
      before: this.beforeSnapshot(before),
    };
  }

  // -------------------------------------------------------------------------
  // 4. SET ROUTE STEP — назначить шаг маршрута
  // -------------------------------------------------------------------------

  /**
   * Назначить паспорт на конкретный шаг snapshot маршрута заказа.
   *
   * Адресация: `routeStepIndex` (предпочтительно — UI рендерит список
   * snapshot'а) или `operationId` (fallback). Если обе указаны и
   * расходятся — приоритет у `routeStepIndex`.
   *
   * **Forward-движение** (target.index ≥ currentRouteStepIndex):
   * `currentEmployeeId = null`, `currentCellId = null` — паспорт уходит
   * «в воздух» и следующий сотрудник перехватит его штатным `scan` /
   * `issue`.
   *
   * **Backward-движение** (target.index < currentRouteStepIndex): по
   * инварианту «нет тихого rollback» (см. `docs/flows.md
   * §«F-Master rollback»`) обязательно требуется placement в ячейку
   * (`cellQr` / `cellId`), иначе backend отвечает 400
   * `MASTER_BACKWARD_ROUTE_REQUIRES_CELL`. Паспорт оказывается в
   * указанной ячейке, `CellContent[size] += qtyCut`. Audit-payload
   * содержит `direction: 'BACKWARD'`, `requiredCellPlacement: true`
   * и `cellId` — этого достаточно, чтобы любая ретроспектива видела
   * «кто, когда, откуда, куда, и куда положил».
   */
  async setRouteStep(
    actor: AuthPrincipal,
    passportId: string,
    dto: SetRouteStepDto,
  ): Promise<MasterActionResultDto> {
    const passport = await this.loadPassportOrThrow(passportId);
    this.assertNotTerminal(passport);

    const steps = await this.prisma.orderRouteStep.findMany({
      where: { orderId: passport.orderId },
      orderBy: { index: 'asc' },
      select: {
        index: true,
        operationId: true,
        operation: { select: { id: true, name: true } },
      },
    });
    if (steps.length === 0) {
      throw new MasterOrderHasNoRouteSnapshotException();
    }

    let target: (typeof steps)[number] | undefined;
    if (dto.routeStepIndex !== undefined) {
      target = steps.find((s) => s.index === dto.routeStepIndex);
    } else if (dto.operationId) {
      target = steps.find((s) => s.operationId === dto.operationId);
    }
    if (!target) throw new MasterRouteStepNotInSnapshotException();

    // Определяем направление движения. Если у паспорта ещё нет
    // currentRouteStepIndex (новый паспорт без скан-истории), считаем
    // движение forward — откатывать назад нечего.
    const currentIdx = passport.currentRouteStepIndex ?? 0;
    const isBackward = target.index < currentIdx;

    // Backward без placement → 400. Эта проверка идёт до открытия
    // транзакции, чтобы не плодить пустые audit-логи.
    let cell: { id: string; code: string; active: boolean } | null = null;
    if (isBackward) {
      const hasCellHint =
        Boolean(dto.cellId && dto.cellId.length > 0) ||
        Boolean(dto.cellQr && dto.cellQr.length > 0);
      if (!hasCellHint) {
        throw new MasterBackwardRouteRequiresCellException();
      }
      cell = await this.resolveCell({ cellQr: dto.cellQr, cellId: dto.cellId });
      if (!cell.active) throw new CellInactiveException();
    }

    const before = this.snapshot(passport);
    const alreadyInThisCell =
      cell !== null && passport.currentCellId === cell.id;

    const updated = await this.prisma.$transaction(async (tx) => {
      // Backward + cell → размещаем паспорт в ячейку (см.
      // `MasterActionsService.returnToCell`, та же логика, только
      // встроенная в один master-action).
      if (cell && !alreadyInThisCell) {
        const existing = await tx.cellContent.findUnique({
          where: {
            cellId_sizeId: { cellId: cell.id, sizeId: passport.sizeId },
          },
        });
        if (existing) {
          await tx.cellContent.update({
            where: { id: existing.id },
            data: { quantity: existing.quantity + passport.qtyCut },
          });
        } else {
          await tx.cellContent.create({
            data: {
              cellId: cell.id,
              sizeId: passport.sizeId,
              quantity: passport.qtyCut,
            },
          });
        }
      }

      const next = await tx.passport.update({
        where: { id: passport.id },
        data: {
          currentOperationId: target!.operationId,
          currentRouteStepIndex: target!.index,
          currentEmployeeId: null,
          currentCellId: cell ? cell.id : null,
          status: PassportStatus.IN_PROGRESS,
        },
        include: passportInclude,
      });
      await this.audit.log(
        {
          event: 'MASTER_PASSPORT_ROUTE_STEP_SET',
          entityType: 'PASSPORT',
          entityId: passport.id,
          employeeId: actor.employeeId,
          payload: this.auditPayload({
            reason: dto.reason,
            comment: dto.comment,
            before,
            after: this.snapshot(next),
            operationId: target!.operationId,
            routeStepIndex: target!.index,
            direction: isBackward ? 'BACKWARD' : 'FORWARD',
            requiredCellPlacement: isBackward,
            cellId: cell?.id,
            cellCode: cell?.code,
          }),
        },
        tx,
      );
      return next;
    });

    this.logger.log(
      `event=master.setRouteStep passportId=${passportId} actor=${actor.employeeId} routeStepIndex=${target!.index} operationId=${target!.operationId} direction=${isBackward ? 'BACKWARD' : 'FORWARD'}${cell ? ` cellId=${cell.id}` : ''} reason=${dto.reason}`,
    );
    return {
      passport: this.snapshot(updated),
      before: this.beforeSnapshot(before),
    };
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  private async loadPassportOrThrow(passportId: string): Promise<PassportRow> {
    const row = await this.prisma.passport.findUnique({
      where: { id: passportId },
      include: passportInclude,
    });
    if (!row) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'PASSPORT_NOT_FOUND',
        message: 'Паспорт не найден',
      });
    }
    return row;
  }

  private assertNotTerminal(p: PassportRow): void {
    if (p.status === PassportStatus.PACKED) {
      throw new PassportTerminalForMasterException('PACKED');
    }
    if (p.status === PassportStatus.CANCELLED) {
      throw new PassportTerminalForMasterException('CANCELLED');
    }
  }

  private async resolveEmployeeId(dto: TransferPassportDto): Promise<string> {
    if (dto.employeeId) return dto.employeeId;
    const fromQr = parseEmployeeQr(dto.employeeQr ?? '');
    if (!fromQr) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'INVALID_EMPLOYEE_QR',
        message: 'Некорректный QR сотрудника (ожидается EMPLOYEE:<id>).',
      });
    }
    return fromQr;
  }

  private async resolveCell(
    dto: { cellQr?: string; cellId?: string },
  ): Promise<{ id: string; code: string; active: boolean }> {
    if (dto.cellId) {
      const c = await this.prisma.cell.findUnique({
        where: { id: dto.cellId },
        select: { id: true, code: true, active: true },
      });
      if (!c) throw new CellNotFoundException();
      return c;
    }
    const raw = (dto.cellQr ?? '').trim();
    if (raw.length === 0) throw new CellNotFoundException();
    const idFromQr = raw.startsWith('cell:') ? raw.slice('cell:'.length) : raw;
    const c = await this.prisma.cell.findFirst({
      where: { OR: [{ id: idFromQr }, { qrCode: raw }, { code: raw }] },
      select: { id: true, code: true, active: true },
    });
    if (!c) throw new CellNotFoundException();
    return c;
  }

  private snapshot(row: PassportRow): MasterActionPassportSnapshotDto {
    return {
      id: row.id,
      number: row.order.number,
      size: row.size.code,
      color: row.color ?? null,
      qtyCut: row.qtyCut,
      status: row.status,
      currentEmployeeId: row.currentEmployeeId,
      currentEmployeeName: row.currentEmployee?.fullName ?? null,
      currentOperation: row.currentOperation
        ? { id: row.currentOperation.id, name: row.currentOperation.name }
        : null,
      currentCell: row.currentCell
        ? { id: row.currentCell.id, code: row.currentCell.code }
        : null,
      currentRouteStepIndex: row.currentRouteStepIndex,
    };
  }

  private beforeSnapshot(
    s: MasterActionPassportSnapshotDto,
  ): MasterActionResultDto['before'] {
    return {
      currentEmployeeId: s.currentEmployeeId,
      currentEmployeeName: s.currentEmployeeName,
      currentOperation: s.currentOperation,
      currentCell: s.currentCell,
      currentRouteStepIndex: s.currentRouteStepIndex,
      status: s.status,
    };
  }

  private auditPayload(input: {
    reason: string;
    comment?: string;
    before: MasterActionPassportSnapshotDto;
    after: MasterActionPassportSnapshotDto;
    targetEmployeeId?: string;
    cellId?: string;
    cellCode?: string;
    operationId?: string;
    routeStepIndex?: number;
    qtyReturned?: number;
    noop?: boolean;
    direction?: 'FORWARD' | 'BACKWARD';
    requiredCellPlacement?: boolean;
  }): Prisma.InputJsonValue {
    const compact = (s: MasterActionPassportSnapshotDto) => ({
      currentEmployeeId: s.currentEmployeeId,
      currentCellId: s.currentCell ? s.currentCell.id : null,
      currentOperationId: s.currentOperation ? s.currentOperation.id : null,
      currentRouteStepIndex: s.currentRouteStepIndex,
      status: s.status,
    });
    const payload: Record<string, unknown> = {
      reason: input.reason,
      before: compact(input.before),
      after: compact(input.after),
    };
    if (input.comment) payload.comment = input.comment;
    if (input.targetEmployeeId) payload.targetEmployeeId = input.targetEmployeeId;
    if (input.cellId) payload.cellId = input.cellId;
    if (input.cellCode) payload.cellCode = input.cellCode;
    if (input.operationId) payload.operationId = input.operationId;
    if (input.routeStepIndex !== undefined) {
      payload.routeStepIndex = input.routeStepIndex;
    }
    if (input.qtyReturned !== undefined) payload.qtyReturned = input.qtyReturned;
    if (input.noop) payload.noop = true;
    if (input.direction) payload.direction = input.direction;
    if (input.requiredCellPlacement) payload.requiredCellPlacement = true;
    return payload as Prisma.InputJsonValue;
  }
}

// ---------------------------------------------------------------------------
// helpers (private to module)
// ---------------------------------------------------------------------------

const passportInclude = {
  size: { select: { code: true } },
  order: { select: { number: true } },
  currentEmployee: { select: { id: true, fullName: true } },
  currentOperation: { select: { id: true, name: true } },
  currentCell: { select: { id: true, code: true } },
} as const;

type PassportRow = Prisma.PassportGetPayload<{
  include: typeof passportInclude;
}>;
