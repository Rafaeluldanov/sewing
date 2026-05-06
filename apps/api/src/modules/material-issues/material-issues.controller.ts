import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';

import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import {
  CancelMaterialIssueSchema,
  type CancelMaterialIssueDto,
} from './dto/cancel-material-issue.dto.js';
import {
  CreateMaterialIssueSchema,
  type CreateMaterialIssueDto,
} from './dto/create-material-issue.dto.js';
import {
  ListMaterialIssuesQuerySchema,
  type ListMaterialIssuesQuery,
} from './dto/list-material-issues.dto.js';
import {
  ReturnMaterialIssueSchema,
  type ReturnMaterialIssueDto,
} from './dto/return-material-issue.dto.js';
import { MaterialIssuesService } from './material-issues.service.js';

/**
 * `/api/material-issues` — документы фактического расхода
 * материалов по заказу (см.
 * `apps/api/src/modules/material-issues/material-issues.service.ts`,
 * `prisma/schema.prisma::MaterialIssue` / `MaterialIssueLine`,
 * `docs/api.md §«Material issues»`).
 *
 *   GET    /api/material-issues
 *   GET    /api/material-issues/:id
 *   POST   /api/material-issues
 *   POST   /api/material-issues/:id/post
 *   POST   /api/material-issues/:id/cancel
 *
 * RBAC: `ADMIN` / `SHOP_MANAGER` (новые роли в MVP не вводим — см. ТЗ).
 *
 * Список «по конкретному заказу»
 * (`GET /api/orders/:orderId/material-issues`) живёт в отдельном
 * контроллере `MaterialIssuesOrderController`, чтобы не пересекаться
 * с RBAC `OrdersController` (там класс-уровень `@Roles('SHOP_MANAGER')`
 * с расширениями для CUTTER_ASSISTANT) — тот же паттерн, что у
 * `WorkshopNeedsOrderController` / `PurchaseReceiptsOrderController`.
 */
@Controller('material-issues')
@Roles('ADMIN', 'SHOP_MANAGER')
export class MaterialIssuesController {
  constructor(private readonly materialIssues: MaterialIssuesService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(ListMaterialIssuesQuerySchema))
    query: ListMaterialIssuesQuery,
  ) {
    return this.materialIssues.list(query);
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.materialIssues.getById(id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Body(new ZodValidationPipe(CreateMaterialIssueSchema))
    body: CreateMaterialIssueDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.materialIssues.create(body, user.employeeId);
  }

  @Post(':id/post')
  @HttpCode(HttpStatus.OK)
  post(@Param('id') id: string, @CurrentUser() user: AuthPrincipal) {
    return this.materialIssues.post(id, user.employeeId);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(CancelMaterialIssueSchema))
    body: CancelMaterialIssueDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.materialIssues.cancel(id, user.employeeId, body.reason ?? null);
  }

  /**
   * `POST /api/material-issues/:id/return` — полное сторно
   * проведённого расхода (см.
   * `apps/api/src/modules/material-issues/material-issues.service.ts::returnPostedIssue`,
   * `prisma/schema.prisma::MaterialIssueReturn`,
   * `docs/api.md §«Material issues»`).
   *
   * Body — `ReturnMaterialIssueDto`:
   *   - `reason` (required, 2..500) — причина возврата;
   *   - `clientRequestId` (optional, 1..128) — UUID формы для
   *     идемпотентности повторного submit. UI передаёт всегда; для
   *     server-to-server можно опустить — sourceKey будет
   *     `MATERIAL_ISSUE_RETURN_FULL:<id>`.
   *
   * Возвращает `MaterialIssueReturnDetail` (без `sourceKey`).
   */
  @Post(':id/return')
  @HttpCode(HttpStatus.OK)
  return_(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ReturnMaterialIssueSchema))
    body: ReturnMaterialIssueDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.materialIssues.returnPostedIssue(id, body, user.employeeId);
  }
}
