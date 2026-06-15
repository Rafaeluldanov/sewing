-- Казначейство, Фаза 1: оплата поставщику (SupplierPayment).
-- Документ «санкционировал → оплатил» поверх закупочного контура.
-- Жизненный цикл DRAFT → APPROVED → PAID; на PAID атомарно пишется
-- проводка журнала ДДС (CashFlowEntry, source=SUPPLIER_PAYMENT,
-- registrarType='SUPPLIER_PAYMENT', registrarId=payment.id) — повторная
-- оплата ловится unique-индексом журнала (INV-4).
--
-- Связи с Supplier/PurchaseOrder — SOFT (id + snapshot, без FK):
-- закупочный контур не связываем с казначейским жёстко (как
-- settlement_object в дизайн-контракте). FK ставим только на
-- казначейские справочники: счёт (CashAccount) и статью ДДС
-- (CashFlowItem), ON DELETE RESTRICT.

-- === ENUM ===
CREATE TYPE "SupplierPaymentStatus" AS ENUM ('DRAFT', 'APPROVED', 'PAID', 'CANCELLED');

-- === Документ оплаты поставщику ===
CREATE TABLE "SupplierPayment" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "supplierNameSnapshot" TEXT NOT NULL,
    "purchaseOrderId" TEXT,
    "purchaseOrderNumberSnapshot" TEXT,
    "accountId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "status" "SupplierPaymentStatus" NOT NULL DEFAULT 'DRAFT',
    "comment" TEXT,
    "cashFlowEntryId" TEXT,
    "createdById" TEXT,
    "approvedById" TEXT,
    "paidById" TEXT,
    "cancelledById" TEXT,
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SupplierPayment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SupplierPayment_supplierId_idx" ON "SupplierPayment"("supplierId");
CREATE INDEX "SupplierPayment_purchaseOrderId_idx" ON "SupplierPayment"("purchaseOrderId");
CREATE INDEX "SupplierPayment_status_createdAt_idx" ON "SupplierPayment"("status", "createdAt");

ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CashAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "CashFlowItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
