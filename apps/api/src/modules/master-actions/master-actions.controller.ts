import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  CreateRouteWorkPermitSchema,
  RevokeRouteWorkPermitSchema,
  FindMasterPassportByCodeSchema,
  MasterSelfOperationSchema,
  MasterTransferCandidatesQuerySchema,
  ReturnPassportToCellSchema,
  SetRouteStepSchema,
  TransferPassportSchema,
  UnassignPassportSchema,
  type FindMasterPassportByCodeDto,
  type FindMasterPassportByCodeResultDto,
  type MasterActionResultDto,
  type MasterSelfOperationDto,
  type MasterSelfOperationStepsDto,
  type MasterTransferCandidatesDto,
  type MasterTransferCandidatesQuery,
  type ReturnPassportToCellDto,
  type SetRouteStepDto,
  type TransferPassportDto,
  type UnassignPassportDto,
  type CreateRouteWorkPermitDto,
  type RevokeRouteWorkPermitDto,
  type RouteWorkPermitDto,
} from '@sewing/shared';
import {
  CreatePassportDefectSchema,
  ReturnToReworkSchema,
  type CreatePassportDefectDto,
  type DefectTypeDto,
  type QcPassportDetailDto,
  type ReturnToReworkDto,
} from '@sewing/shared/qc';
import {
  CreatePassportQtyCorrectionSchema,
  type ApprovePassportQtyCorrectionResultDto,
  type CreatePassportQtyCorrectionDto,
} from '@sewing/shared/passport-qty-corrections';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { QcService } from '../qc/qc.service.js';
import { PassportQtyCorrectionsService } from '../passport-qty-corrections/passport-qty-corrections.service.js';
import { MasterActionsService } from './master-actions.service.js';

/**
 * Stage 2 «Мастер цеха» — REST-контракт ручных действий мастера над
 * паспортами кроя.
 *
 * Все эндпоинты:
 *   - идентичный shape ответа `MasterActionResultDto`
 *     (`{ passport, before }`), чтобы UI единообразно обновил карточку;
 *   - обязательная `reason` в body (Zod-валидация пайпа);
 *   - запись в `AuditLog` с before/after-снэпшотом
 *     (`MASTER_PASSPORT_*`), `entityType = 'PASSPORT'`,
 *     `employeeId = мастер`;
 *   - `prisma.$transaction(...)` гарантирует «либо и операция, и аудит,
 *     либо ничего» (см. `audit.module.ts`).
 *
 * RBAC: `SHOPFLOOR_MASTER`, `SHOP_MANAGER`, `ADMIN` (последний —
 * через глобальный `AuthGuard`). Рабочие роли (`SEAMSTRESS`, `QC`,
 * `IRONING`, `PACKING`, `DISPLAY`) сюда не пускаем — это инвариант
 * ТЗ §3 «RBAC».
 */
@Controller('master-actions')
@Roles('SHOPFLOOR_MASTER', 'SHOP_MANAGER')
export class MasterActionsController {
  constructor(
    private readonly service: MasterActionsService,
    private readonly qc: QcService,
    private readonly qtyCorrections: PassportQtyCorrectionsService,
  ) {}

  /**
   * `POST /api/master-actions/passports/:id/unassign` — снять паспорт
   * с сотрудника (см. `MasterActionsService.unassign`).
   */
  @Post('passports/:id/unassign')
  unassign(
    @CurrentUser() user: AuthPrincipal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UnassignPassportSchema))
    dto: UnassignPassportDto,
  ): Promise<MasterActionResultDto> {
    return this.service.unassign(user, id, dto);
  }

  /**
   * `POST /api/master-actions/passports/:id/transfer-to-employee` —
   * переназначить паспорт другому сотруднику (см.
   * `MasterActionsService.transferToEmployee`).
   */
  @Post('passports/:id/transfer-to-employee')
  transfer(
    @CurrentUser() user: AuthPrincipal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(TransferPassportSchema))
    dto: TransferPassportDto,
  ): Promise<MasterActionResultDto> {
    return this.service.transferToEmployee(user, id, dto);
  }

  /**
   * `POST /api/master-actions/passports/:id/return-to-cell` — вернуть
   * паспорт в активную ячейку (см. `MasterActionsService.returnToCell`).
   */
  @Post('passports/:id/return-to-cell')
  returnToCell(
    @CurrentUser() user: AuthPrincipal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ReturnPassportToCellSchema))
    dto: ReturnPassportToCellDto,
  ): Promise<MasterActionResultDto> {
    return this.service.returnToCell(user, id, dto);
  }

  /**
   * `POST /api/master-actions/passports/:id/set-route-step` — назначить
   * паспорт на конкретный шаг snapshot маршрута заказа (см.
   * `MasterActionsService.setRouteStep`).
   */
  @Post('passports/:id/set-route-step')
  setRouteStep(
    @CurrentUser() user: AuthPrincipal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(SetRouteStepSchema))
    dto: SetRouteStepDto,
  ): Promise<MasterActionResultDto> {
    return this.service.setRouteStep(user, id, dto);
  }

  /**
   * `POST /api/master-actions/find-passport-by-code` — поиск паспорта
   * по произвольному коду (QR/номер/id) для кнопки «Сканировать
   * паспорт» на `/master`. Read-only; используется UI как pre-step
   * перед открытием `PassportActionsSheet` (см.
   * `MasterActionsService.findPassportByCode`).
   */
  @Post('find-passport-by-code')
  findByCode(
    @Body(new ZodValidationPipe(FindMasterPassportByCodeSchema))
    dto: FindMasterPassportByCodeDto,
  ): Promise<FindMasterPassportByCodeResultDto> {
    return this.service.findPassportByCode(dto.code);
  }

  /**
   * `GET /api/master-actions/transfer-candidates?passportId=<id>` —
   * активные сотрудники со своей открытой сменой, отсортированные «кому
   * эта работа сейчас по руке» (см.
   * `MasterActionsService.listTransferCandidates`).
   *
   * Ручка живёт здесь, а не в `/api/employees`: тот справочник закрыт
   * ролями `SHOP_MANAGER`/`ADMIN`, и `SHOPFLOOR_MASTER` в него не
   * ходит — ровно поэтому «Передать сотруднику» до этого умела только
   * QR с бумажной этикетки.
   */
  @Get('transfer-candidates')
  transferCandidates(
    @Query(new ZodValidationPipe(MasterTransferCandidatesQuerySchema))
    query: MasterTransferCandidatesQuery,
  ): Promise<MasterTransferCandidatesDto> {
    return this.service.listTransferCandidates(query.passportId);
  }

  // -------------------------------------------------------------------------
  // ОТК-действия мастера: «зафиксировать брак» / «вернуть на доработку»
  //
  // Мастер цеха может на любом этапе отсканировать паспорт и выполнить
  // те же ОТК-операции, что и роль `QC` на `/qc`. Делегируем напрямую в
  // `QcService` — единый источник правды по дефектам/возвратам. Актор —
  // сам мастер (`user.employeeId`, он же `Employee.id`), под ним
  // `QcService` пишет `DEFECT_RECORDED` / `OPERATION_REWORK_OPENED` и
  // audit. Отдельного master-аудита не заводим. RBAC — общий для
  // контроллера (`SHOPFLOOR_MASTER`, `SHOP_MANAGER`, +ADMIN глобально),
  // т.е. строже, чем у `/api/qc/*`, но это нужный мастеру набор.
  // -------------------------------------------------------------------------

  /**
   * `GET /api/master-actions/defect-types` — справочник видов брака для
   * формы «зафиксировать брак» в кабинете мастера. Дублирует
   * `GET /api/defect-types`, но тот закрыт ролями `QC`/`SHOP_MANAGER` и
   * роль `SHOPFLOOR_MASTER` к нему не имеет доступа.
   */
  @Get('defect-types')
  listDefectTypes(): Promise<DefectTypeDto[]> {
    return this.qc.listDefectTypes();
  }

  /**
   * `GET /api/master-actions/passports/:id/qc-detail` — ОТК-карточка
   * паспорта (`remainingForDefect`, `eligibleReworkTargets`,
   * `canRecordDefect`, `canReturnToRework`, история дефектов). UI
   * мастера читает её при открытии режимов «брак» / «возврат», чтобы
   * показать форму и список SEW-операций для возврата.
   */
  @Get('passports/:id/qc-detail')
  qcDetail(@Param('id') id: string): Promise<QcPassportDetailDto> {
    return this.qc.getQcDetail(id);
  }

  /**
   * `POST /api/master-actions/passports/:id/defect` — зафиксировать
   * брак по паспорту (см. `QcService.recordDefect`). Паспорт должен
   * быть `IN_PROGRESS`, иначе `PASSPORT_NOT_QCABLE`.
   */
  @Post('passports/:id/defect')
  recordDefect(
    @CurrentUser() user: AuthPrincipal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(CreatePassportDefectSchema))
    dto: CreatePassportDefectDto,
  ): Promise<QcPassportDetailDto> {
    return this.qc.recordDefect(id, dto, user.employeeId);
  }

  /**
   * `POST /api/master-actions/passports/:id/return-to-rework` — вернуть
   * паспорт на выбранную SEW-операцию швее-исполнителю (см.
   * `QcService.returnToRework`). `targetOperationId` — одна из
   * `eligibleReworkTargets` карточки. Pending-начисление швеи за эту
   * операцию отзывается (оплата при повторном завершении).
   */
  @Post('passports/:id/return-to-rework')
  returnToRework(
    @CurrentUser() user: AuthPrincipal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ReturnToReworkSchema))
    dto: ReturnToReworkDto,
  ): Promise<QcPassportDetailDto> {
    return this.qc.returnToRework(id, dto, user.employeeId);
  }

  /**
   * `POST /api/master-actions/passports/:id/qty-correction` —
   * скорректировать фактическое количество по паспорту одним шагом.
   *
   * У ОТК это двухшаговая заявка (`POST /api/qc/.../qty-corrections` →
   * approve мастером), но мастер сам аппрувер, поэтому здесь заявка
   * создаётся сразу `APPROVED` и применяется в той же транзакции
   * (см. `PassportQtyCorrectionsService.applyByMaster`). Если по
   * паспорту уже висит `PENDING`-заявка ОТК — 409
   * `QTY_CORRECTION_ALREADY_PENDING`, мастер разбирает её во вкладке
   * «Корректировки».
   */
  @Post('passports/:id/qty-correction')
  applyQtyCorrection(
    @CurrentUser() user: AuthPrincipal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(CreatePassportQtyCorrectionSchema))
    dto: CreatePassportQtyCorrectionDto,
  ): Promise<ApprovePassportQtyCorrectionResultDto> {
    return this.qtyCorrections.applyByMaster(id, dto, user.employeeId);
  }

  // -------------------------------------------------------------------------
  // «Выполнить операцию самой»: мастер работает руками
  // -------------------------------------------------------------------------

  /**
   * `GET /api/master-actions/passports/:id/self-operation-steps` — шаги
   * маршрута заказа с пометкой доступности для взятия на себя, станками
   * каждой операции и флагом `pieceworkPaid` (см.
   * `MasterActionsService.listSelfOperationSteps`). Read-only; UI мастера
   * читает её при открытии режима «выполнить операцию самой».
   */
  @Get('passports/:id/self-operation-steps')
  selfOperationSteps(
    @CurrentUser() user: AuthPrincipal,
    @Param('id') id: string,
  ): Promise<MasterSelfOperationStepsDto> {
    return this.service.listSelfOperationSteps(user, id);
  }

  /**
   * `POST /api/master-actions/passports/:id/self-operation` — мастер
   * выполнила операцию маршрута сама: одно действие вместо «открыть
   * смену → скан → скан» (см.
   * `MasterActionsService.performSelfOperation`).
   *
   * `reason` здесь сознательно НЕ требуется, в отличие от остальных
   * действий этого контроллера: те правят чужую работу, а это —
   * фиксация своей.
   */
  @Post('passports/:id/self-operation')
  selfOperation(
    @CurrentUser() user: AuthPrincipal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(MasterSelfOperationSchema))
    dto: MasterSelfOperationDto,
  ): Promise<MasterActionResultDto> {
    return this.service.performSelfOperation(user, id, dto);
  }

  // -------------------------------------------------------------------------
  // Наряд-допуск: легальный обход гейта «работа мимо маршрута»
  // -------------------------------------------------------------------------

  /**
   * Выдать допуск на работу вне маршрута по конкретному заказу.
   *
   * Ручка живёт здесь, а не в диагностике или справочниках, потому что
   * это ДЕЙСТВИЕ МАСТЕРА у станка: разблокировка цеха — его право, а не
   * разработчика. За 3 месяца до этого её приходилось делать прямыми
   * SQL-патчами по боевой базе (20 раз).
   */
  @Post('route-work-permits')
  createRouteWorkPermit(
    @CurrentUser() actor: AuthPrincipal,
    @Body(new ZodValidationPipe(CreateRouteWorkPermitSchema))
    dto: CreateRouteWorkPermitDto,
  ): Promise<RouteWorkPermitDto> {
    return this.service.createRouteWorkPermit(actor, dto);
  }

  /** Допуски заказа (или последние выданные, если заказ не указан). */
  @Get('route-work-permits')
  listRouteWorkPermits(
    @Query('orderId') orderId?: string,
  ): Promise<RouteWorkPermitDto[]> {
    return this.service.listRouteWorkPermits(orderId);
  }

  /**
   * Отозвать допуск раньше срока. Идемпотентно: повторный отзыв не
   * ошибка — мастер не должен гадать, нажалась ли кнопка.
   */
  @Post('route-work-permits/:id/revoke')
  revokeRouteWorkPermit(
    @CurrentUser() actor: AuthPrincipal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RevokeRouteWorkPermitSchema))
    dto: RevokeRouteWorkPermitDto,
  ): Promise<RouteWorkPermitDto> {
    return this.service.revokeRouteWorkPermit(actor, id, dto);
  }
}
