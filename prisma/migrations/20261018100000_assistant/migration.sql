-- Фича «Ассистент (ИИ)» — окно диалога в админке, этап 0 (только чтение).
--
-- Две части:
--   1. Настройки — доливаются в существующую singleton-строку
--      `IntegrationSettings` (одна связка с внешним сервисом на тенант),
--      рядом с настройками upgifts. Отдельной таблицы фича не заводит.
--   2. История диалогов — `AssistantThread` / `AssistantMessage`. Нужна
--      для многоходового диалога, для суточного лимита и месячного
--      потолка расхода, и для разбора полётов по конкретному ответу.
--
-- Дефолты подобраны так, чтобы миграция НИЧЕГО не включала: на
-- существующих установках ассистент остаётся выключенным, а деньги и
-- зарплата закрыты даже после включения — их открывают руками.
--
-- См. `prisma/schema.prisma::IntegrationSettings`,
-- `packages/shared/src/assistant.ts`,
-- `apps/api/src/modules/assistant/*`.

-- 1. Настройки ассистента ----------------------------------------------------

ALTER TABLE "IntegrationSettings"
  ADD COLUMN "assistantEnabled"            BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "assistantKeySource"          TEXT    NOT NULL DEFAULT 'PLATFORM',
  ADD COLUMN "assistantApiKeyEnc"          TEXT,
  ADD COLUMN "assistantModel"              TEXT    NOT NULL DEFAULT 'claude-opus-5',
  ADD COLUMN "assistantDailyLimitPerUser"  INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN "assistantMonthlyBudgetCents" INTEGER NOT NULL DEFAULT 10000,
  ADD COLUMN "assistantScopeProduction"    BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "assistantScopeSupply"        BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "assistantScopeMoney"         BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "assistantScopePayroll"       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "assistantLastCheckOkAt"      TIMESTAMP(3),
  ADD COLUMN "assistantLastCheckError"     TEXT;

-- 2. История диалогов --------------------------------------------------------

CREATE TYPE "AssistantMessageRole" AS ENUM ('USER', 'ASSISTANT');

CREATE TABLE "AssistantThread" (
  "id"         TEXT NOT NULL,
  "employeeId" TEXT NOT NULL,
  "title"      TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AssistantThread_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AssistantThread_employeeId_createdAt_idx"
  ON "AssistantThread"("employeeId", "createdAt");

CREATE TABLE "AssistantMessage" (
  "id"                TEXT NOT NULL,
  "threadId"          TEXT NOT NULL,
  "employeeId"        TEXT NOT NULL,
  "role"              "AssistantMessageRole" NOT NULL,
  "content"           TEXT NOT NULL,
  "toolCalls"         JSONB,
  "sources"           JSONB,
  "model"             TEXT,
  "inputTokens"       INTEGER,
  "cachedInputTokens" INTEGER,
  "outputTokens"      INTEGER,
  "costUsdMicros"     INTEGER,
  "errorCode"         TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AssistantMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AssistantMessage_threadId_createdAt_idx"
  ON "AssistantMessage"("threadId", "createdAt");

-- Индекс под суточный лимит: «сколько вопросов задал сотрудник X с начала
-- московских суток» — самый частый запрос модуля.
CREATE INDEX "AssistantMessage_employeeId_createdAt_idx"
  ON "AssistantMessage"("employeeId", "createdAt");

ALTER TABLE "AssistantMessage"
  ADD CONSTRAINT "AssistantMessage_threadId_fkey"
  FOREIGN KEY ("threadId") REFERENCES "AssistantThread"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
