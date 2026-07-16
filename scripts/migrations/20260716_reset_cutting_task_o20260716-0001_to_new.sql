-- 2026-07-16. Прод (myapp): откат задачи раскроя заказа O-20260716-0001
-- до первоначального состояния (по просьбе цеха).
--
-- Ситуация: раскройщик завершил раскрой (DONE), задача ушла на доску
-- помощника раскройщика, но все «на настиле» (CuttingTaskLaySize.perLayerQty)
-- остались нулями — маркер не был заполнен, выпускать паспорта не из чего.
-- Паспортов по заказу 0 (помощник ничего не выпустил) — откат безопасен.
--
-- Решение (подтверждено пользователем): ПОЛНЫЙ сброс до NEW — задача
-- возвращается в общую очередь раскройщиков, расклады/рулоны стираются,
-- план по размерам (CuttingTaskSizeRow) остаётся.
--
-- task  cmrncarvx1zftk00li01wa35m
-- order cmrn6yjgb1zbek00lyddox4ie (O-20260716-0001)
--
-- Результат: DELETE 9 (rolls), DELETE 12 (laySizes), DELETE 4 (lays), UPDATE 1.

BEGIN;

DELETE FROM "CuttingTaskRoll"
WHERE "layId" IN (SELECT id FROM "CuttingTaskLay" WHERE "taskId" = 'cmrncarvx1zftk00li01wa35m');

DELETE FROM "CuttingTaskLaySize"
WHERE "layId" IN (SELECT id FROM "CuttingTaskLay" WHERE "taskId" = 'cmrncarvx1zftk00li01wa35m');

DELETE FROM "CuttingTaskLay"
WHERE "taskId" = 'cmrncarvx1zftk00li01wa35m';

UPDATE "CuttingTask"
SET status         = 'NEW',
    "assignedToId" = NULL,
    "startedAt"    = NULL,
    "completedAt"  = NULL,
    "updatedAt"    = now()
WHERE id = 'cmrncarvx1zftk00li01wa35m'
  AND status = 'DONE';

COMMIT;
