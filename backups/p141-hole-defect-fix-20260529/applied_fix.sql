BEGIN;

-- 1. Add 2 HOLE defects on 22.05.2026 by Муродалиева Угилой (SEAMSTRESS, was working ОВР/ФУЛ that day)
INSERT INTO "PassportDefect"(id, "passportId", "defectTypeId", qty, "createdByEmployeeId", "createdAt", comment) VALUES
  ('cmp29may26hole001fix0a001', 'cmosoqogw00iwmisw9ikcw6ws', 'fcc21371-fd36-4cce-9917-c7b3fee32813', 1, 'cmorj3puc003unwz8ej3hmxzi', '2026-05-22 18:00:00', NULL),
  ('cmp29may26hole002fix0a002', 'cmosoqogw00iwmisw9ikcw6ws', 'fcc21371-fd36-4cce-9917-c7b3fee32813', 1, 'cmorj3puc003unwz8ej3hmxzi', '2026-05-22 18:00:01', NULL);

-- 2. Add 2 DEFECT_RECORDED events (one per defect row)
INSERT INTO "PassportEvent"(id, "passportId", type, "operationId", "employeeId", "defectQty", "createdAt") VALUES
  ('cmp29may26hole001evt0a001', 'cmosoqogw00iwmisw9ikcw6ws', 'DEFECT_RECORDED', 'cmord6c8700057ay5prw5mmff', 'cmorj3puc003unwz8ej3hmxzi', 1, '2026-05-22 18:00:00'),
  ('cmp29may26hole002evt0a002', 'cmosoqogw00iwmisw9ikcw6ws', 'DEFECT_RECORDED', 'cmord6c8700057ay5prw5mmff', 'cmorj3puc003unwz8ej3hmxzi', 1, '2026-05-22 18:00:01');

-- 3. Update Passport quantities (qtyCut=14 invariant: 11 + 3 = 14)
UPDATE "Passport"
SET "qtyDefect" = 3, "qtyGood" = 11, "updatedAt" = NOW()
WHERE id = 'cmosoqogw00iwmisw9ikcw6ws';

-- 4. Recompute piece-rate OperationEntry rows to qty=11 (=new qtyGood)
UPDATE "OperationEntry" SET qty=11, amount=ROUND(11 * "ratePerUnit", 2)
WHERE id IN (
  'cmpiashkt00x1taiuweg7tj16',  -- Муродалиева ОВР/ФУЛ:   14 → 11, 700 → 550
  'cmpjx83f003ertaiultzkfpmz',  -- Талайбекова КИПЕРКА:  14 → 11, 210 → 165
  'cmpl82uzv04kytaiur2aiod95',  -- Эсенгелдиева РАСПОШИВ: 14 → 11, 280 → 220
  'cmppjjwr500m13vqvhb55d4x7'   -- Жениш ВТО:            13 → 11, 156 → 132
);

-- Sanity checks before commit
SELECT id, number, "qtyPlan", "qtyCut", "qtyGood", "qtyDefect" FROM "Passport" WHERE id='cmosoqogw00iwmisw9ikcw6ws';
SELECT pd.id, pd.qty, dt.code, pd."createdByEmployeeId", pd."createdAt" FROM "PassportDefect" pd JOIN "DefectType" dt ON dt.id=pd."defectTypeId" WHERE pd."passportId"='cmosoqogw00iwmisw9ikcw6ws' ORDER BY pd."createdAt";
SELECT id, type, "createdAt", "employeeId", "operationId", "defectQty" FROM "PassportEvent" WHERE "passportId"='cmosoqogw00iwmisw9ikcw6ws' AND type='DEFECT_RECORDED' ORDER BY "createdAt";
SELECT oe.id, oe.qty, oe."ratePerUnit", oe.amount, oe.status, e."fullName", o.code AS op FROM "OperationEntry" oe JOIN "Operation" o ON o.id=oe."operationId" JOIN "Employee" e ON e.id=oe."employeeId" WHERE oe."passportId"='cmosoqogw00iwmisw9ikcw6ws' ORDER BY oe."createdAt";

COMMIT;
