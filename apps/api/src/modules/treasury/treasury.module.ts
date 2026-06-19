import { Module } from '@nestjs/common';
import { TreasuryController } from './treasury.controller.js';
import { TreasuryService } from './treasury.service.js';
import { SupplierPaymentController } from './supplier-payment.controller.js';
import { SupplierPaymentService } from './supplier-payment.service.js';
import { ExpensePaymentNumberService } from './expense-payment-number.service.js';

/**
 * Модуль «Казначейство» (Фаза 0 — журнал движения денежных средств).
 *
 * Единая «книга денег» цеха: касса + расчётный счёт, append-only журнал
 * `CashFlowEntry` (источник истины «где деньги»), статьи ДДС и счета.
 * Контракт REST — `treasury.controller.ts`, бизнес-логика —
 * `treasury.service.ts`. RBAC — `ADMIN`/`SHOP_MANAGER`.
 *
 * Граница: модуль ведёт ТОЛЬКО движение денег. Атрибуцию затрат на заказ
 * (себестоимость) ведёт отдельный модуль `costs` — он будет потреблять
 * факт платежа, а не писать проводки (односторонняя связь, см.
 * дизайн-контракт §1.2). Расход поставщикам/зарплата — Фаза 1.
 *
 * Сервис экспортируется, чтобы будущие документы Фазы 1
 * (`SupplierPayment`, привязка `PayrollPayout`) могли проводить движение
 * ДС через `TreasuryService` в своей транзакции.
 */
@Module({
  controllers: [TreasuryController, SupplierPaymentController],
  providers: [
    TreasuryService,
    SupplierPaymentService,
    ExpensePaymentNumberService,
  ],
  exports: [TreasuryService, SupplierPaymentService],
})
export class TreasuryModule {}
