import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import {
  CancelPayrollAccrualDocumentSchema,
  CreatePayrollAccrualDocumentSchema,
  PayPayrollAccrualDocumentSchema,
  PayrollAccrualDocumentListQuerySchema,
  UpdatePayrollAccrualDocumentLineSchema,
  type CancelPayrollAccrualDocumentDto,
  type CreatePayrollAccrualDocumentDto,
  type PayPayrollAccrualDocumentDto,
  type PayrollAccrualDocumentListQuery,
  type UpdatePayrollAccrualDocumentLineDto,
} from '@sewing/shared/payroll-accrual-documents';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, MachineScopes, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { PayrollAccrualDocumentsService } from './payroll-accrual-documents.service.js';

/**
 * Контроллер «Документ начисления зарплаты» (PHASE 3 STEP 6.2).
 *
 * Контракт — `docs/api.md §«Payroll accrual documents»`.
 *
 * Все endpoints доступны только `SHOP_MANAGER` / `ADMIN`.
 *
 * Endpoints:
 *   - `GET    /api/payroll/accrual-documents`                    — список;
 *   - `POST   /api/payroll/accrual-documents`                    — создать DRAFT;
 *   - `GET    /api/payroll/accrual-documents/:id`                — карточка со строками;
 *   - `POST   /api/payroll/accrual-documents/:id/recompute`      — пересчитать строки;
 *   - `PATCH  /api/payroll/accrual-documents/:id/lines/:lineId`  — скорр. строку;
 *   - `POST   /api/payroll/accrual-documents/:id/pay`            — провести (PAID);
 *   - `POST   /api/payroll/accrual-documents/:id/cancel`         — отменить (CANCELLED).
 */
/**
 * Машинный токен ERP: ведомость начислений — РАСЧЁТ цеха (правило владельца:
 * зарплату считает цех, деньги выдаёт ERP), поэтому список/карточка/расчёт/
 * корректировка/отмена открыты под `payroll:accrual:*`. Проведение — отдельный
 * скоуп `payroll:pay`: его ERP зовёт только по своей оплаченной заявке.
 */
@Roles('SHOP_MANAGER', 'ADMIN')
@MachineScopes('payroll:accrual:read')
@Controller('payroll/accrual-documents')
export class PayrollAccrualDocumentsController {
  constructor(private readonly svc: PayrollAccrualDocumentsService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(PayrollAccrualDocumentListQuerySchema))
    query: PayrollAccrualDocumentListQuery,
    @CurrentUser() user: AuthPrincipal | undefined,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.svc.list(query, user);
  }

  @MachineScopes('payroll:accrual:write')
  @Post()
  create(
    @Body(new ZodValidationPipe(CreatePayrollAccrualDocumentSchema))
    body: CreatePayrollAccrualDocumentDto,
    @CurrentUser() user: AuthPrincipal | undefined,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.svc.create(body, user);
  }

  @Get(':id')
  get(
    @Param('id') id: string,
    @CurrentUser() user: AuthPrincipal | undefined,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.svc.get(id, user);
  }

  @Roles('SHOP_MANAGER', 'ADMIN')
  @HttpCode(HttpStatus.OK)
  @MachineScopes('payroll:accrual:write')
  @Post(':id/recompute')
  recompute(
    @Param('id') id: string,
    @CurrentUser() user: AuthPrincipal | undefined,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.svc.recompute(id, user);
  }

  @Roles('SHOP_MANAGER', 'ADMIN')
  @HttpCode(HttpStatus.OK)
  @MachineScopes('payroll:accrual:write')
  @Patch(':id/lines/:lineId')
  updateLine(
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body(new ZodValidationPipe(UpdatePayrollAccrualDocumentLineSchema))
    body: UpdatePayrollAccrualDocumentLineDto,
    @CurrentUser() user: AuthPrincipal | undefined,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.svc.updateLine(id, lineId, body, user);
  }

  @Roles('SHOP_MANAGER', 'ADMIN')
  @HttpCode(HttpStatus.OK)
  @MachineScopes('payroll:pay')
  @Post(':id/pay')
  pay(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(PayPayrollAccrualDocumentSchema))
    body: PayPayrollAccrualDocumentDto,
    @CurrentUser() user: AuthPrincipal | undefined,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.svc.pay(id, user, body);
  }

  @Roles('SHOP_MANAGER', 'ADMIN')
  @HttpCode(HttpStatus.OK)
  @MachineScopes('payroll:accrual:write')
  @Post(':id/cancel')
  cancel(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(CancelPayrollAccrualDocumentSchema))
    body: CancelPayrollAccrualDocumentDto,
    @CurrentUser() user: AuthPrincipal | undefined,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.svc.cancel(id, body, user);
  }
}
