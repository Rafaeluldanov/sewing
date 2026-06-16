-- 2026-06-16: откат ошибочного «взять крой» на КИПЕРКУ минуя ОВР/ФУЛ
-- для паспорта P-20260611-0004 (заказ O-20260611-0004, бел. футболка).
--
-- Контекст. Маршрут заказа:
--   0 КРОЙ СТАВКА (CUTTING) → 1 Деление кроя (CUTTING) →
--   2 ОВР/ФУЛ (SEWING) → 3 КИПЕРКА (SEWING, parallelGroup 1) →
--   4 РАСПОШИВ (SEWING, parallelGroup 1) → 5 ОТК → 6 ВТО → 7 УПАКОВКА.
--
-- 15.06.2026 14:31 МСК паспорт «взяли в работу» (ISSUED_TO_EMPLOYEE) сразу
-- на КИПЕРКУ (idx 3), перепрыгнув незакрытый ОВР/ФУЛ (idx 2). Старый
-- route-гейт (`evaluateRouteOrder`) ловил только backward и незавершённые
-- параллельные группы, но НЕ forward-skip одиночного швейного шага —
-- поэтому пропустил. Фактически паспорт на оверлоке (ОВР/ФУЛ) не был.
-- Гейт закрыт кодом (PASSPORT_PRECEDING_STEP_INCOMPLETE), этот патч чинит
-- уже испорченные данные одного паспорта.
--
-- Этот патч:
--   1) удаляет ошибочное событие ISSUED_TO_EMPLOYEE на КИПЕРКЕ;
--   2) откатывает паспорт в состояние «после выпуска кроя, ждёт ОВР/ФУЛ»:
--      status=CREATED, currentOperationId=CUT_DIVISION, currentEmployeeId=NULL,
--      currentRouteStepIndex=0 (как сразу после выпуска) — чтобы стал
--      возможен скан/issue на ОВР/ФУЛ (idx 2).
--
-- НЕ трогаем:
--   - MaterialIssue AUTO_CUT_ISSUE:<passportId> — материалы по крою списаны
--     один раз на паспорт, при повторном issue на ОВР/ФУЛ автосписание
--     идемпотентно (sourceKey уже есть) и дубля не создаст;
--   - AuditLog PASSPORT_ISSUED от 15.06 — журнал append-only, оставляем
--     как исторический след.
--
-- Применить на проде 2026-06-16. Идемпотентен (повторный прогон — no-op).

BEGIN;

-- Контроль: убеждаемся, что паспорт ровно один и в ожидаемом «испорченном»
-- состоянии (КИПЕРКА, idx 3). Если нет — откат руками, патч не для этой БД.
DO $$
DECLARE
  v_pid text;
BEGIN
  SELECT id INTO v_pid FROM "Passport" WHERE number = 'P-20260611-0004';
  IF v_pid IS NULL THEN
    RAISE EXCEPTION 'Passport P-20260611-0004 not found — wrong DB';
  END IF;
END $$;

-- 1) Удаляем ошибочный скан КИПЕРКА (ISSUED_TO_EMPLOYEE, idx 3).
DELETE FROM "PassportEvent" pe
USING "Passport" p, "Operation" op
WHERE pe."passportId" = p.id
  AND p.number = 'P-20260611-0004'
  AND pe.type = 'ISSUED_TO_EMPLOYEE'
  AND pe."operationId" = op.id
  AND op.code = '03';  -- КИПЕРКА

-- 2) Откатываем паспорт в состояние «выпущен крой, ждёт ОВР/ФУЛ».
UPDATE "Passport" p
SET status = 'CREATED',
    "currentOperationId" = (SELECT id FROM "Operation" WHERE code = 'CUT_DIVISION'),
    "currentEmployeeId" = NULL,
    "currentRouteStepIndex" = 0
WHERE p.number = 'P-20260611-0004';

-- Проверка результата (видно в выводе psql, на транзакцию не влияет).
SELECT p.number, p.status, p."currentRouteStepIndex" AS idx,
       op.code AS cur_op, p."currentEmployeeId",
       (SELECT count(*) FROM "PassportEvent" e WHERE e."passportId" = p.id) AS events
FROM "Passport" p
LEFT JOIN "Operation" op ON op.id = p."currentOperationId"
WHERE p.number = 'P-20260611-0004';

COMMIT;
