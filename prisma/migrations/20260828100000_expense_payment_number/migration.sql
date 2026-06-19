-- Номер заявки на расход (SupplierPayment) вида ПРЕФИКС-YYYYMMDD-NNNN:
-- ЗП- для выплаты зарплаты, РС- для расхода поставщику (зеркало PR- у
-- SupplierPaymentRequest). Nullable для старых строк; новые получают номер.
ALTER TABLE "SupplierPayment" ADD COLUMN "number" TEXT;

-- Бэкфилл номеров существующим заявкам: суточный счётчик на (kind, дата UTC),
-- порядок по createdAt. Так уже выданные зарплатные/поставщицкие заявки
-- получают человекочитаемые номера, а live-генератор продолжит с max+1.
UPDATE "SupplierPayment" sp
SET number = (
  CASE n.kind
    WHEN 'SALARY' THEN 'ЗП-'
    WHEN 'SUPPLIER' THEN 'РС-'
  END
  || n.d || '-' || lpad(n.seq::text, 4, '0')
)
FROM (
  SELECT
    id,
    kind,
    to_char("createdAt", 'YYYYMMDD') AS d,
    row_number() OVER (
      PARTITION BY kind, to_char("createdAt", 'YYYYMMDD')
      ORDER BY "createdAt", id
    ) AS seq
  FROM "SupplierPayment"
  WHERE number IS NULL
) n
WHERE sp.id = n.id;

CREATE UNIQUE INDEX "SupplierPayment_number_key" ON "SupplierPayment"("number");
