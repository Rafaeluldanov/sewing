-- Казначейство: настройки модуля (singleton, как CompanySettings).
-- Хранит «зарплатный» счёт и статью ДДС по умолчанию. Если оба заданы,
-- выдача PayrollPayout (ISSUED) пишет расходную проводку журнала ДС;
-- если нет — выдача работает как раньше (опт-ин, без регрессии).
-- Связи с CashAccount/CashFlowItem — soft (без FK), валидируются в сервисе.

CREATE TABLE "TreasurySettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "singleton" BOOLEAN NOT NULL DEFAULT true,
    "salaryAccountId" TEXT,
    "salaryItemId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TreasurySettings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TreasurySettings_singleton_key" ON "TreasurySettings"("singleton");
