-- Заявки на оплату поставщику (этап «Заявки на оплату»).
-- Платёжный документ ПОВЕРХ закупочного контура: внутри PurchaseOrder
-- выписывается заявка «оплатить поставщику сумму по реквизитам, разбив
-- на этапы (предоплата 30% / остаток 70% и т.п.)». Вышестоящий документ
-- относительно казначейской SupplierPayment — каждый этап на следующем
-- шаге «забирается» казначейством (soft-крюк stage.supplierPaymentId).
--
-- Связь с PurchaseOrder — hard-FK (ON DELETE CASCADE): заявка живёт
-- внутри PO. Связь с Supplier — SOFT (id + snapshot, без FK), как у
-- SupplierPayment. Реквизиты копируются в заявку снимком и там
-- редактируемы.

-- === Реквизиты в карточке поставщика ===
ALTER TABLE "Supplier" ADD COLUMN "legalName" TEXT;
ALTER TABLE "Supplier" ADD COLUMN "inn" TEXT;
ALTER TABLE "Supplier" ADD COLUMN "kpp" TEXT;
ALTER TABLE "Supplier" ADD COLUMN "bankName" TEXT;
ALTER TABLE "Supplier" ADD COLUMN "bankAccount" TEXT;
ALTER TABLE "Supplier" ADD COLUMN "bankBik" TEXT;
ALTER TABLE "Supplier" ADD COLUMN "bankCorrAccount" TEXT;

-- === Заявка на оплату (шапка) ===
CREATE TABLE "SupplierPaymentRequest" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "supplierNameSnapshot" TEXT NOT NULL,
    "legalNameSnapshot" TEXT,
    "innSnapshot" TEXT,
    "kppSnapshot" TEXT,
    "bankNameSnapshot" TEXT,
    "bankAccountSnapshot" TEXT,
    "bankBikSnapshot" TEXT,
    "bankCorrAccountSnapshot" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "comment" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SupplierPaymentRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SupplierPaymentRequest_number_key" ON "SupplierPaymentRequest"("number");
CREATE INDEX "SupplierPaymentRequest_purchaseOrderId_idx" ON "SupplierPaymentRequest"("purchaseOrderId");
CREATE INDEX "SupplierPaymentRequest_supplierId_idx" ON "SupplierPaymentRequest"("supplierId");
CREATE INDEX "SupplierPaymentRequest_status_createdAt_idx" ON "SupplierPaymentRequest"("status", "createdAt");

-- === Этап оплаты ===
CREATE TABLE "SupplierPaymentRequestStage" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "percent" DECIMAL(7,4) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "plannedPayDate" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "supplierPaymentId" TEXT,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SupplierPaymentRequestStage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SupplierPaymentRequestStage_requestId_sortOrder_idx" ON "SupplierPaymentRequestStage"("requestId", "sortOrder");

-- === Вложение заявки (счёт/инвойс + доп. документы) ===
CREATE TABLE "SupplierPaymentRequestFile" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "originalFileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SupplierPaymentRequestFile_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SupplierPaymentRequestFile_requestId_idx" ON "SupplierPaymentRequestFile"("requestId");

-- === FK ===
ALTER TABLE "SupplierPaymentRequest" ADD CONSTRAINT "SupplierPaymentRequest_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupplierPaymentRequestStage" ADD CONSTRAINT "SupplierPaymentRequestStage_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "SupplierPaymentRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupplierPaymentRequestFile" ADD CONSTRAINT "SupplierPaymentRequestFile_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "SupplierPaymentRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
