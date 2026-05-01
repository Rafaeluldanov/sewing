import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  CreateCuttingClosureRequestSchema,
  ListCuttingClosureRequestsQuerySchema,
  ReviewCuttingClosureRequestSchema,
  type CreateCuttingClosureRequestDto,
  type ListCuttingClosureRequestsQuery,
  type ReviewCuttingClosureRequestDto,
} from '@sewing/shared/cutting-closure';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { CuttingClosureService } from './cutting-closure.service.js';

/**
 * Контроллер «Закрытие раскроя по размеру через заявку» (ADR-0018,
 * `docs/api.md §14`).
 *
 * RBAC:
 * - `POST /api/cutting-close-requests`           — `CUTTER_ASSISTANT`
 *   (основной флоу), плюс `SHOP_MANAGER`/`ADMIN` (могут от имени
 *   помощника подать). Менеджер всё равно затем сам подтверждает.
 * - `GET  /api/cutting-close-requests`           — `SHOP_MANAGER`,
 *   `CUTTER_ASSISTANT` (помощник видит свои), `ADMIN`.
 * - `GET  /api/cutting-close-requests/:id`       — те же роли, что и list.
 * - `POST /api/cutting-close-requests/:id/approve` — `SHOP_MANAGER`/`ADMIN`.
 * - `POST /api/cutting-close-requests/:id/reject`  — `SHOP_MANAGER`/`ADMIN`.
 *
 * `ADMIN` глобально проходит любой `@Roles(...)` через `RolesGuard`.
 */
@Controller('cutting-close-requests')
export class CuttingClosureController {
  constructor(private readonly closure: CuttingClosureService) {}

  @Post()
  @Roles('CUTTER_ASSISTANT', 'SHOP_MANAGER')
  create(
    @Body(new ZodValidationPipe(CreateCuttingClosureRequestSchema))
    dto: CreateCuttingClosureRequestDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.closure.create(dto, user.employeeId);
  }

  @Get()
  @Roles('SHOP_MANAGER', 'CUTTER_ASSISTANT')
  list(
    @Query(new ZodValidationPipe(ListCuttingClosureRequestsQuerySchema))
    query: ListCuttingClosureRequestsQuery,
  ) {
    return this.closure.list(query);
  }

  @Get(':id')
  @Roles('SHOP_MANAGER', 'CUTTER_ASSISTANT')
  getOne(@Param('id') id: string) {
    return this.closure.getOne(id);
  }

  @Post(':id/approve')
  @Roles('SHOP_MANAGER')
  approve(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ReviewCuttingClosureRequestSchema))
    dto: ReviewCuttingClosureRequestDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.closure.approve(id, dto, user.employeeId);
  }

  @Post(':id/reject')
  @Roles('SHOP_MANAGER')
  reject(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ReviewCuttingClosureRequestSchema))
    dto: ReviewCuttingClosureRequestDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.closure.reject(id, dto, user.employeeId);
  }
}
