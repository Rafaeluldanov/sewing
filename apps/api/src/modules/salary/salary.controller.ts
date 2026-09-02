import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ListSalaryQuerySchema,
  SalarySummaryQuerySchema,
  UpdateSalaryEntrySchema,
  type ListSalaryQuery,
  type SalarySummaryQuery,
  type UpdateSalaryEntryDto,
} from '@sewing/shared/salary';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, MachineScopes, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { SalaryService } from './salary.service.js';

/**
 * Контроллер модуля окладных начислений (post-Шаг 18 / Шаг 19,
 * ADR-0021). См. контракт в `docs/api.md §10a`.
 *
 *   GET   /api/salary           — список с фильтрами и пагинацией
 *   GET   /api/salary/summary   — агрегаты по периоду/сотруднику
 *   PATCH /api/salary/:id       — ручная корректировка (SHOP_MANAGER, ADMIN)
 *
 * RBAC видимости read-методов делается на уровне сервиса: менеджер
 * видит всё, остальные — только свои строки. Поэтому `@Roles(...)`
 * на GET-ы не вешаем — endpoint'ы открыты любой авторизованной роли,
 * а ограничение приходит из `applyViewerScope`.
 */
@Controller('salary')
// Только чтение: зарплату начисляет цех, ERP её показывает.
@MachineScopes('payroll:read')
export class SalaryController {
  constructor(private readonly salary: SalaryService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(ListSalaryQuerySchema))
    query: ListSalaryQuery,
    @CurrentUser() user: AuthPrincipal | undefined,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.salary.list(query, user);
  }

  @Get('summary')
  summary(
    @Query(new ZodValidationPipe(SalarySummaryQuerySchema))
    query: SalarySummaryQuery,
    @CurrentUser() user: AuthPrincipal | undefined,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.salary.summary(query, user);
  }

  /**
   * Ручная корректировка окладной записи. Только `SHOP_MANAGER`/`ADMIN`:
   * правка денежной суммы — операция повышенной чувствительности, и
   * RBAC-проверку дублируем здесь декоратором, а не только в сервисе.
   */
  @Roles('SHOP_MANAGER', 'ADMIN')
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateSalaryEntrySchema))
    body: UpdateSalaryEntryDto,
    @CurrentUser() user: AuthPrincipal | undefined,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.salary.updateManually(id, body, user);
  }
}
