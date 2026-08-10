-- 10.08.2026 — снос расклада-дубля №2 в задаче раскроя заказа 02-00013.
--
-- Причина. Форма раскроя держала расклады в локальном стейте, который
-- инициализировался один раз при монтировании и дальше расходился с БД
-- (починено коммитом `fix(cutter): форма раскроя следует за сервером…`).
-- Только что созданный расклад так и оставался без `ordinal` — номер
-- выдаёт backend, но обратно в стейт не попадал. Поэтому 10.08 в 11:07:37
-- МСК «Расклад готов» создало расклад №1 и закрыло его, а «Раскрой
-- завершён» через 9 секунд отправило ТОТ ЖЕ черновик снова без номера →
-- append-only merge завёл расклад №2, побайтовую копию первого
-- (6 размеров, 15 рулонов, те же слои 7/8/8/8/7/8/7/8/8/8/8/8/7/8/7).
--
-- Чем мешает. Расклад — единица выпуска: система ждёт по заказу 180
-- паспортов вместо 90 (2 расклада × 6 размеров × 15 рулонов), заказ
-- никогда не станет «Завершено» на вкладке «Выпуск», а «Итог по заказу»
-- в карточке раскроя удвоен (2300 шт при плане 1100).
--
-- Сверка перед применением:
--   - по раскладу №2 НЕТ ни одного паспорта (в т.ч. отменённого) —
--     `cuttingLayOrdinal = 2` не встречается у заказа вовсе;
--   - все 12 живых паспортов заказа выпущены по раскладу №1
--     (рулоны 1–2, 6 размеров), его не трогаем;
--   - содержимое №2 идентично №1, самостоятельной информации не несёт.
-- Обе проверки продублированы ниже как жёсткие ассерты: при малейшем
-- расхождении транзакция падает и ничего не меняет.
--
-- `CuttingTaskLaySize` и `CuttingTaskRoll` уходят каскадом
-- (`onDelete: Cascade` на `layId`), задачу и её статус `DONE` не трогаем:
-- расклад №1 закрыт, раскрой действительно завершён.

BEGIN;

DO $$
DECLARE
  v_task_id text;
  v_lay_id  text;
  v_passports int;
  v_lay1_passports int;
BEGIN
  SELECT t.id INTO STRICT v_task_id
    FROM "CuttingTask" t
    JOIN "Order" o ON o.id = t."orderId"
   WHERE o.number = '02-00013';

  SELECT l.id INTO STRICT v_lay_id
    FROM "CuttingTaskLay" l
   WHERE l."taskId" = v_task_id AND l.ordinal = 2;

  SELECT count(*) INTO v_passports
    FROM "Passport" p
    JOIN "CuttingTask" t ON t.id = v_task_id
   WHERE p."orderId" = t."orderId" AND p."cuttingLayOrdinal" = 2;
  IF v_passports <> 0 THEN
    RAISE EXCEPTION 'По раскладу №2 есть паспорта (%) — снос отменён', v_passports;
  END IF;

  SELECT count(*) INTO v_lay1_passports
    FROM "Passport" p
    JOIN "CuttingTask" t ON t.id = v_task_id
   WHERE p."orderId" = t."orderId" AND p."cuttingLayOrdinal" = 1;
  IF v_lay1_passports <> 12 THEN
    RAISE EXCEPTION 'Ожидали 12 паспортов по раскладу №1, нашли % — снос отменён', v_lay1_passports;
  END IF;

  DELETE FROM "CuttingTaskLay" WHERE id = v_lay_id;
  RAISE NOTICE 'Расклад №2 (%) задачи % удалён', v_lay_id, v_task_id;
END $$;

COMMIT;

-- Проверка после применения: остаётся один закрытый расклад №1
-- с 6 размерами, 15 рулонами и 12 выпущенными паспортами.
--
-- SELECT l.ordinal, l."completedAt",
--        (SELECT count(*) FROM "CuttingTaskLaySize" s WHERE s."layId" = l.id) AS sizes,
--        (SELECT count(*) FROM "CuttingTaskRoll" r WHERE r."layId" = l.id) AS rolls
--   FROM "CuttingTaskLay" l
--   JOIN "CuttingTask" t ON t.id = l."taskId"
--   JOIN "Order" o ON o.id = t."orderId"
--  WHERE o.number = '02-00013'
--  ORDER BY l.ordinal;
