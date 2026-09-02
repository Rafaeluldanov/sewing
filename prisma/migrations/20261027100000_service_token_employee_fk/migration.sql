-- FK служебного сотрудника машинного токена (правило §0.1): SetNull.
--
-- Без ключа удаление учётки «Интеграция ERP» из админки оставляло бы висячий id, и каждая
-- запись из ERP падала бы на внешнем ключе навсегда. С SetNull колонка обнуляется, и учётка
-- пересоздаётся при следующем запросе токена. Существующих строк — одна, значение валидно.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ServiceToken_employeeId_fkey'
  ) THEN
    ALTER TABLE "ServiceToken"
      ADD CONSTRAINT "ServiceToken_employeeId_fkey"
      FOREIGN KEY ("employeeId") REFERENCES "Employee"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "ServiceToken_employeeId_idx" ON "ServiceToken"("employeeId");
