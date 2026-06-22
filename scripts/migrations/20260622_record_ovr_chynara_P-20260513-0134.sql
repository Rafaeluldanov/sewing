-- 2026-06-22: ручная фиксация пропущенной операции ОВР (02 ОВЕРЛОК
-- ФУТБОЛКА) по паспорту P-20260513-0134 на швею Рыскулову Чынару +
-- сдельная выработка.
--
-- Контекст. По маршруту заказа ОВР (index 2) идёт ПЕРЕД киперкой
-- (index 3), но паспорт его перескочил: в истории сразу киперка →
-- распошив → ОТК → ВТО → упаковка, события ОВР нет. По словам
-- пользователя оверлок фактически делала Чынара ДО распошива — нужно
-- задним числом записать операцию и начислить ей сделку.
--
-- Воспроизводим обычный швейный флоу (ISSUED_TO_EMPLOYEE →
-- OPERATION_FINISHED, без SCAN) + одну OperationEntry, как у остальных
-- операций этого паспорта (status APPROVED, approvalMode AFTER_RELEASE,
-- sourceEventType OPERATION_TRANSITION, общий approvedAt 2026-06-16
-- 10:29 — паспорт уже PACKED и выработка по нему выпущена).
--
-- Параметры:
--   passport  cmp4dq21s014eutwwpcoxhk8q  P-20260513-0134 (PACKED, qtyCut=14, qtyGood=11), размер S
--   operation cmord6c8700057ay5prw5mmff  02 ОВЕРЛОК ФУТБОЛКА (BY_SIZE)
--   employee  cmoriuit2003onwz8sfwymzaq  Рыскулова Чынара (SEAMSTRESS)
--   ставка ОВР для размера S = 50.00 ₽/шт (OperationRateBySize)
--
-- Кол-во:
--   * события ОВР — qty=14 (как киперка: операция шла на полном крое до
--     выявления брака на ОТК);
--   * выработка — qty=11 (= qtyGood; финальная сделка по паспорту = qtyGood
--     для ВСЕХ сдельных), amount = 11 * 50.00 = 550.00 ₽.
--
-- Тайминг: колонка PassportEvent.createdAt хранит московское время как
-- naive timestamp (без TZ). ОВР датирован 2026-06-13 06:30→07:40 MSK —
-- ДО распошива (ISSUED того же дня 10:48 MSK) и после киперки (12.06
-- 10:06 MSK). Литералы ниже с '+03' Postgres при вставке в timestamp
-- without time zone берёт как локальную часть (06:30/07:40 сохраняются
-- как есть). Станок (equipmentId) не указан — конкретный оверлок неизвестен.

BEGIN;

-- guard: применяем только в ожидаемом состоянии и пока ОВР не записан
DO $$
DECLARE v_qty_good int; v_qty_cut int; v_status text; v_ev int; v_oe int;
BEGIN
  SELECT "qtyGood", "qtyCut", status::text
    INTO v_qty_good, v_qty_cut, v_status
  FROM "Passport" WHERE id = 'cmp4dq21s014eutwwpcoxhk8q';
  IF v_qty_good <> 11 OR v_qty_cut <> 14 OR v_status <> 'PACKED' THEN
    RAISE EXCEPTION 'unexpected passport state: qtyGood=% qtyCut=% status=% (ожидалось 11/14/PACKED)',
      v_qty_good, v_qty_cut, v_status;
  END IF;
  SELECT count(*) INTO v_ev FROM "PassportEvent"
    WHERE "passportId"='cmp4dq21s014eutwwpcoxhk8q' AND "operationId"='cmord6c8700057ay5prw5mmff';
  SELECT count(*) INTO v_oe FROM "OperationEntry"
    WHERE "passportId"='cmp4dq21s014eutwwpcoxhk8q' AND "operationId"='cmord6c8700057ay5prw5mmff';
  IF v_ev <> 0 OR v_oe <> 0 THEN
    RAISE EXCEPTION 'ОВР уже записан по паспорту: events=% entries=%', v_ev, v_oe;
  END IF;
END $$;

-- 1) ISSUED_TO_EMPLOYEE (взяли крой в работу на ОВР)
INSERT INTO "PassportEvent"
  (id, "passportId", type, "operationId", "fromOperationId", "employeeId", "equipmentId", qty, payload, "createdAt")
VALUES
  ('pe_ovr_chynara_P20260513-0134_iss',
   'cmp4dq21s014eutwwpcoxhk8q', 'ISSUED_TO_EMPLOYEE',
   'cmord6c8700057ay5prw5mmff', NULL,
   'cmoriuit2003onwz8sfwymzaq', NULL, 14,
   '{"backfill":"manual-sql-ovr-chynara-2026-06-22"}'::jsonb,
   '2026-06-13 06:30:00+03');

-- 2) OPERATION_FINISHED (закрыли ОВР)
INSERT INTO "PassportEvent"
  (id, "passportId", type, "operationId", "fromOperationId", "employeeId", "equipmentId", qty, payload, "createdAt")
VALUES
  ('pe_ovr_chynara_P20260513-0134_fin',
   'cmp4dq21s014eutwwpcoxhk8q', 'OPERATION_FINISHED',
   'cmord6c8700057ay5prw5mmff', 'cmord6c8700057ay5prw5mmff',
   'cmoriuit2003onwz8sfwymzaq', NULL, 14,
   '{"backfill":"manual-sql-ovr-chynara-2026-06-22"}'::jsonb,
   '2026-06-13 07:40:00+03');

-- 3) сдельная выработка ОВР (qtyGood=11 * 50.00 = 550.00)
INSERT INTO "OperationEntry"
  (id, "passportId", "operationId", "employeeId", qty, "ratePerUnit", amount,
   status, "approvalMode", "sourceEventType", "sourceEventId", "createdAt", "approvedAt")
VALUES
  ('oe_ovr_chynara_P20260513-0134',
   'cmp4dq21s014eutwwpcoxhk8q', 'cmord6c8700057ay5prw5mmff', 'cmoriuit2003onwz8sfwymzaq',
   11, 50.00, 550.00,
   'APPROVED', 'AFTER_RELEASE', 'OPERATION_TRANSITION', 'pe_ovr_chynara_P20260513-0134_fin',
   '2026-06-13 11:00:00', '2026-06-16 10:29:00');

COMMIT;
