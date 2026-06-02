-- Рулонный выпуск паспортов помощником раскройщика.
--
-- `Passport.rollOrdinal` — порядковый номер рулона (`CuttingTaskRoll.ordinal`),
-- по которому выпущен паспорт через `POST /api/passports/release-from-rolls`.
-- По паре `(orderId, sizeId, rollOrdinal)` определяется, какие рулоны размера
-- уже выпущены (идемпотентность + кейс «сломался принтер, продолжить с рулона»).
--
-- Nullable: у паспортов старой ручной формы и исторических данных остаётся
-- NULL. FK на `CuttingTaskRoll` сознательно не ставим — строки рулонов
-- пересоздаются при каждом сохранении задачи раскройщика, `ordinal` стабилен
-- после статуса `DONE`. IF NOT EXISTS — идемпотентно для dev.
ALTER TABLE "Passport" ADD COLUMN IF NOT EXISTS "rollOrdinal" INTEGER;

CREATE INDEX IF NOT EXISTS "Passport_orderId_sizeId_rollOrdinal_idx"
    ON "Passport"("orderId", "sizeId", "rollOrdinal");
