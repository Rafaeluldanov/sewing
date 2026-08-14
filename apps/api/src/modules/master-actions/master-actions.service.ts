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
  parseAnyEmployeeQr,
  type FindMasterPassportByCodeResultDto,
  type MasterActionPassportSnapshotDto,
  type MasterActionResultDto,
  type MasterCallPassportDto,
  type ReturnPassportToCellDto,
  type SetRouteStepDto,
  type TransferPassportDto,
  type UnassignPassportDto,
  type CreateRouteWorkPermitDto,
  type RevokeRouteWorkPermitDto,
  type RouteWorkPermitDto,
  type MasterSelfOperationDto,
  type MasterSelfOperationEquipmentDto,
  type MasterSelfOperationStepDto,
  type MasterSelfOperationStepsDto,
  type MasterTransferCandidateDto,
  type MasterTransferCandidatesDto,
  type ResolvedEmployeeQrDto,
} from '@sewing/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OrderCutIssueRulesService } from '../order-cut-issue-rules/order-cut-issue-rules.service.js';
import { WorkInProgressService } from '../work-in-progress/work-in-progress.service.js';
import { PassportsService } from '../passports/passports.service.js';
import { MeService } from '../me/me.service.js';
import { isPieceworkEligible } from '../employees/compensation.js';
import {
  closeShiftSegments,
  openShiftSegment,
} from '../shifts/shift-segments.js';
import {
  CellInactiveException,
  CellNotFoundException,
  EmployeeQrTokenInvalidException,
  MasterBackwardRouteRequiresPlacementException,
  MasterOrderHasNoRouteSnapshotException,
  MasterRouteStepNotInSnapshotException,
  MasterSelfOperationEquipmentNotAllowedException,
  MasterSelfOperationEquipmentRequiredException,
  MasterSelfOperationNoEquipmentException,
  MasterSelfOperationReworkFirstException,
  MasterSelfOperationShiftBusyException,
  MasterTargetEmployeeInactiveException,
  MasterTargetEmployeeNotFoundException,
  MasterTargetOperationAlreadyFinishedException,
  RouteWorkPermitNotFoundException,
  RouteWorkPermitOperationAlreadyInRouteException,
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
    // «Выполнить операцию самой» переиспользует канал швеи
    // (`issueToEmployee` + `completeOperationByEmployee`) — своей копии
    // правил маршрута у мастера нет и быть не должно.
    private readonly passports: PassportsService,
    // `MeService` — ради `verifyEmployeeQrToken`: «Мой QR-код»
    // сотрудника подписан `JWT_SECRET`, и читать секрет вторым местом
    // нельзя, разъедется с местом подписи.
    private readonly me: MeService,
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
    // Смена получателя стоит на операции ВНЕ маршрута заказа. Поведение
    // остаётся прежним (передаём владельца, шаг не двигаем) — блокировать
    // здесь нельзя: передать паспорт швее, у которой сейчас открыта смена
    // на другой операции, законно. Но раньше этот случай не оставлял ВООБЩЕ
    // никакого следа — ни ошибки, ни события, ни записи в журнале, — и
    // мастер узнавал о расхождении только когда партия вставала на гейте
    // перед ОТК. Поэтому фиксируем факт в аудите и в логе: см. проверку
    // `ORDER_WORK_OUTSIDE_ROUTE` в `DiagnosticsService` и вкладку
    // «Расхождения» у мастера.
    let offRouteShiftOperationId: string | null = null;
    if (targetShift) {
      // Операция может стоять в маршруте несколько раз (чередующиеся
      // ОТК/ВТО). Берём вхождение, ближайшее ВПЕРЁД от текущей позиции
      // паспорта, — то, к которому он реально идёт; если таких нет
      // (все проходы позади) — последнее. Иначе передача паспорта
      // молча откатывала бы его на первый по счёту шаг.
      const occurrences = await this.prisma.orderRouteStep.findMany({
        where: {
          orderId: passport.orderId,
          operationId: targetShift.operationId,
        },
        orderBy: { index: 'asc' },
        select: { index: true, operationId: true },
      });
      const fromIdx = passport.currentRouteStepIndex ?? -1;
      const matched =
        occurrences.find((s) => s.index >= fromIdx) ??
        occurrences[occurrences.length - 1];
      if (matched) {
        nextOperationId = matched.operationId;
        nextRouteStepIndex = matched.index;
      } else {
        offRouteShiftOperationId = targetShift.operationId;
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
            offRouteShiftOperationId,
          }),
        },
        tx,
      );
      return next;
    });

    this.logger.log(
      `event=master.transfer passportId=${passportId} actor=${actor.employeeId} targetEmployeeId=${targetEmployeeId} reason=${dto.reason}` +
        (offRouteShiftOperationId
          ? ` offRouteShiftOperationId=${offRouteShiftOperationId}`
          : ''),
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
   *
   * **Backward на уже завершённую target-операцию.** Типичный кейс: ОТК
   * выпустил паспорт, ВТО нашёл брак, мастер возвращает на ОТК для
   * повторной проверки. По умолчанию `OPERATION_FINISHED` на target
   * закрывает её безвозвратно (`MASTER_TARGET_OPERATION_ALREADY_FINISHED`),
   * но на backward мастер ИМЕЕТ право переоткрыть гейт: в той же
   * транзакции пишется `OPERATION_REWORK_OPENED` на target-операцию с
   * `employeeId = последний финишёр` (как в `QcService.returnToRework`).
   * Это снимает блок `assertOperationNotFinished` для следующего прохода
   * и подсвечивает в audit `reopenedFinishedTarget: true` +
   * `previousFinisherEmployeeId`. Сам мастер pending earnings НЕ отзывает
   * — если повторная проверка подтвердит брак, ОТК сделает свой
   * `returnToRework` к швее и pending швеи отзовутся штатно. На forward
   * (включая same-idx) блок остаётся.
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

    // По целевой операции уже есть `OPERATION_FINISHED` (не покрытый
    // последующим rework) → по умолчанию запрещаем вернуть на неё
    // паспорт: операция считается закрытой безвозвратно. Исключения:
    //
    //   - переделка по браку через ОТК: `QcService.returnToRework`
    //     пишет `OPERATION_REWORK_OPENED`, и блок снимается;
    //   - **backward-движение мастером**: типичный кейс — ОТК выпустил
    //     паспорт, ВТО нашёл брак, мастер возвращает на ОТК для
    //     повторной проверки. Технически это новый rework на target —
    //     запишем `OPERATION_REWORK_OPENED` в той же транзакции ниже,
    //     чтобы дальнейшие `assertOperationNotFinished` пропускали
    //     повторный проход; на forward (включая same-idx) блок остаётся.
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
      select: { id: true, employeeId: true, qty: true },
    });
    if (finishedOnTarget && !isBackward) {
      throw new MasterTargetOperationAlreadyFinishedException();
    }
    const reopenFinishedTarget = Boolean(finishedOnTarget && isBackward);

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
      // Если возвращаем на уже завершённую операцию — пишем
      // OPERATION_REWORK_OPENED ПЕРЕД update паспорта. Семантика та же,
      // что у QcService.returnToRework: target-операция переоткрывается
      // для нового прохода, employeeId события — последний финишёр
      // (нужно UI «К переделке» и для дальнейшей логики revoke earnings,
      // которую сам мастер не делает — это останется на ОТК).
      // Earnings ОТК трогать НЕ будем — у мастера нет полномочий
      // отменять выплаты. Если повторная проверка подтвердит брак, ОТК
      // сделает свой returnToRework к швее и pending швеи отзовутся
      // штатно.
      if (reopenFinishedTarget && finishedOnTarget) {
        await tx.passportEvent.create({
          data: {
            passportId: passport.id,
            type: PassportEventType.OPERATION_REWORK_OPENED,
            operationId: target!.operationId,
            employeeId: finishedOnTarget.employeeId,
            qty: finishedOnTarget.qty ?? passport.qtyGood ?? passport.qtyCut,
          },
        });
      }
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
            // reopenedFinishedTarget = true означает «откат на ранее
            // завершённую операцию с переоткрытием гейта». UI/ретро
            // могут показать это как «возврат на проверку», а не
            // обычное перемещение по маршруту.
            reopenedFinishedTarget: reopenFinishedTarget || undefined,
            previousFinisherEmployeeId:
              reopenFinishedTarget && finishedOnTarget
                ? finishedOnTarget.employeeId ?? undefined
                : undefined,
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
      `event=master.setRouteStep passportId=${passportId} actor=${actor.employeeId} routeStepIndex=${target!.index} operationId=${target!.operationId} direction=${isBackward ? 'BACKWARD' : 'FORWARD'}${cell ? ` cellId=${cell.id}` : ''}${targetEmployee ? ` targetEmployeeId=${targetEmployee.id}` : ''}${reopenFinishedTarget ? ' reopenedFinishedTarget=true' : ''} reason=${dto.reason}`,
    );
    return {
      passport: this.snapshot(updated),
      before: this.beforeSnapshot(before),
    };
  }

  // -------------------------------------------------------------------------
  // 5. FIND BY CODE — поиск паспорта для кнопки «Сканировать паспорт»
  // -------------------------------------------------------------------------


  // -------------------------------------------------------------------------
  // НАРЯД-ДОПУСК (RouteWorkPermit)
  // -------------------------------------------------------------------------

  /**
   * Выдать наряд-допуск: разрешить по заказу операцию, которой нет в
   * его маршруте.
   *
   * Легальный обход гейта `offRouteWorkPolicy = BLOCK`. Без него первая
   * же нештатная ситуация (сломался станок, срочный перекрой, цех
   * перешёл на другую технологию посреди партии) означает простой
   * рабочего места — а простой заканчивается требованием выключить
   * гейт, и второй раз его никто не включит.
   *
   * Три проверки, которые делают допуск осмысленным:
   *   1. `satisfiesStepOperationId` обязан РЕАЛЬНО стоять в снимке
   *      маршрута заказа. Иначе допуск ничего не закрывает: швея
   *      дошьёт, а AND-гейт перед ОТК всё равно уронит партию — ровно
   *      инцидент 28.07.2026, только с разрешением на руках.
   *   2. Разрешаемой операции НЕ должно быть в маршруте — иначе допуск
   *      не нужен и, скорее всего, мастер ошибся строкой.
   *   3. Заказ должен существовать и быть живым.
   */
  async createRouteWorkPermit(
    actor: AuthPrincipal,
    dto: CreateRouteWorkPermitDto,
  ): Promise<RouteWorkPermitDto> {
    const order = await this.prisma.order.findUnique({
      where: { id: dto.orderId },
      select: { id: true, number: true, status: true },
    });
    if (!order) throw new MasterOrderHasNoRouteSnapshotException();

    const steps = await this.prisma.orderRouteStep.findMany({
      where: { orderId: dto.orderId },
      select: { operationId: true },
    });
    if (steps.length === 0) {
      throw new MasterOrderHasNoRouteSnapshotException();
    }
    const routeOps = new Set(steps.map((s) => s.operationId));
    if (!routeOps.has(dto.satisfiesStepOperationId)) {
      // Закрываемый шаг обязан быть в маршруте — см. п. 1.
      throw new MasterRouteStepNotInSnapshotException();
    }
    if (routeOps.has(dto.operationId)) {
      throw new RouteWorkPermitOperationAlreadyInRouteException();
    }

    const expiresAt = new Date(Date.now() + dto.hours * 60 * 60 * 1000);
    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.routeWorkPermit.create({
        data: {
          orderId: dto.orderId,
          operationId: dto.operationId,
          satisfiesStepOperationId: dto.satisfiesStepOperationId,
          reason: dto.reason,
          qtyLimit: dto.qtyLimit ?? null,
          expiresAt,
          createdById: actor.employeeId,
        },
        include: permitInclude,
      });
      await this.audit.log(
        {
          event: 'MASTER_ROUTE_WORK_PERMIT_ISSUED',
          entityType: 'ORDER',
          entityId: dto.orderId,
          employeeId: actor.employeeId,
          payload: {
            permitId: row.id,
            operationId: dto.operationId,
            satisfiesStepOperationId: dto.satisfiesStepOperationId,
            reason: dto.reason,
            qtyLimit: dto.qtyLimit ?? null,
            expiresAt: expiresAt.toISOString(),
          },
        },
        tx,
      );
      return row;
    });
    this.logger.log(
      `event=master.permit.issued permitId=${created.id} orderId=${dto.orderId} operationId=${dto.operationId} satisfies=${dto.satisfiesStepOperationId} actor=${actor.employeeId}`,
    );
    return this.toPermitDto(created, 0);
  }

  /** Отозвать допуск раньше срока. */
  async revokeRouteWorkPermit(
    actor: AuthPrincipal,
    permitId: string,
    dto: RevokeRouteWorkPermitDto,
  ): Promise<RouteWorkPermitDto> {
    const existing = await this.prisma.routeWorkPermit.findUnique({
      where: { id: permitId },
      select: { id: true, revokedAt: true, orderId: true },
    });
    if (!existing) throw new RouteWorkPermitNotFoundException();
    if (existing.revokedAt) {
      // Идемпотентно: повторный отзыв не ошибка, просто ничего не меняем.
      return this.getPermitDto(permitId);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.routeWorkPermit.update({
        where: { id: permitId },
        data: { revokedAt: new Date(), revokedById: actor.employeeId },
      });
      await this.audit.log(
        {
          event: 'MASTER_ROUTE_WORK_PERMIT_REVOKED',
          entityType: 'ORDER',
          entityId: existing.orderId,
          employeeId: actor.employeeId,
          payload: { permitId, reason: dto.reason },
        },
        tx,
      );
    });
    this.logger.log(
      `event=master.permit.revoked permitId=${permitId} actor=${actor.employeeId}`,
    );
    return this.getPermitDto(permitId);
  }

  /** Допуски заказа (или все действующие, если заказ не указан). */
  async listRouteWorkPermits(orderId?: string): Promise<RouteWorkPermitDto[]> {
    const rows = await this.prisma.routeWorkPermit.findMany({
      where: orderId ? { orderId } : {},
      include: permitInclude,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return Promise.all(
      rows.map(async (r) => this.toPermitDto(r, await this.permitUsedQty(r))),
    );
  }

  private async getPermitDto(permitId: string): Promise<RouteWorkPermitDto> {
    const row = await this.prisma.routeWorkPermit.findUnique({
      where: { id: permitId },
      include: permitInclude,
    });
    if (!row) throw new RouteWorkPermitNotFoundException();
    return this.toPermitDto(row, await this.permitUsedQty(row));
  }

  /**
   * Сколько изделий уже закрыто под допуском — по фактическим
   * `OPERATION_FINISHED` на разрешённой операции ПОСЛЕ его выдачи.
   * Без этого «лимит 50 штук» был бы декорацией.
   */
  private async permitUsedQty(row: {
    orderId: string;
    operationId: string;
    createdAt: Date;
  }): Promise<number> {
    const events = await this.prisma.passportEvent.findMany({
      where: {
        type: PassportEventType.OPERATION_FINISHED,
        operationId: row.operationId,
        createdAt: { gte: row.createdAt },
        passport: { orderId: row.orderId },
      },
      select: { passport: { select: { qtyGood: true } } },
    });
    return events.reduce((s, e) => s + (e.passport?.qtyGood ?? 0), 0);
  }

  private toPermitDto(
    row: Prisma.RouteWorkPermitGetPayload<{ include: typeof permitInclude }>,
    qtyUsed: number,
  ): RouteWorkPermitDto {
    const exhausted = row.qtyLimit != null && qtyUsed >= row.qtyLimit;
    return {
      id: row.id,
      orderId: row.orderId,
      orderNumber: row.order.number,
      operationId: row.operationId,
      operationCode: row.operation.code,
      operationName: row.operation.name,
      satisfiesStepOperationId: row.satisfiesStepOperationId,
      satisfiesStepOperationCode: row.satisfiesStepOperation.code,
      satisfiesStepOperationName: row.satisfiesStepOperation.name,
      reason: row.reason,
      qtyLimit: row.qtyLimit,
      qtyUsed,
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      createdByName: row.createdBy.fullName,
      revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
      revokedByName: row.revokedBy?.fullName ?? null,
      active:
        row.revokedAt === null && row.expiresAt > new Date() && !exhausted,
    };
  }

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
        number: true,
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
      number: row.number,
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

  /**
   * Кандидаты на передачу паспорта — активные сотрудники с их открытой
   * сменой.
   *
   * Зачем ручка: до неё «Передать сотруднику» умело принимать ТОЛЬКО
   * payload бумажной этикетки `EMPLOYEE:<cuid>`, а справочник
   * `GET /api/employees` закрыт ролями `SHOP_MANAGER`/`ADMIN` — мастеру
   * туда нельзя. В цехе 11.08.2026 это кончилось 17 подряд 400
   * `INVALID_EMPLOYEE_QR`: передать паспорт было физически нечем, и
   * мастер пошла кружным путём через `setRouteStep`.
   *
   * Ролью список не сужаем (см. `MasterTransferCandidateDto`) —
   * сортируем. Наверху те, чья смена стоит на текущем шаге паспорта:
   * только для них передача сдвинет и шаг маршрута, а не одного лишь
   * владельца (`transferToEmployee`, soft-route MVP).
   *
   * Read-only, audit не пишем — это lookup перед действием.
   */
  async listTransferCandidates(
    passportId?: string,
  ): Promise<MasterTransferCandidatesDto> {
    let routeOperationIds = new Set<string>();
    let currentStepOperationId: string | null = null;
    let resolvedPassportId: string | null = null;
    if (passportId) {
      // Терминальный паспорт отбиваем здесь же: иначе мастер выберет
      // получателя, а действие упадёт `PASSPORT_TERMINAL_FOR_MASTER`.
      const passport = await this.loadPassportOrThrow(passportId);
      this.assertNotTerminal(passport);
      resolvedPassportId = passport.id;
      const steps = await this.prisma.orderRouteStep.findMany({
        where: { orderId: passport.orderId },
        select: { index: true, operationId: true },
      });
      routeOperationIds = new Set(steps.map((s) => s.operationId));
      currentStepOperationId =
        steps.find((s) => s.index === passport.currentRouteStepIndex)
          ?.operationId ?? null;
    }

    const employees = await this.prisma.employee.findMany({
      where: { active: true },
      select: { id: true, fullName: true, role: true },
      orderBy: { fullName: 'asc' },
    });
    if (employees.length === 0) {
      return { passportId: resolvedPassportId, rows: [] };
    }
    const ids = employees.map((e) => e.id);

    const [shifts, passportGroups] = await Promise.all([
      this.prisma.shiftSession.findMany({
        where: { employeeId: { in: ids }, endedAt: null },
        orderBy: { startedAt: 'asc' },
        select: {
          employeeId: true,
          operation: { select: { id: true, name: true } },
          equipment: { select: { code: true, displayNumber: true } },
        },
      }),
      this.prisma.passport.groupBy({
        by: ['currentEmployeeId'],
        where: {
          currentEmployeeId: { in: ids },
          status: PassportStatus.IN_PROGRESS,
        },
        _count: { _all: true },
      }),
    ]);

    const shiftByEmployee = new Map<string, (typeof shifts)[number]>();
    for (const s of shifts) {
      // Открытых смен у сотрудника штатно одна; если их всё же две,
      // берём самую раннюю — ту же, что подхватит issue-flow.
      if (!shiftByEmployee.has(s.employeeId)) shiftByEmployee.set(s.employeeId, s);
    }
    const passportsByEmployee = new Map<string, number>();
    for (const g of passportGroups) {
      if (g.currentEmployeeId) {
        passportsByEmployee.set(g.currentEmployeeId, g._count._all);
      }
    }

    const rows: MasterTransferCandidateDto[] = employees.map((e) => {
      const shift = shiftByEmployee.get(e.id);
      return {
        id: e.id,
        fullName: e.fullName,
        role: e.role,
        activeShift: shift
          ? {
              operationId: shift.operation.id,
              operationName: shift.operation.name,
              equipmentLabel:
                shift.equipment.displayNumber ?? shift.equipment.code,
              operationInRoute: routeOperationIds.has(shift.operation.id),
              operationIsCurrentStep:
                currentStepOperationId !== null &&
                shift.operation.id === currentStepOperationId,
            }
          : null,
        passportsInProgress: passportsByEmployee.get(e.id) ?? 0,
      };
    });

    const rank = (r: MasterTransferCandidateDto): number => {
      if (!r.activeShift) return 3;
      if (r.activeShift.operationIsCurrentStep) return 0;
      if (r.activeShift.operationInRoute) return 1;
      return 2;
    };
    rows.sort(
      (a, b) => rank(a) - rank(b) || a.fullName.localeCompare(b.fullName, 'ru'),
    );

    return { passportId: resolvedPassportId, rows };
  }

  // -------------------------------------------------------------------------
  // 6. SELF-OPERATION — мастер выполняет операцию сама
  // -------------------------------------------------------------------------

  /**
   * Шаги маршрута заказа с пометкой «можно ли мне взять это на себя».
   *
   * Доступность каждого шага считает `PassportsService.
   * previewOperationAvailability` — тот же расчёт, что и у швеи при
   * «получить крой». Здесь НЕТ отдельных правил для мастера: если шаг
   * недоступен, ответ объясняет причину теми же словами, которые
   * вернула бы сама попытка.
   */
  async listSelfOperationSteps(
    actor: AuthPrincipal,
    passportId: string,
  ): Promise<MasterSelfOperationStepsDto> {
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

    const equipmentByOperation = await this.loadEquipmentByOperation(
      steps.map((s) => s.operationId),
    );

    const out: MasterSelfOperationStepDto[] = [];
    for (const s of steps) {
      const preview = await this.passports.previewOperationAvailability(
        passport.id,
        s.operationId,
      );
      out.push({
        index: s.index,
        operationId: s.operationId,
        operationName: s.operation.name,
        isCurrent: s.index === passport.currentRouteStepIndex,
        finished: preview.code === 'PASSPORT_OPERATION_ALREADY_FINISHED',
        available: preview.available,
        blockedCode: preview.code,
        blockedReason: preview.message,
        equipment: equipmentByOperation.get(s.operationId) ?? [],
      });
    }

    // Сдельная строка создаётся только сотруднику НЕ на чистом окладе
    // (см. `EarningsService.createPendingForCompletedOperation`). Мастер
    // на окладе — работа зачтётся в маршрут, но денег не принесёт, и
    // сказать об этом надо до нажатия, а не после.
    const employee = await this.prisma.employee.findUnique({
      where: { id: actor.employeeId },
      select: { compensationType: true },
    });

    return {
      passportId: passport.id,
      steps: out,
      pieceworkPaid: employee
        ? isPieceworkEligible(employee.compensationType)
        : false,
    };
  }

  /**
   * Выполнить операцию маршрута самой: одно действие вместо связки
   * «открыть смену → скан → скан».
   *
   * Механика — техническая смена. Движение паспорта по маршруту умеет
   * ровно один канал: `issueToEmployee` + `completeOperationByEmployee`,
   * и оба требуют открытую `ShiftSession` (операция и рабочее место
   * берутся из неё). Поэтому здесь смена открывается на время действия
   * и закрывается сразу после — НАПРЯМУЮ, минуя `ShiftsService.
   * start/stop`, чтобы не дёргать окладную синхронизацию: мастер на
   * почасовом окладе иначе получила бы повременные часы за минуту
   * работы (`SalaryService.syncDailySalary`).
   *
   * Никакой своей бизнес-логики маршрута тут нет: все гейты (откат
   * назад, параллельные группы, ОТК перед ВТО, работа вне маршрута,
   * подстановки операций) отрабатывают внутри вызываемых методов.
   *
   * Чужую открытую смену действие не трогает — это «Начальник цеха»,
   * стоящий за станком, или мастер с ролью швеи: молча закрыв её, мы
   * потеряли бы человеку часы.
   */
  async performSelfOperation(
    actor: AuthPrincipal,
    passportId: string,
    dto: MasterSelfOperationDto,
  ): Promise<MasterActionResultDto> {
    const passport = await this.loadPassportOrThrow(passportId);
    this.assertNotTerminal(passport);
    const before = this.snapshot(passport);

    const steps = await this.prisma.orderRouteStep.findMany({
      where: { orderId: passport.orderId },
      select: { operationId: true, operation: { select: { name: true } } },
    });
    if (steps.length === 0) {
      throw new MasterOrderHasNoRouteSnapshotException();
    }
    const target = steps.find((s) => s.operationId === dto.operationId);
    if (!target) throw new MasterRouteStepNotInSnapshotException();

    // Открытый возврат от ОТК перехватывает взятие паспорта: он уводит
    // его на операцию переделки, а не на выбранную (см.
    // `PassportsService.resolveOperationForPassport`). Молчаливая
    // подмена операции — худший из возможных исходов для мастера,
    // поэтому отказываем с именами операций.
    const openReworks = await this.passports.listOpenReworkOperations(
      passport.id,
    );
    const foreignReworks = openReworks.filter(
      (r) => r.id !== target.operationId,
    );
    if (foreignReworks.length > 0) {
      throw new MasterSelfOperationReworkFirstException(
        foreignReworks.map((r) => r.name),
      );
    }

    const equipmentId = await this.resolveSelfOperationEquipment(
      target.operationId,
      target.operation.name,
      dto.equipmentId,
    );

    // Смена: своя открытая на этой же операции — используем её (мастер
    // могла открыть её как швея); открытая на другой — отказ; нет —
    // заводим техническую и закроем в `finally`.
    const openShift = await this.prisma.shiftSession.findFirst({
      where: { employeeId: actor.employeeId, endedAt: null },
      select: { id: true, operationId: true },
    });
    if (openShift && openShift.operationId !== target.operationId) {
      const busyOp = await this.prisma.operation.findUnique({
        where: { id: openShift.operationId },
        select: { name: true },
      });
      throw new MasterSelfOperationShiftBusyException(
        busyOp?.name ?? openShift.operationId,
      );
    }

    let technicalShiftId: string | null = null;
    if (!openShift) {
      const created = await this.prisma.shiftSession.create({
        data: {
          employeeId: actor.employeeId,
          equipmentId,
          operationId: target.operationId,
        },
        select: { id: true, startedAt: true },
      });
      technicalShiftId = created.id;
      // Табель дня: техническая смена — такое же время работы мастера,
      // как обычная смена, и в «где был» должна попадать (см.
      // `shifts/shift-segments.ts`).
      await openShiftSegment(this.prisma, {
        shiftSessionId: created.id,
        employeeId: actor.employeeId,
        equipmentId,
        operationId: target.operationId,
        at: created.startedAt,
      });
    }

    try {
      await this.passports.issueToEmployee(passport.id, actor.employeeId);
      try {
        await this.passports.completeOperationByEmployee(
          passport.id,
          actor.employeeId,
        );
      } catch (e) {
        // `issueToEmployee` уже закрепил паспорт за мастером, а
        // завершение упало на своём гейте (повтор операции, откат
        // назад, работа вне маршрута, сбой БД). Без компенсации
        // паспорт зависает «в работе у мастера»: её кабинет такие
        // паспорта не показывает, а следующая попытка того же
        // действия упрётся в `PASSPORT_ALREADY_ISSUED` — разруливать
        // пришлось бы вручную через «Снять с сотрудника».
        await this.releaseAfterFailedSelfOperation(
          passport.id,
          actor,
          before,
          e,
        );
        throw e;
      }
    } finally {
      if (technicalShiftId) {
        const endedAt = new Date();
        await this.prisma.shiftSession.update({
          where: { id: technicalShiftId },
          data: { endedAt },
        });
        await closeShiftSegments(this.prisma, technicalShiftId, endedAt);
      }
    }

    const updated = await this.loadPassportOrThrow(passport.id);
    await this.audit.log({
      event: 'MASTER_PASSPORT_SELF_OPERATION',
      entityType: 'PASSPORT',
      entityId: passport.id,
      employeeId: actor.employeeId,
      payload: this.auditPayload({
        comment: dto.comment,
        operationId: target.operationId,
        operationName: target.operation.name,
        equipmentId,
        technicalShift: technicalShiftId !== null,
        before,
        after: this.snapshot(updated),
      }),
    });

    this.logger.log(
      `event=master.self-operation passportId=${passport.id} actor=${actor.employeeId} operationId=${target.operationId} equipmentId=${equipmentId} technicalShift=${technicalShiftId !== null}`,
    );

    return {
      passport: this.snapshot(updated),
      before: this.beforeSnapshot(before),
    };
  }

  /**
   * Компенсация неудавшегося `performSelfOperation`: снять паспорт с
   * мастера, если завершение операции упало уже ПОСЛЕ выдачи.
   *
   * Пара `issueToEmployee` + `completeOperationByEmployee` — два
   * независимых вызова со своими транзакциями; общую сюда не завести,
   * не переписав оба публичных метода под внешний `tx` (их зовут все
   * швейные каналы). Поэтому компенсируем то единственное, что
   * оставляет застрявшее состояние, — владельца.
   *
   * Снимаем ТОЛЬКО `currentEmployeeId` — ровно семантика `unassign`
   * («точечная коррекция владельца, не движение по маршруту»).
   * `currentOperationId` / `currentRouteStepIndex` / статус / ячейку не
   * откатываем: `issueToEmployee` менял их вместе с `CellContent` и
   * событиями, и ручной откат кусками рисковал бы рассинхроном. Паспорт
   * остаётся стоять на операции без владельца — состояние штатное, его
   * же даёт мастерский «Снять с сотрудника».
   *
   * Исходную ошибку компенсация не глотает: `performSelfOperation`
   * пробрасывает её дальше. Если упадёт сама компенсация — пишем в лог
   * и молчим, иначе мастер увидит вторичную ошибку вместо причины.
   */
  private async releaseAfterFailedSelfOperation(
    passportId: string,
    actor: AuthPrincipal,
    before: MasterActionPassportSnapshotDto,
    cause: unknown,
  ): Promise<void> {
    try {
      const current = await this.loadPassportOrThrow(passportId);
      // Паспорт может быть уже не за мастером (гонка с другим
      // действием) — тогда компенсировать нечего.
      if (current.currentEmployeeId !== actor.employeeId) return;

      await this.prisma.$transaction(async (tx) => {
        const next = await tx.passport.update({
          where: { id: passportId },
          data: { currentEmployeeId: null },
          include: passportInclude,
        });
        await this.audit.log(
          {
            event: 'MASTER_PASSPORT_SELF_OPERATION_ROLLED_BACK',
            entityType: 'PASSPORT',
            entityId: passportId,
            employeeId: actor.employeeId,
            payload: this.auditPayload({
              reason:
                cause instanceof Error ? cause.message : String(cause),
              before,
              after: this.snapshot(next),
            }),
          },
          tx,
        );
      });
      this.logger.warn(
        `event=master.self-operation.rollback passportId=${passportId} actor=${actor.employeeId} cause=${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    } catch (rollbackError) {
      this.logger.error(
        `event=master.self-operation.rollback-failed passportId=${passportId} actor=${actor.employeeId} error=${
          rollbackError instanceof Error
            ? rollbackError.message
            : String(rollbackError)
        }`,
      );
    }
  }

  /**
   * Станок для события: у операции обычно ровно одно рабочее место
   * («ПУГОВИЦА» → «ПУГОВИЧНАЯ МАШИНКА»), и спрашивать нечего. Если их
   * несколько (ПРЯМОСТРОЧКА, ОВЕРЛОК) — выбор за мастером: по
   * `equipmentId` в событиях считают загрузку оборудования.
   */
  private async resolveSelfOperationEquipment(
    operationId: string,
    operationName: string,
    requestedEquipmentId?: string,
  ): Promise<string> {
    const links = await this.loadEquipmentByOperation([operationId]);
    const list = links.get(operationId) ?? [];
    if (requestedEquipmentId) {
      const picked = list.find((e) => e.id === requestedEquipmentId);
      if (!picked) {
        throw new MasterSelfOperationEquipmentNotAllowedException();
      }
      return picked.id;
    }
    if (list.length === 0) {
      throw new MasterSelfOperationNoEquipmentException(operationName);
    }
    if (list.length > 1) {
      throw new MasterSelfOperationEquipmentRequiredException();
    }
    return list[0]!.id;
  }

  /** Активные станки, привязанные к операциям (`EquipmentOperation`). */
  private async loadEquipmentByOperation(
    operationIds: string[],
  ): Promise<Map<string, MasterSelfOperationEquipmentDto[]>> {
    const rows = await this.prisma.equipmentOperation.findMany({
      where: {
        operationId: { in: operationIds },
        isActive: true,
        equipment: { active: true },
      },
      orderBy: [{ sortOrder: 'asc' }],
      select: {
        operationId: true,
        equipment: { select: { id: true, code: true, name: true } },
      },
    });
    const map = new Map<string, MasterSelfOperationEquipmentDto[]>();
    for (const r of rows) {
      const list = map.get(r.operationId) ?? [];
      list.push({
        id: r.equipment.id,
        code: r.equipment.code,
        name: r.equipment.name,
      });
      map.set(r.operationId, list);
    }
    return map;
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

  /**
   * `employeeId` из тела или из отсканированного QR — в цехе их два
   * формата, и оба обязаны работать:
   *
   *   - `EMPLOYEE:<id>` — бумажная этикетка `/api/employees/:id/print`;
   *   - `SEWING_EMPLOYEE:<token>` — «Мой QR-код» с терминала самого
   *     сотрудника, подписанный токен на 12 часов.
   *
   * Второй раньше не принимался вовсе: `INVALID_EMPLOYEE_QR` на бейдж,
   * который сотрудник показывает с телефона, — это отказ по формату
   * там, где человек всё сделал правильно.
   */
  private async resolveEmployeeId(dto: {
    employeeId?: string;
    employeeQr?: string;
  }): Promise<string> {
    if (dto.employeeId) return dto.employeeId;
    const scan = parseAnyEmployeeQr(dto.employeeQr ?? '');
    if (!scan) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'INVALID_EMPLOYEE_QR',
        message:
          'Это не QR сотрудника — отсканируйте бейдж или выберите человека в списке.',
      });
    }
    if (scan.kind === 'badge') return scan.employeeId;
    const payload = this.me.verifyEmployeeQrToken(scan.token);
    if (!payload) throw new EmployeeQrTokenInvalidException();
    return payload.employeeId;
  }

  /**
   * Отсканированный QR → карточка сотрудника (см.
   * `ResolvedEmployeeQrDto`). Read-only: UI мастера зовёт её сразу
   * после скана, чтобы показать, КОГО выбрали, до подтверждения
   * действия. Деактивированного тоже отдаём — отказ даст само действие.
   */
  async resolveEmployeeQr(qr: string): Promise<ResolvedEmployeeQrDto> {
    const employeeId = await this.resolveEmployeeId({ employeeQr: qr });
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, fullName: true, role: true, active: true },
    });
    if (!employee) throw new MasterTargetEmployeeNotFoundException();
    return {
      employeeId: employee.id,
      fullName: employee.fullName,
      role: employee.role,
      active: employee.active,
    };
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
      number: row.number,
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
    /**
     * Причина есть у всех действий, КРОМЕ «выполнить операцию самой»:
     * там мастер фиксирует свою работу, а не правит чужую, и требовать
     * оправдание не за что (см. `performSelfOperation`).
     */
    reason?: string;
    comment?: string;
    operationName?: string;
    equipmentId?: string;
    /** Смена была заведена самим действием и закрыта следом. */
    technicalShift?: boolean;
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
    reopenedFinishedTarget?: boolean;
    previousFinisherEmployeeId?: string;
    /**
     * Передали паспорт швее, чья активная смена стоит на операции ВНЕ
     * маршрута заказа. Шаг паспорта при этом не двигали. Раньше такой
     * случай не оставлял следа вообще (см. `transferToEmployee`).
     */
    offRouteShiftOperationId?: string | null;
  }): Prisma.InputJsonValue {
    const compact = (s: MasterActionPassportSnapshotDto) => ({
      currentEmployeeId: s.currentEmployeeId,
      currentCellId: s.currentCell ? s.currentCell.id : null,
      currentOperationId: s.currentOperation ? s.currentOperation.id : null,
      currentRouteStepIndex: s.currentRouteStepIndex,
      status: s.status,
    });
    const payload: Record<string, unknown> = {
      before: compact(input.before),
      after: compact(input.after),
    };
    if (input.reason) payload.reason = input.reason;
    if (input.comment) payload.comment = input.comment;
    if (input.operationName) payload.operationName = input.operationName;
    if (input.equipmentId) payload.equipmentId = input.equipmentId;
    if (input.technicalShift) payload.technicalShift = true;
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
    if (input.reopenedFinishedTarget) {
      payload.reopenedFinishedTarget = true;
    }
    if (input.previousFinisherEmployeeId) {
      payload.previousFinisherEmployeeId = input.previousFinisherEmployeeId;
    }
    if (input.offRouteShiftOperationId) {
      payload.offRouteShiftOperationId = input.offRouteShiftOperationId;
    }
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

/** Полный include для DTO допуска. */
const permitInclude = {
  order: { select: { number: true } },
  operation: { select: { code: true, name: true } },
  satisfiesStepOperation: { select: { code: true, name: true } },
  createdBy: { select: { fullName: true } },
  revokedBy: { select: { fullName: true } },
} as const;
