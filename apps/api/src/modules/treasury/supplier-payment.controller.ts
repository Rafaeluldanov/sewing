import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  CreateSupplierPaymentSchema,
  CancelSupplierPaymentSchema,
  ListSupplierPaymentsQuerySchema,
  type CreateSupplierPaymentDto,
  type CancelSupplierPaymentDto,
  type ListSupplierPaymentsQuery,
} from '@sewing/shared/treasury';

import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { SupplierPaymentService } from './supplier-payment.service.js';

/**
 * Контроллер «Оплаты поставщикам» (Фаза 1 казначейства).
 *
 *   GET  /api/treasury/supplier-payments
 *   GET  /api/treasury/supplier-payments/:id
 *   POST /api/treasury/supplier-payments
 *   POST /api/treasury/supplier-payments/:id/approve
 *   POST /api/treasury/supplier-payments/:id/pay
 *   POST /api/treasury/supplier-payments/:id/cancel
 *
 * RBAC — `ADMIN`/`SHOP_MANAGER`.
 */
@Controller('treasury/supplier-payments')
@Roles('ADMIN', 'SHOP_MANAGER')
export class SupplierPaymentController {
  constructor(private readonly payments: SupplierPaymentService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(ListSupplierPaymentsQuerySchema))
    query: ListSupplierPaymentsQuery,
  ) {
    return this.payments.list(query);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.payments.get(id);
  }

  @Post()
  create(
    @Body(new ZodValidationPipe(CreateSupplierPaymentSchema))
    body: CreateSupplierPaymentDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.payments.create(body, user.employeeId);
  }

  @Post(':id/approve')
  approve(@Param('id') id: string, @CurrentUser() user: AuthPrincipal) {
    return this.payments.approve(id, user.employeeId);
  }

  @Post(':id/pay')
  pay(@Param('id') id: string, @CurrentUser() user: AuthPrincipal) {
    return this.payments.pay(id, user.employeeId);
  }

  @Post(':id/cancel')
  cancel(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(CancelSupplierPaymentSchema))
    body: CancelSupplierPaymentDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.payments.cancel(id, body, user.employeeId);
  }
}
