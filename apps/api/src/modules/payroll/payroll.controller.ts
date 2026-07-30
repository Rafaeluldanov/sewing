import {
  Controller,
  Get,
  Param,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import {
  PayrollDailyQuerySchema,
  PayrollDebtsQuerySchema,
  PayrollEmployeeQuerySchema,
  PayrollPeriodQuerySchema,
  type PayrollDailyQuery,
  type PayrollDebtsQuery,
  type PayrollEmployeeQuery,
  type PayrollPeriodQuery,
} from '@sewing/shared/payroll';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { PayrollService } from './payroll.service.js';

/**
 * Контроллер модуля Payroll (PHASE 1, read-only).
 *
 * Контракт — `docs/api.md §31a`. Бизнес-правила —
 * `docs/domain.md §10.6`. Экранов — `docs/screens.md §12a`.
 *
 * Endpoints:
 *   - `GET /api/payroll/period`             — ведомость по сотрудникам;
 *   - `GET /api/payroll/daily`              — снимок «кто сегодня работал»;
 *   - `GET /api/payroll/employees/:id`      — карточка сотрудника.
 *
 * RBAC: только `SHOP_MANAGER` и `ADMIN`. Все остальные роли по-прежнему
 * ходят за личной зарплатой через `/api/earnings` и `/api/salary` —
 * там скоуп режется в самом сервисе. Payroll API сознательно
 * жёстче — это **управленческая** ведомость, не личный кабинет.
 *
 * `@Roles(...)` дублирует RBAC-policy `PAYROLL_MANAGER_ROLES`, чтобы
 * декоратор был источником истины для `RolesGuard`. Дополнительная
 * страховка `if (!user) throw UnauthorizedException()` — на случай
 * public-шортката в `AuthGuard`.
 */
@Controller('payroll')
@Roles('SHOP_MANAGER', 'ADMIN')
export class PayrollController {
  constructor(private readonly payroll: PayrollService) {}

  @Get('period')
  period(
    @Query(new ZodValidationPipe(PayrollPeriodQuerySchema))
    query: PayrollPeriodQuery,
    @CurrentUser() user: AuthPrincipal | undefined,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.payroll.period(query);
  }

  @Get('daily')
  daily(
    @Query(new ZodValidationPipe(PayrollDailyQuerySchema))
    query: PayrollDailyQuery,
    @CurrentUser() user: AuthPrincipal | undefined,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.payroll.daily(query);
  }

  /**
   * Управленческий отчёт задолженности по сотрудникам (PHASE 3 STEP 7).
   *
   * Показывает кому сколько должны на выбранную дату (по умолчанию — сегодня).
   * `CANCELLED` выплаты не учитываются.
   * `debtRub = max(0, accruedGrossRub − payoutCoveredRub)` — базовый долг.
   */
  @Get('debts')
  debts(
    @Query(new ZodValidationPipe(PayrollDebtsQuerySchema))
    query: PayrollDebtsQuery,
    @CurrentUser() user: AuthPrincipal | undefined,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.payroll.debts(query);
  }

  @Get('employees/:id')
  employee(
    @Param('id') id: string,
    @Query(new ZodValidationPipe(PayrollEmployeeQuerySchema))
    query: PayrollEmployeeQuery,
    @CurrentUser() user: AuthPrincipal | undefined,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.payroll.employeeDetail(id, query);
  }
}
