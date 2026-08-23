-- Расписание начисления зарплаты + дата закрытия заказа.
--
-- Зачем. Момент начисления в системе не настраивался вовсе: менеджер
-- руками ставил «Дату начисления» в форме документа, и внутрь падало
-- всё, что накопилось до этой даты. Бизнесу нужно другое правило —
-- «зарплата 15-го числа, и в расчёт идут только ЗАКРЫТЫЕ заказы».
--
-- Правило упиралось в то, что даты закрытия у заказа не было: есть
-- статус и `updatedAt`, который двигает любая правка. Поэтому здесь
-- две вещи сразу — колонка `Order.completedAt` и singleton-настройка
-- расписания.

-- 1. Дата закрытия заказа --------------------------------------------------
ALTER TABLE "Order" ADD COLUMN "completedAt" TIMESTAMP(3);

-- Бэкфилл. Для уже закрытых заказов лучшая доступная оценка — момент
-- закрытия ПОСЛЕДНЕЙ коробки заказа (упаковка и есть физическое
-- завершение), а если коробок нет (отменённые, старые данные) —
-- `updatedAt`. Без бэкфилла все исторические заказы выглядели бы
-- «никогда не закрытыми» и их сдельщина навсегда осталась бы
-- отложенной.
UPDATE "Order" o
SET "completedAt" = COALESCE(
  (
    SELECT MAX(b."closedAt")
    FROM "Box" b
    JOIN "BoxItem" bi ON bi."boxId" = b."id"
    JOIN "Passport" p ON p."id" = bi."passportId"
    WHERE p."orderId" = o."id" AND b."closedAt" IS NOT NULL
  ),
  o."updatedAt"
)
WHERE o."status" IN ('DONE', 'CANCELLED') AND o."completedAt" IS NULL;

CREATE INDEX "Order_completedAt_idx" ON "Order"("completedAt");

-- 2. Расписание начисления --------------------------------------------------
CREATE TYPE "PayrollCutoffBasis" AS ENUM (
  -- Сдельщина входит, только если ЗАКАЗ закрыт до дня начисления.
  'ORDER_COMPLETED',
  -- Платим по подтверждённой работе: закрытие коробки (`approvedAt`).
  'PASSPORT_PACKED',
  -- Поведение до расписания: всё начисленное до даты (`createdAt`).
  'WORK_DATE'
);

CREATE TABLE "PayrollAccrualSchedule" (
  "id" TEXT NOT NULL DEFAULT 'default',
  -- Пустой массив = расписание выключено: дата не подставляется,
  -- черновик автоматически не создаётся.
  "daysOfMonth" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
  "cutoffBasis" "PayrollCutoffBasis" NOT NULL DEFAULT 'ORDER_COMPLETED',
  "appliesToSewing" BOOLEAN NOT NULL DEFAULT true,
  -- Раскрой по умолчанию ВНЕ правила: раскройщик получает деньги при
  -- выпуске паспорта, задолго до закрытия заказа.
  "appliesToCutting" BOOLEAN NOT NULL DEFAULT false,
  "autoCreateDraft" BOOLEAN NOT NULL DEFAULT true,
  "runAtLocalTime" TEXT NOT NULL DEFAULT '03:00',
  "lastRunOn" DATE,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "updatedByEmployeeId" TEXT,
  CONSTRAINT "PayrollAccrualSchedule_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "PayrollAccrualSchedule"
  ADD CONSTRAINT "PayrollAccrualSchedule_updatedByEmployeeId_fkey"
  FOREIGN KEY ("updatedByEmployeeId") REFERENCES "Employee"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Singleton-строка со «выключенным» расписанием: поведение системы до
-- этой миграции сохраняется ровно до того момента, как менеджер задаст
-- дни начисления.
INSERT INTO "PayrollAccrualSchedule" ("id", "updatedAt")
VALUES ('default', NOW())
ON CONFLICT ("id") DO NOTHING;
