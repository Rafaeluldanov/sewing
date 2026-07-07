-- Модуль «Интеграции» (флаг FEATURE_ERP_INTEGRATION): singleton-настройки
-- подключения к внешнему ERP upgifts (erp.upgifts.ru). См.
-- docs/upgifts-integration.md.
--
-- Строго АДДИТИВНО: одна новая таблица, ничего существующего не трогается.
-- Откат = выключить флаг (таблица просто не читается).
--
-- Пароль сервисного аккаунта хранится в `upgiftsPasswordEnc` ЗАШИФРОВАННЫМ
-- (AES-256-GCM на env INTEGRATION_SECRET_KEY) — плейнтекст-пароля к чужой
-- системе в БД нет.

-- CreateTable
CREATE TABLE "IntegrationSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "singleton" BOOLEAN NOT NULL DEFAULT true,
    "upgiftsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "upgiftsBaseUrl" TEXT,
    "upgiftsTenant" TEXT,
    "upgiftsEmail" TEXT,
    "upgiftsPasswordEnc" TEXT,
    "upgiftsOrganizationId" TEXT,
    "lastConnectionOkAt" TIMESTAMP(3),
    "lastConnectionError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (singleton-инвариант: максимум одна строка)
CREATE UNIQUE INDEX "IntegrationSettings_singleton_key" ON "IntegrationSettings"("singleton");
