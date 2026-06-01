-- 2026-06-01: ручная фиксация 1 брака «Пятно» (STAIN) по паспорту
-- P-20260511-0118 + пересчёт сдельной выработки всем сдельным.
--
-- Контекст. По просьбе пользователя нужно зафиксировать 1 шт брака
-- типа «Пятно» и пересчитать зарплату: при браке у всех сдельных
-- выработка по паспорту приводится к новому qtyGood (раскройщик не
-- трогается). Это ровно то, что делает API-путь
-- QcService.recordDefect + EarningsService.reconcileToQtyGood
-- (apps/api/src/modules/qc/qc.service.ts:634,
--  apps/api/src/modules/earnings/earnings.service.ts:932),
-- воспроизведённый здесь в SQL, т.к. паспорт IN_PROGRESS и проще
-- довести руками задним числом, чем дёргать API с сессией ОТК.
--
-- Состояние ДО: qtyCut=24, qtyDefect=0, qtyGood=24, IN_PROGRESS.
-- Сдельные начисления (все PENDING_RELEASE, ни одно не выплачено):
--   02 Рыскулова Чынара   qty24 rate50.00 amount1200.00
--   04 Эсенгелдиева Динара qty24 rate20.00 amount480.00
--   03 Талайбекова Жанара  qty24 rate15.00 amount360.00
-- Раскройщика (PASSPORT_CREATED) среди начислений нет — пересчёт его
-- бы и не коснулся.
--
-- Этот патч:
--   1) PassportDefect(STAIN, qty=1, актор = Турдибекова Ситора, QC —
--      основной фиксатор брака на проде);
--   2) Passport: qtyDefect 0→1, qtyGood 24→23;
--   3) PassportEvent(DEFECT_RECORDED) на текущей операции, payload как
--      в API;
--   4) reconcileToQtyGood: все сдельные (sourceEventType != PASSPORT_CREATED)
--      с qty > 23 → qty=23, amount = ratePerUnit*23. Выплаченные строки
--      (PayrollPayoutLine) пропускаются — таких нет.
-- Ожидаемые суммы ПОСЛЕ: 02→1150.00, 04→460.00, 03→345.00.

BEGIN;

-- guard: применяем только если состояние то самое, что мы ожидали
DO $$
DECLARE v_qty_good int; v_qty_defect int; v_status text;
BEGIN
  SELECT "qtyGood", "qtyDefect", status::text
    INTO v_qty_good, v_qty_defect, v_status
  FROM "Passport" WHERE number = 'P-20260511-0118';
  IF v_qty_good <> 24 OR v_qty_defect <> 0 OR v_status <> 'IN_PROGRESS' THEN
    RAISE EXCEPTION 'unexpected passport state: qtyGood=% qtyDefect=% status=% (ожидалось 24/0/IN_PROGRESS)',
      v_qty_good, v_qty_defect, v_status;
  END IF;
END $$;

-- 1) PassportDefect
INSERT INTO "PassportDefect" (id, "passportId", "defectTypeId", qty, comment, "createdByEmployeeId", "createdAt")
SELECT
  'pd_' || substring(md5(random()::text || p.id) for 24),
  p.id,
  '535a81c4-1939-46c0-89b4-c646370cf20f',   -- DefectType STAIN «Пятно»
  1,
  NULL,
  'cmorincqk003enwz87783ng7b',              -- Турдибекова Ситора (QC)
  now()
FROM "Passport" p WHERE p.number = 'P-20260511-0118';

-- 2) денормализованные счётчики
UPDATE "Passport"
SET "qtyDefect" = "qtyDefect" + 1,
    "qtyGood"   = "qtyGood"   - 1
WHERE number = 'P-20260511-0118';

-- 3) событие DEFECT_RECORDED (на текущей операции паспорта)
INSERT INTO "PassportEvent" (id, "passportId", type, "operationId", "employeeId", qty, payload, "createdAt")
SELECT
  'pe_' || substring(md5(random()::text || p.id) for 24),
  p.id,
  'DEFECT_RECORDED',
  p."currentOperationId",
  'cmorincqk003enwz87783ng7b',              -- Турдибекова Ситора (QC)
  1,
  jsonb_build_object(
    'defectId', (SELECT id FROM "PassportDefect" WHERE "passportId"=p.id ORDER BY "createdAt" DESC LIMIT 1),
    'defectTypeId', '535a81c4-1939-46c0-89b4-c646370cf20f',
    'defectTypeCode', 'STAIN',
    'defectTypeName', 'Пятно',
    'comment', NULL,
    'backfill', 'manual-sql-record-defect-2026-06-01'
  ),
  now()
FROM "Passport" p WHERE p.number = 'P-20260511-0118';

-- 4) reconcileToQtyGood: сдельные → qtyGood (раскройщик и выплаченные не трогаются)
UPDATE "OperationEntry" oe
SET qty = p."qtyGood",
    amount = round(oe."ratePerUnit" * p."qtyGood", 2)
FROM "Passport" p
WHERE oe."passportId" = p.id
  AND p.number = 'P-20260511-0118'
  AND oe."sourceEventType" <> 'PASSPORT_CREATED'
  AND oe.qty > p."qtyGood"
  AND NOT EXISTS (
    SELECT 1 FROM "PayrollPayoutLine" ppl WHERE ppl."operationEntryId" = oe.id
  );

COMMIT;
