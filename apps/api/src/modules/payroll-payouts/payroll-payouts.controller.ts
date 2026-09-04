import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import {
  AckPayrollPayoutSchema,
  CancelPayrollPayoutSchema,
  CreatePayrollPayoutSchema,
  IssuePayrollPayoutSchema,
  PayrollPayoutListQuerySchema,
  RecomputePayrollPayoutSchema,
  type AckPayrollPayoutDto,
  type CancelPayrollPayoutDto,
  type CreatePayrollPayoutDto,
  type IssuePayrollPayoutDto,
  type PayrollPayoutListQuery,
  type RecomputePayrollPayoutDto,
} from '@sewing/shared/payroll-payouts';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, MachineScopes, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { PayrollPayoutsService } from './payroll-payouts.service.js';

/**
 * Контроллер «Выплаты зарплаты» (PHASE 3 STEP 2).
 *
 * Контракт — `docs/api.md §«Payroll payouts»`.
 *
 * Endpoints:
 *   - `GET    /api/payroll/payouts`              — список (RBAC скоуп в сервисе);
 *   - `POST   /api/payroll/payouts`              — создать DRAFT (manager/admin);
 *   - `GET    /api/payroll/payouts/:id`          — карточка (RBAC скоуп в сервисе);
 *   - `POST   /api/payroll/payouts/:id/recompute` — пересобрать строки (manager/admin);
 *   - `POST   /api/payroll/payouts/:id/issue`     — выдать (manager/admin);
 *   - `POST   /api/payroll/payouts/:id/ack`       — подтвердить (только сам сотрудник);
 *   - `POST   /api/payroll/payouts/:id/cancel`    — отменить (manager/admin).
 *
 * Класс-уровень `@Roles(...)` сознательно НЕ ставим — у части ручек
 * RBAC «любая авторизованная роль» (видит свои выплаты, подтверждает
 * свои выплаты), у части — только менеджер. Декоратор повешен на
 * конкретные методы.
 */
@Controller('payroll/payouts')
export class PayrollPayoutsController {
  constructor(private readonly payouts: PayrollPayoutsService) {}

  // Правило §0.2 (ERP): деньги выдаёт ERP по оплаченной заявке. Чтобы сверить «начислено
  // в цехе — выплачено в ERP», ей нужно видеть выплаты цеха.
  @MachineScopes('payroll:read')
  @Get()
  list(
    @Query(new ZodValidationPipe(PayrollPayoutListQuerySchema))
    query: PayrollPayoutListQuery,
    @CurrentUser() user: AuthPrincipal | undefined,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.payouts.list(query, user);
  }

  @Roles('SHOP_MANAGER', 'ADMIN')
  @Post()
  create(
    @Body(new ZodValidationPipe(CreatePayrollPayoutSchema))
    body: CreatePayrollPayoutDto,
    @CurrentUser() user: AuthPrincipal | undefined,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.payouts.create(body, user);
  }

  @MachineScopes('payroll:read')
  @Get(':id')
  get(
    @Param('id') id: string,
    @CurrentUser() user: AuthPrincipal | undefined,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.payouts.get(id, user);
  }

  @Roles('SHOP_MANAGER', 'ADMIN')
  @HttpCode(HttpStatus.OK)
  @Post(':id/recompute')
  recompute(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RecomputePayrollPayoutSchema))
    _body: RecomputePayrollPayoutDto,
    @CurrentUser() user: AuthPrincipal | undefined,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.payouts.recompute(id, user);
  }

  @Roles('SHOP_MANAGER', 'ADMIN')
  @HttpCode(HttpStatus.OK)
  @Post(':id/issue')
  issue(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(IssuePayrollPayoutSchema))
    _body: IssuePayrollPayoutDto,
    @CurrentUser() user: AuthPrincipal | undefined,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.payouts.issue(id, user);
  }

  /**
   * `POST /api/payroll/payouts/:id/ack`. Любая авторизованная роль —
   * RBAC-скоуп «только владелец» проверяется в сервисе. На уровне
   * декоратора `@Roles(...)` НЕ ставим: менеджер тоже формально
   * мог бы прислать запрос, но сервис ему ответит 403, если
   * `viewer.employeeId` не совпадает с `payout.employeeId`.
   */
  @HttpCode(HttpStatus.OK)
  @Post(':id/ack')
  ack(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(AckPayrollPayoutSchema))
    _body: AckPayrollPayoutDto,
    @CurrentUser() user: AuthPrincipal | undefined,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.payouts.ack(id, user);
  }

  @Roles('SHOP_MANAGER', 'ADMIN')
  @HttpCode(HttpStatus.OK)
  @Post(':id/cancel')
  cancel(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(CancelPayrollPayoutSchema))
    body: CancelPayrollPayoutDto,
    @CurrentUser() user: AuthPrincipal | undefined,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.payouts.cancel(id, body, user);
  }
}
