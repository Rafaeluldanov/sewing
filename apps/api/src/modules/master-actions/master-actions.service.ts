import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  PassportEventType,
  PassportStatus,
  type Prisma,
} from '@prisma/client';
import {
  parseEmployeeQr,
  type FindMasterPassportByCodeResultDto,
  type MasterActionPassportSnapshotDto,
  type MasterActionResultDto,
  type MasterCallPassportDto,
  type ReturnPassportToCellDto,
  type SetRouteStepDto,
  type TransferPassportDto,
  type UnassignPassportDto,
} from '@sewing/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OrderCutIssueRulesService } from '../order-cut-issue-rules/order-cut-issue-rules.service.js';
import { WorkInProgressService } from '../work-in-progress/work-in-progress.service.js';
import {
  CellInactiveException,
  CellNotFoundException,
  MasterBackwardRouteRequiresPlacementException,
  MasterOrderHasNoRouteSnapshotException,
  MasterRouteStepNotInSnapshotException,
  MasterTargetEmployeeInactiveException,
  MasterTargetEmployeeNotFoundException,
  MasterTargetOperationAlreadyFinishedException,
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
    private readonly workInProgress: WorkInProgressService,
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
      const audit = await this.audit.log(
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
      // Foundation полуфабриката: RETURN-движение по крою. Только
      // если это не noop (паспорт реально переехал в новую ячейку).
      // Идемпотентно по `WIP_RETURN:<auditId>`. См.
      // `WorkInProgressService.recordReturnInTx`.
      if (!alreadyInThisCell && audit) {
        await this.workInProgress.recordReturnInTx(tx, {
          passport: {
            id: passport.id,
            orderId: passport.orderId,
            productId: passport.productId,
            sizeId: passport.sizeId,
            color: passport.color,
            qtyCut: passport.qtyCut,
          },
          cell: { id: cell.id, warehouseId: cell.warehouseId },
          auditId: audit.id,
          employeeId: actor.employeeId,
        });
      }
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
   * `issue`. Поля placement'а (`cellQr` / `employeeQr`) для forward
   * игнорируются — на forward по дизайну никого не «привязываем».
   *
   * **Backward-движение** (target.index < currentRouteStepIndex): по
   * инварианту «нет тихого rollback» (см. `docs/flows.md
   * §«F-Master rollback»`) паспорт обязан попасть в идентифицируемое
   * место. Допускается ОДИН из двух placement'ов:
   *
   *   - **ячейка** (`cellQr` / `cellId`) — паспорт ложится в ячейку,
   *     `CellContent[size] += qtyCut`, `currentEmployeeId = null`.
   *     Audit `placement: 'CELL'`, `cellId`/`cellCode`;
   *   - **сотрудник** (`employeeQr` / `employeeId`) — паспорт уходит
   *     «из рук в руки» (например, ВТО заметил брак и тут же отдал
   *     ОТК): `currentEmployeeId = employee.id`, `currentCellId = null`,
   *     WIP-движений нет (физически паспорт у человека, не в ячейке).
   *     Audit `placement: 'EMPLOYEE'`, `targetEmployeeId`.
   *
   * Без любого из placement'ов — 400 `MASTER_BACKWARD_ROUTE_REQUIRES_PLACEMENT`,
   * чтобы паспорт не «зависал в воздухе» (no employee, no cell). Указать
   * оба placement'а одновременно нельзя — Zod ловит на уровне DTO.
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

    // По целевой операции уже есть `OPERATION_FINISHED` → запрещаем
    // вернуть на неё паспорт. По бизнес-инварианту операция считается
    // закрытой безвозвратно для всех ролей, включая мастера.
    // Исключение — переделка по браку: ОТК через `QcService.returnToRework`
    // пишет `OPERATION_REWORK_OPENED`, и инвариант ослабляется до
    // «нет `OPERATION_FINISHED` после последнего rework для пары
    // (passport, operation)». Мастер, идущий после rework, тоже
    // должен пройти эту проверку: текущий проход операции открыт.
    const lastRework = await this.prisma.passportEvent.findFirst({
      where: {
        passportId: passport.id,
        operationId: target.operationId,
        type: PassportEventType.OPERATION_REWORK_OPENED,
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    const finishedOnTarget = await this.prisma.passportEvent.findFirst({
      where: {
        passportId: passport.id,
        operationId: target.operationId,
        type: PassportEventType.OPERATION_FINISHED,
        ...(lastRework ? { createdAt: { gt: lastRework.createdAt } } : {}),
      },
      select: { id: true },
    });
    if (finishedOnTarget) {
      throw new MasterTargetOperationAlreadyFinishedException();
    }

    // Определяем направление движения. Если у паспорта ещё нет
    // currentRouteStepIndex (новый паспорт без скан-истории), считаем
    // движение forward — откатывать назад нечего.
    const currentIdx = passport.currentRouteStepIndex ?? 0;
    const isBackward = target.index < currentIdx;

    // Backward требует placement: либо ячейка, либо сотрудник. Проверка
    // идёт до открытия транзакции, чтобы не плодить пустые audit-логи.
    // Zod уже отсёк «оба сразу», тут страхуемся ещё раз (и для типов).
    const hasCellHint =
      Boolean(dto.cellId && dto.cellId.length > 0) ||
      Boolean(dto.cellQr && dto.cellQr.length > 0);
    const hasEmployeeHint =
      Boolean(dto.employeeId && dto.employeeId.length > 0) ||
      Boolean(dto.employeeQr && dto.employeeQr.length > 0);

    let cell: {
      id: string;
      code: string;
      active: boolean;
      warehouseId: string | null;
    } | null = null;
    let targetEmployee: { id: string; fullName: string } | null = null;

    if (isBackward) {
      if (!hasCellHint && !hasEmployeeHint) {
        throw new MasterBackwardRouteRequiresPlacementException();
      }
      if (hasEmployeeHint) {
        // «Из рук в руки»: паспорт сразу садится на этого сотрудника
        // на target-шаге. WIP не трогаем — физически он у человека.
        const employeeId = await this.resolveEmployeeId({
          employeeId: dto.employeeId,
          employeeQr: dto.employeeQr,
        });
        const row = await this.prisma.employee.findUnique({
          where: { id: employeeId },
          select: { id: true, fullName: true, active: true },
        });
        if (!row) throw new MasterTargetEmployeeNotFoundException();
        if (!row.active) throw new MasterTargetEmployeeInactiveException();
        targetEmployee = { id: row.id, fullName: row.fullName };
      } else {
        cell = await this.resolveCell({
          cellQr: dto.cellQr,
          cellId: dto.cellId,
        });
        if (!cell.active) throw new CellInactiveException();
      }
    }

    const before = this.snapshot(passport);
    const alreadyInThisCell =
      cell !== null && passport.currentCellId === cell.id;
    const placement: 'CELL' | 'EMPLOYEE' | null = cell
      ? 'CELL'
      : targetEmployee
        ? 'EMPLOYEE'
        : null;

    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.passport.update({
        where: { id: passport.id },
        data: {
          currentOperationId: target!.operationId,
          currentRouteStepIndex: target!.index,
          currentEmployeeId: targetEmployee ? targetEmployee.id : null,
          currentCellId: cell ? cell.id : null,
          status: PassportStatus.IN_PROGRESS,
        },
        include: passportInclude,
      });
      const audit = await this.audit.log(
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
            // requiredCellPlacement сохраняем для обратной совместимости
            // (старые ретроспективы фильтруют по нему). Новое поле
            // placement выражает выбор точнее: 'CELL' | 'EMPLOYEE' | null.
            requiredCellPlacement: isBackward && placement === 'CELL',
            placement,
            cellId: cell?.id,
            cellCode: cell?.code,
            targetEmployeeId: targetEmployee?.id,
          }),
        },
        tx,
      );
      // Foundation полуфабриката: backward + cell = тот же return-in-cell
      // паттерн, что и в `returnToCell`. Для forward / backward+employee
      // WIP не трогаем — паспорт не оседает в ячейке.
      if (cell && !alreadyInThisCell && audit) {
        await this.workInProgress.recordReturnInTx(tx, {
          passport: {
            id: passport.id,
            orderId: passport.orderId,
            productId: passport.productId,
            sizeId: passport.sizeId,
            color: passport.color,
            qtyCut: passport.qtyCut,
          },
          cell: { id: cell.id, warehouseId: cell.warehouseId },
          auditId: audit.id,
          employeeId: actor.employeeId,
        });
      }
      return next;
    });

    this.logger.log(
      `event=master.setRouteStep passportId=${passportId} actor=${actor.employeeId} routeStepIndex=${target!.index} operationId=${target!.operationId} direction=${isBackward ? 'BACKWARD' : 'FORWARD'}${cell ? ` cellId=${cell.id}` : ''}${targetEmployee ? ` targetEmployeeId=${targetEmployee.id}` : ''} reason=${dto.reason}`,
    );
    return {
      passport: this.snapshot(updated),
      before: this.beforeSnapshot(before),
    };
  }

  // -------------------------------------------------------------------------
  // 5. FIND BY CODE — поиск паспорта для кнопки «Сканировать паспорт»
  // -------------------------------------------------------------------------

  /**
   * Найти паспорт по произвольному коду (`passport:<id>`, `P-…`, голый
   * id) и вернуть его в shape, совместимом с
   * `PassportActionsSheet` (`MasterCallPassportDto` + `ownerFullName`).
   *
   * Read-only — никаких записей в БД, audit не пишем (это просто
   * lookup перед открытием bottom-sheet'а; сами действия пишут audit
   * сами). Терминальные паспорта (`PACKED`/`CANCELLED`) тоже отдаём —
   * пусть UI покажет их статус, а попытка действия отвалится с
   * понятным `PASSPORT_TERMINAL_FOR_MASTER` уже в action-эндпоинте.
   */
  async findPassportByCode(
    code: string,
  ): Promise<FindMasterPassportByCodeResultDto> {
    const trimmed = code.trim();
    const idFromQr = trimmed.startsWith('passport:')
      ? trimmed.slice('passport:'.length)
      : trimmed;

    const row = await this.prisma.passport.findFirst({
      where: {
        OR: [{ id: idFromQr }, { qrCode: trimmed }, { number: trimmed }],
      },
      select: {
        id: true,
        color: true,
        qtyCut: true,
        status: true,
        orderId: true,
        currentRouteStepIndex: true,
        size: { select: { code: true } },
        order: { select: { number: true } },
        currentEmployee: { select: { fullName: true } },
        currentOperation: { select: { id: true, name: true } },
        currentCell: { select: { id: true, code: true } },
      },
    });
    if (!row) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'PASSPORT_NOT_FOUND',
        message: `Паспорт не найден по коду «${trimmed}»`,
      });
    }

    const stepRows = await this.prisma.orderRouteStep.findMany({
      where: { orderId: row.orderId },
      orderBy: { index: 'asc' },
      select: {
        index: true,
        operation: { select: { id: true, name: true } },
      },
    });

    const passport: MasterCallPassportDto = {
      id: row.id,
      number: row.order.number,
      size: row.size.code,
      color: row.color ?? null,
      qtyCut: row.qtyCut,
      status: row.status,
      orderNumber: row.order.number,
      currentOperation: row.currentOperation
        ? { id: row.currentOperation.id, name: row.currentOperation.name }
        : null,
      currentCell: row.currentCell
        ? { id: row.currentCell.id, code: row.currentCell.code }
        : null,
      currentRouteStepIndex: row.currentRouteStepIndex,
      routeSteps: stepRows.map((s) => ({
        index: s.index,
        operationId: s.operation.id,
        operationName: s.operation.name,
        isCurrent: s.index === row.currentRouteStepIndex,
      })),
    };

    return {
      passport,
      ownerFullName: row.currentEmployee?.fullName ?? null,
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

  private async resolveEmployeeId(dto: {
    employeeId?: string;
    employeeQr?: string;
  }): Promise<string> {
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
  ): Promise<{
    id: string;
    code: string;
    active: boolean;
    warehouseId: string | null;
  }> {
    if (dto.cellId) {
      const c = await this.prisma.cell.findUnique({
        where: { id: dto.cellId },
        select: { id: true, code: true, active: true, warehouseId: true },
      });
      if (!c) throw new CellNotFoundException();
      return c;
    }
    const raw = (dto.cellQr ?? '').trim();
    if (raw.length === 0) throw new CellNotFoundException();
    const idFromQr = raw.startsWith('cell:') ? raw.slice('cell:'.length) : raw;
    const c = await this.prisma.cell.findFirst({
      where: { OR: [{ id: idFromQr }, { qrCode: raw }, { code: raw }] },
      select: { id: true, code: true, active: true, warehouseId: true },
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
    placement?: 'CELL' | 'EMPLOYEE' | null;
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
    if (input.placement) payload.placement = input.placement;
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
