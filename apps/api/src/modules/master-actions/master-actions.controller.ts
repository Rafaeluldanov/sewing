import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  FindMasterPassportByCodeSchema,
  ReturnPassportToCellSchema,
  SetRouteStepSchema,
  TransferPassportSchema,
  UnassignPassportSchema,
  type FindMasterPassportByCodeDto,
  type FindMasterPassportByCodeResultDto,
  type MasterActionResultDto,
  type ReturnPassportToCellDto,
  type SetRouteStepDto,
  type TransferPassportDto,
  type UnassignPassportDto,
} from '@sewing/shared';
import {
  CreatePassportDefectSchema,
  ReturnToReworkSchema,
  type CreatePassportDefectDto,
  type DefectTypeDto,
  type QcPassportDetailDto,
  type ReturnToReworkDto,
} from '@sewing/shared/qc';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { QcService } from '../qc/qc.service.js';
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
}
