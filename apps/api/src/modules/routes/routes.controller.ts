import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  CreateRouteTemplateSchema,
  ListRouteTemplatesQuerySchema,
  UpdateRouteTemplateSchema,
  type CreateRouteTemplateDto,
  type ListRouteTemplatesQuery,
  type RouteTemplateDetailDto,
  type RouteTemplateSummaryDto,
  type UpdateRouteTemplateDto,
} from '@sewing/shared/routes';

import {
  BulkArchiveRequestSchema,
  type BulkArchiveRequestDto,
  type BulkArchiveResultDto,
} from '@sewing/shared/archive';

import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { RoutesService } from './routes.service.js';

/**
 * `/api/routes` — управление шаблонами маршрутов производства
 * (см. `docs/api.md §«routes»`, `docs/screens.md §«Маршруты»`).
 *
 * RBAC:
 *   - GET (list/detail) — все авторизованные роли могут читать. Это
 *     нужно, чтобы `/orders/new` мог подгрузить активные шаблоны для
 *     селекта; ограничение по записи отдельное.
 *   - POST/PATCH/DELETE — `ADMIN`, `SHOP_MANAGER`. Управленческое
 *     действие, тех же ролей, что и `/admin/equipment` /
 *     `/admin/operations`.
 *
 * Контракты валидируются Zod-схемами из `@sewing/shared/routes` —
 * единый источник истины для web и api.
 */
@Controller('routes')
export class RoutesController {
  constructor(private readonly routes: RoutesService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(ListRouteTemplatesQuerySchema))
    query: ListRouteTemplatesQuery,
  ): Promise<RouteTemplateSummaryDto[]> {
    return this.routes.list(query);
  }

  @Get(':id')
  getOne(@Param('id') id: string): Promise<RouteTemplateDetailDto> {
    return this.routes.getOne(id);
  }

  @Post()
  @Roles('ADMIN', 'SHOP_MANAGER')
  create(
    @Body(new ZodValidationPipe(CreateRouteTemplateSchema))
    dto: CreateRouteTemplateDto,
  ): Promise<RouteTemplateDetailDto> {
    return this.routes.create(dto);
  }

  @Patch(':id')
  @Roles('ADMIN', 'SHOP_MANAGER')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateRouteTemplateSchema))
    dto: UpdateRouteTemplateDto,
  ): Promise<RouteTemplateDetailDto> {
    return this.routes.update(id, dto);
  }

  /**
   * Массовые операции архива со списка `/admin/routes` (контракт —
   * `@sewing/shared/archive`): `isActive = false` → обратно → удалить
   * навсегда (только из архива и только если на шаблон не ссылаются
   * заказы/пробники). Ответ — частичный успех.
   */
  @Post('archive')
  @Roles('ADMIN', 'SHOP_MANAGER')
  archiveMany(
    @Body(new ZodValidationPipe(BulkArchiveRequestSchema))
    dto: BulkArchiveRequestDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<BulkArchiveResultDto> {
    return this.routes.archiveMany(dto.ids, user.employeeId);
  }

  @Post('restore')
  @Roles('ADMIN', 'SHOP_MANAGER')
  restoreMany(
    @Body(new ZodValidationPipe(BulkArchiveRequestSchema))
    dto: BulkArchiveRequestDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<BulkArchiveResultDto> {
    return this.routes.restoreMany(dto.ids, user.employeeId);
  }

  @Post('purge')
  @Roles('ADMIN', 'SHOP_MANAGER')
  purgeMany(
    @Body(new ZodValidationPipe(BulkArchiveRequestSchema))
    dto: BulkArchiveRequestDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<BulkArchiveResultDto> {
    return this.routes.purgeMany(dto.ids, user.employeeId);
  }

  @Delete(':id')
  @HttpCode(204)
  @Roles('ADMIN', 'SHOP_MANAGER')
  async remove(@Param('id') id: string): Promise<void> {
    await this.routes.remove(id);
  }
}
