import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ListWorkshopNeedsQuerySchema,
  UpdateWorkshopNeedSchema,
  ErpLinkWorkshopNeedSchema,
  ErpUnlinkWorkshopNeedSchema,
  type ErpLinkWorkshopNeedDto,
  type ErpUnlinkWorkshopNeedDto,
  WorkshopNeedsArchiveRequestSchema,
  type ListWorkshopNeedsQuery,
  type UpdateWorkshopNeedDto,
  type WorkshopNeedDto,
  type WorkshopNeedListItemDto,
  type WorkshopNeedsArchiveRequestDto,
  type WorkshopNeedsArchiveResultDto,
} from '@sewing/shared/workshop-needs';

import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, MachineScopes, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { WorkshopNeedsService } from './workshop-needs.service.js';

/**
 * `/api/workshop-needs` — управление отдельной строкой потребности
 * цеха (см. `docs/recon-soft-integration.md §«Этап 4А»`).
 *
 *   GET    /api/workshop-needs              — список
 *   GET    /api/workshop-needs/:id          — карточка
 *   PATCH  /api/workshop-needs/:id          — закупщик правит
 *   POST   /api/workshop-needs/:id/cancel   — статус CANCELLED
 *
 * RBAC: `ADMIN` / `SHOP_MANAGER` (новые роли не вводим — закупщик
 * на MVP работает под существующей ролью SHOP_MANAGER).
 *
 * Расчёт по конкретному заказу живёт в
 * `WorkshopNeedsOrderController` (`/api/orders/:id/workshop-needs/*`).
 */
/** Ручки шва — только интеграции: человек с ролью класса не должен «принимать через ERP» руками. */
function assertMachine(user: AuthPrincipal): void {
  if (user.kind !== 'MACHINE') {
    throw new ForbiddenException({
      statusCode: 403,
      code: 'FORBIDDEN_ROLE',
      message: 'Ручка только для интеграции ERP.',
    });
  }
}

@Controller('workshop-needs')
@MachineScopes('needs:read')
@Roles('ADMIN', 'SHOP_MANAGER')
export class WorkshopNeedsController {
  constructor(private readonly needs: WorkshopNeedsService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(ListWorkshopNeedsQuerySchema))
    query: ListWorkshopNeedsQuery,
  ): Promise<WorkshopNeedListItemDto[]> {
    return this.needs.list(query);
  }

  /**
   * Фича «Архив расчётов цеха»: массовая архивация заказов из списка
   * потребностей (скрыть в «Архив»). Точечно = один id в массиве;
   * «Архивировать все» = все видимые id. Частичный успех — непрошедшие
   * гейт заказы возвращаются в `skipped`.
   */
  @MachineScopes('needs:write')
  @Post('archive')
  archive(
    @Body(new ZodValidationPipe(WorkshopNeedsArchiveRequestSchema))
    dto: WorkshopNeedsArchiveRequestDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<WorkshopNeedsArchiveResultDto> {
    return this.needs.archiveOrders(dto.orderIds, user.employeeId);
  }

  /** Вернуть заказы из архива в активный список потребностей. */
  @MachineScopes('needs:write')
  @Post('restore')
  restore(
    @Body(new ZodValidationPipe(WorkshopNeedsArchiveRequestSchema))
    dto: WorkshopNeedsArchiveRequestDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<WorkshopNeedsArchiveResultDto> {
    return this.needs.restoreOrders(dto.orderIds, user.employeeId);
  }

  /**
   * Безвозвратно стереть просчёт заказов (все `OrderCalculation` +
   * `WorkshopNeed`; сам заказ остаётся). Только из архива и только если
   * по строкам нет складских движений (иначе `skipped: HAS_STOCK`).
   */
  @MachineScopes('needs:write')
  @Post('purge')
  purge(
    @Body(new ZodValidationPipe(WorkshopNeedsArchiveRequestSchema))
    dto: WorkshopNeedsArchiveRequestDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<WorkshopNeedsArchiveResultDto> {
    return this.needs.purgeOrders(dto.orderIds, user.employeeId);
  }

  @Get(':id')
  getOne(@Param('id') id: string): Promise<WorkshopNeedDto> {
    return this.needs.getOne(id);
  }

  @MachineScopes('needs:write')
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateWorkshopNeedSchema))
    dto: UpdateWorkshopNeedDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<WorkshopNeedDto> {
    return this.needs.update(id, dto, user.employeeId);
  }

  /** Закупочный шов ERP: ERP взяла потребность под свой заказ / сообщает приход по своей приёмке. */
  @MachineScopes('needs:write')
  @Post(':id/erp-link')
  erpLink(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ErpLinkWorkshopNeedSchema))
    dto: ErpLinkWorkshopNeedDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<WorkshopNeedDto> {
    assertMachine(user);
    return this.needs.erpLink(id, dto, user.employeeId);
  }

  /** Закупочный шов ERP: заказ ERP отменён до прихода — потребность возвращается «К закупке». */
  @MachineScopes('needs:write')
  @Post(':id/erp-unlink')
  erpUnlink(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ErpUnlinkWorkshopNeedSchema))
    dto: ErpUnlinkWorkshopNeedDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<WorkshopNeedDto> {
    assertMachine(user);
    return this.needs.erpUnlink(id, dto, user.employeeId);
  }

  @MachineScopes('needs:write')
  @Post(':id/cancel')
  cancel(
    @Param('id') id: string,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<WorkshopNeedDto> {
    return this.needs.cancel(id, user.employeeId);
  }
}
