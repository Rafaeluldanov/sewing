import { Controller, Get, Query } from '@nestjs/common';
import {
  EarningsSummaryQuerySchema,
  ListEarningsQuerySchema,
  type EarningsSummaryQuery,
  type ListEarningsQuery,
} from '@sewing/shared/earnings';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { EarningsService } from './earnings.service.js';

/**
 * Контроллер модуля начислений (Шаг 9 MVP). См. `docs/api.md §10`.
 *
 * Маршруты ровно те, что описаны в ТЗ Шага 9:
 *   - `GET /api/earnings`         — список с фильтрами и пагинацией;
 *   - `GET /api/earnings/summary` — агрегаты (totalApproved/Pending + counts).
 *
 * Просмотр начислений по конкретному паспорту вынесен в отдельный
 * контроллер `PassportEarningsController` (по аналогии с
 * `PassportDefectsController`), чтобы не размазывать ресурсный URL
 * `/api/passports/:id/...` по разным модулям и не тащить
 * `EarningsService` в `PassportsModule`.
 *
 * RBAC видимости: `SHOP_MANAGER` и `ADMIN` видят все строки и могут
 * фильтровать по любому `employeeId` / `status`. Все остальные роли
 * принудительно скоупятся в `EarningsService` на свой `employeeId` и
 * только на `APPROVED` (см. `docs/api.md §10` и ADR-0014). Сами
 * декораторы `@Roles(...)` мы здесь не ставим — endpoint доступен
 * любой авторизованной роли, ограничение делается на уровне данных.
 */
@Controller('earnings')
export class EarningsController {
  constructor(private readonly earnings: EarningsService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(ListEarningsQuerySchema))
    query: ListEarningsQuery,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.earnings.list(query, user);
  }

  @Get('summary')
  summary(
    @Query(new ZodValidationPipe(EarningsSummaryQuerySchema))
    query: EarningsSummaryQuery,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.earnings.summary(query, user);
  }
}
