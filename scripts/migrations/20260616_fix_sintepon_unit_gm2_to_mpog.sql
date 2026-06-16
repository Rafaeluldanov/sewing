-- Прод-фикс данных: единица «г/м²» у Синтепона → «м пог.»
--
-- Контекст: при заведении строки техкарты «Синтепон» (роль FILLER)
-- в поле `unit` ошибочно попало значение плотности «г/м²» — это
-- плотность, а не единица измерения. Сама плотность уже корректно
-- лежит в `densityGsm = 80`, ширина рулона — в `plannedWidthCm = 150`.
-- Значение «г/м²» не входит в `allowedUnits` группы «Наполнитель»
-- (см. packages/shared/src/pattern-categories.ts: FILLER), а по спеке
-- номенклатуры (TEEON.pdf) синтепон закупается в «м пог.».
--
-- Мусор просочился в снапшот заказа (OrderMaterialRequirement) и в
-- потребность цеха (WorkshopNeed). Метод расчёта потребности —
-- QTY_PER_UNIT (норма × количество), число `calculatedQty`/`totalQty`
-- не зависит от подписи единицы, поэтому пересчёт не требуется —
-- только релейбл.
--
-- Затрагивается ровно по 1 строке в каждой таблице (WHERE unit='г/м²').
-- Идемпотентно: повторный прогон не находит строк.

BEGIN;

UPDATE "TechCardMaterialLine"
   SET unit = 'м пог.'
 WHERE unit = 'г/м²';

UPDATE "OrderMaterialRequirement"
   SET unit = 'м пог.'
 WHERE unit = 'г/м²';

UPDATE "WorkshopNeed"
   SET unit = 'м пог.'
 WHERE unit = 'г/м²';

-- Контроль: после фикса ни в одной таблице не должно остаться 'г/м²'.
DO $$
DECLARE
  remaining int;
BEGIN
  SELECT (
      (SELECT count(*) FROM "TechCardMaterialLine"      WHERE unit = 'г/м²')
    + (SELECT count(*) FROM "OrderMaterialRequirement"  WHERE unit = 'г/м²')
    + (SELECT count(*) FROM "WorkshopNeed"              WHERE unit = 'г/м²')
  ) INTO remaining;
  IF remaining <> 0 THEN
    RAISE EXCEPTION 'Остались строки с unit=г/м²: %', remaining;
  END IF;
END $$;

COMMIT;
