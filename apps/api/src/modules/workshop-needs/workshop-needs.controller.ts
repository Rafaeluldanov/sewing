import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ListWorkshopNeedsQuerySchema,
  UpdateWorkshopNeedSchema,
  type ListWorkshopNeedsQuery,
  type UpdateWorkshopNeedDto,
  type WorkshopNeedDto,
  type WorkshopNeedListItemDto,
} from '@sewing/shared/workshop-needs';

import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
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
@Controller('workshop-needs')
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

  @Get(':id')
  getOne(@Param('id') id: string): Promise<WorkshopNeedDto> {
    return this.needs.getOne(id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateWorkshopNeedSchema))
    dto: UpdateWorkshopNeedDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<WorkshopNeedDto> {
    return this.needs.update(id, dto, user.employeeId);
  }

  @Post(':id/cancel')
  cancel(
    @Param('id') id: string,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<WorkshopNeedDto> {
    return this.needs.cancel(id, user.employeeId);
  }
}
