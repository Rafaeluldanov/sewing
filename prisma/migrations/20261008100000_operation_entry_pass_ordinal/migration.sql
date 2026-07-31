-- Повторы операции в маршруте заказа: одна и та же операция может стоять в
-- маршруте несколько раз (чередующиеся ОТК/ВТО между швейными шагами), и
-- паспорт проходит её столько же раз. Каждый проход — отдельное сдельное
-- начисление, поэтому номер прохода входит в ключ идемпотентности: без него
-- второй проход упирался бы в @@unique первого, P2002 гасился бы в
-- `EarningsService.safeCreate`, и работа осталась бы неоплаченной.
--
-- `passOrdinal` = порядковый номер вхождения операции в маршрут (0 — первое).
-- DEFAULT 0 сознательный: все существующие строки относятся к первому (и
-- единственному) вхождению, поэтому старый ключ переходит в новый один в один
-- и повторных начислений по уже закрытым паспортам не появляется.

-- DropIndex
DROP INDEX "OperationEntry_passportId_operationId_employeeId_sourceEven_key";

-- AlterTable
ALTER TABLE "OperationEntry" ADD COLUMN     "passOrdinal" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE UNIQUE INDEX "OperationEntry_passportId_operationId_employeeId_sourceEven_key" ON "OperationEntry"("passportId", "operationId", "employeeId", "sourceEventType", "passOrdinal");
