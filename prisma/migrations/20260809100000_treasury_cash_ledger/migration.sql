-- Казначейство, Фаза 0: журнал движения денежных средств (ДДС).
-- Единая «книга денег» цеха — касса + расчётный счёт. Источник идей —
-- дизайн-контракт модуля «Казначейство» (fin.cash_flow_entry), урезанный
-- под один тенант: RUB-only, без мультивалюты/эквайринга/выписок/outbox.
--
-- Инварианты, перенесённые из контракта:
--   INV-7 (append-only + сторно): CashFlowEntry без UPDATE/DELETE; правка =
--     сторно-строка (isStorno=true, обратный direction, reversalOfId).
--   INV-4 (идемпотентность проводки): UNIQUE(registrarType, registrarId,
--     lineNo, isStorno) — повторное проведение документа не двоит движение.
-- Остаток счёта НЕ материализуется — считается как Σ(IN) − Σ(OUT) по журналу.

-- === ENUM-типы ===
CREATE TYPE "CashAccountKind" AS ENUM ('BANK', 'CASH');
CREATE TYPE "CashFlowDirection" AS ENUM ('IN', 'OUT');
CREATE TYPE "CashFlowSource" AS ENUM ('SUPPLIER_PAYMENT', 'PAYROLL_PAYOUT', 'CUSTOMER_INCOME', 'TRANSFER', 'ADJUSTMENT', 'OTHER');

-- === Счёт ДС (касса/расчётный счёт) ===
CREATE TABLE "CashAccount" (
    "id" TEXT NOT NULL,
    "kind" "CashAccountKind" NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'RUB',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CashAccount_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CashAccount_kind_idx" ON "CashAccount"("kind");
CREATE INDEX "CashAccount_isActive_idx" ON "CashAccount"("isActive");

-- === Статья ДДС (классификатор проводок) ===
CREATE TABLE "CashFlowItem" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "direction" "CashFlowDirection",
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CashFlowItem_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CashFlowItem_isActive_idx" ON "CashFlowItem"("isActive");

-- === Журнал движения ДС (append-only, источник истины) ===
CREATE TABLE "CashFlowEntry" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "direction" "CashFlowDirection" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "itemId" TEXT NOT NULL,
    "source" "CashFlowSource" NOT NULL DEFAULT 'OTHER',
    "sourceId" TEXT,
    "isStorno" BOOLEAN NOT NULL DEFAULT false,
    "reversalOfId" TEXT,
    "registrarType" TEXT NOT NULL,
    "registrarId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL DEFAULT 1,
    "note" TEXT,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "postedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CashFlowEntry_pkey" PRIMARY KEY ("id")
);

-- INV-4: идемпотентность проводки (сторно сосуществует с оригиналом — isStorno в ключе)
CREATE UNIQUE INDEX "CashFlowEntry_registrarType_registrarId_lineNo_isStorno_key" ON "CashFlowEntry"("registrarType", "registrarId", "lineNo", "isStorno");
CREATE INDEX "CashFlowEntry_accountId_postedAt_idx" ON "CashFlowEntry"("accountId", "postedAt");
CREATE INDEX "CashFlowEntry_itemId_postedAt_idx" ON "CashFlowEntry"("itemId", "postedAt");
CREATE INDEX "CashFlowEntry_source_sourceId_idx" ON "CashFlowEntry"("source", "sourceId");
CREATE INDEX "CashFlowEntry_postedAt_idx" ON "CashFlowEntry"("postedAt");

-- === Внешние ключи ===
ALTER TABLE "CashFlowEntry" ADD CONSTRAINT "CashFlowEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CashAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CashFlowEntry" ADD CONSTRAINT "CashFlowEntry_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "CashFlowItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CashFlowEntry" ADD CONSTRAINT "CashFlowEntry_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "CashFlowEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CashFlowEntry" ADD CONSTRAINT "CashFlowEntry_postedById_fkey" FOREIGN KEY ("postedById") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
