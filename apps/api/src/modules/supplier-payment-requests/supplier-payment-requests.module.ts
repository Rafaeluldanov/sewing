import { Module } from '@nestjs/common';
import { TreasuryModule } from '../treasury/treasury.module.js';
import { SupplierPaymentRequestNumberService } from './supplier-payment-request-number.service.js';
import { SupplierPaymentRequestsController } from './supplier-payment-requests.controller.js';
import { SupplierPaymentRequestsService } from './supplier-payment-requests.service.js';
import { SupplierPaymentRequestsStorageService } from './supplier-payment-requests-storage.service.js';

/**
 * Заявки на оплату поставщику (платёжный документ поверх закупочного
 * контура, см. `prisma/schema.prisma::SupplierPaymentRequest`).
 *
 * Заявка выписывается внутри `PurchaseOrder`, разбивается на этапы
 * оплаты (предоплата/остаток), к ней прикрепляются счёт/инвойс. При
 * создании по каждому этапу автоматически формируется черновик «заявки
 * на расход» в казначействе (`SupplierPayment`) — отсюда импорт
 * `TreasuryModule` (даёт `SupplierPaymentService`).
 */
@Module({
  imports: [TreasuryModule],
  controllers: [SupplierPaymentRequestsController],
  providers: [
    SupplierPaymentRequestsService,
    SupplierPaymentRequestNumberService,
    SupplierPaymentRequestsStorageService,
  ],
  exports: [SupplierPaymentRequestsService],
})
export class SupplierPaymentRequestsModule {}
