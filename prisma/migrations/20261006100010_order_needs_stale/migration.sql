-- Отметка «потребность устарела»: спецификация изменилась, а пересчёт не прошёл.
--
-- Пересчёт потребности зовётся best-effort и молча пропускается в трёх случаях
-- (нет статуса CALCULATION / вариант не отправлен на расчёт / закупщик уже
-- тронул строки и force:false бросает WorkshopNeedsAlreadyReviewedException).
-- Насильно пересчитывать нельзя — это затрёт цену и статус закупщика, поэтому
-- расхождение делаем видимым, а пересчёт — явным действием.
--
-- Nullable без DEFAULT: NULL = потребность актуальна, как и было до сих пор.

ALTER TABLE "Order" ADD COLUMN "needsStaleAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "needsStaleReason" TEXT;
