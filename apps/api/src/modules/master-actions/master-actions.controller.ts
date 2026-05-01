import { Body, Controller, Param, Post } from '@nestjs/common';
import {
  ReturnPassportToCellSchema,
  SetRouteStepSchema,
  TransferPassportSchema,
  UnassignPassportSchema,
  type MasterActionResultDto,
  type ReturnPassportToCellDto,
  type SetRouteStepDto,
  type TransferPassportDto,
  type UnassignPassportDto,
} from '@sewing/shared';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
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
  constructor(private readonly service: MasterActionsService) {}

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
}
