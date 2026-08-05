-- Явный признак «коробочная упаковка» на операции (`Operation.boxPacking`).
--
-- Контекст. Терминал упаковщика (`/packing`) и гейты
-- `PackingService.assertPackingActor` / `PackingService.addPassport`
-- различали упаковку ТОЛЬКО по `OperationCategory.PACKING`. Клиент завёл
-- в той же категории вторую операцию — «Распаковка» (приёмка и распаковка
-- приходящего сырья), которая стоит ПЕРВЫМ шагом маршрута. В результате
-- смена на «Распаковке» открывала окно коробок, `addPassport` применял к
-- ней гейт финальной упаковки (требование QC_PASSED / WTO_PASSED по числу
-- шагов QC / IRONING) и падал 409 `PASSPORT_NOT_QC_PASSED` на первом же
-- шаге, а `packingOperationId` уезжал на «Распаковку» как на первый шаг
-- категории PACKING.
--
-- Теперь коробочность — отдельный признак операции, а категория остаётся
-- тем, чем и была: группировкой для UI. Это ОТДЕЛЬНАЯ ось от
-- `producesFinishedGoods` (тот про финансовый выпуск — создание
-- `FinishedGoodsMovement`), их сознательно не сливаем в одно поле.
--
-- DEFAULT false безопасен: без бэкфилла ни одна операция не считалась бы
-- коробочной и упаковщик остался бы без терминала, поэтому бэкфилл ниже
-- обязателен и идёт той же миграцией.

-- AlterTable
ALTER TABLE "Operation" ADD COLUMN "boxPacking" BOOLEAN NOT NULL DEFAULT false;

-- До этой миграции коробочной упаковкой считалась ЛЮБАЯ операция категории
-- PACKING. Помечаем признаком те, что реально закрывают выпуск: сид-операция
-- 'PACKING' и всё, что уже помечено producesFinishedGoods. Прочие PACKING-операции
-- (приёмка / распаковка сырья) признака не получают и уходят на обычный passport-flow.
UPDATE "Operation" SET "boxPacking" = true
 WHERE "category" = 'PACKING'
   AND ("code" = 'PACKING' OR "producesFinishedGoods" = true);
