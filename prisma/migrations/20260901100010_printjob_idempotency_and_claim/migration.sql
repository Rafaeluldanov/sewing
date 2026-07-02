-- Защита от повторной печати паспортов. Две части:
--
--   1. `idempotencyKey` — идемпотентный ключ клиента. Если два
--      одинаковых `POST /print-jobs` придут с одним ключом (двойная
--      доставка/ретрай транспорта), второй вернёт уже созданный job, а
--      не создаст новый. Уникален глобально; NULL-ы в Postgres не
--      конфликтуют, поэтому старые строки и bulk-батчи без ключа
--      остаются валидными.
--
--   2. `sentAt` — когда агент захватил job (PENDING → SENT). Нужен
--      свиперу в `PrintJobsService.pollForAgent`, чтобы находить
--      «зависшие» SENT (агент умер, не подтвердив результат) и
--      переводить их в FAILED — вслепую документ не перепечатывается.
--
-- Индекс `(status, sentAt)` обслуживает свип зависших SENT.

ALTER TABLE "PrintJob" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "PrintJob" ADD COLUMN "sentAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "PrintJob_idempotencyKey_key" ON "PrintJob"("idempotencyKey");
CREATE INDEX "PrintJob_status_sentAt_idx" ON "PrintJob"("status", "sentAt");
