-- Частичное завершение раскроя по раскладу («Расклад готов»).
--
-- Единица готовности переезжает с задачи (`CuttingTask.status = DONE`) на
-- расклад: раскройщик закрывает расклад 1 и по нему СРАЗУ можно выпускать
-- паспорта, пока настилается расклад 2. Задача при этом остаётся
-- `IN_PROGRESS`; «Раскрой завершён» закрывает все оставшиеся расклады.
--
-- Аддитивно: обе колонки nullable, без дефолта и без backfill.
-- Существующие расклады остаются с `completedAt = NULL`; для задач,
-- завершённых до этой миграции, выпуск разрешён по старому правилу
-- `CuttingTask.status = DONE` (см. `PassportsService.releaseFromRolls`).
--
-- Инвариант, который держит код (не БД): `CuttingTaskLay.ordinal`
-- append-only. Сохранение прогресса стало merge по `ordinal` вместо
-- полного replace — иначе автосейв пересоздал бы расклады и выпущенные
-- паспорта (`Passport.cuttingLayOrdinal`) оторвались бы от своего настила.
ALTER TABLE "CuttingTaskLay" ADD COLUMN "completedAt" TIMESTAMP(3);
ALTER TABLE "CuttingTaskLay" ADD COLUMN "completedById" TEXT;

-- Кто закрыл расклад. SET NULL: удаление учётки не сносит расклад.
ALTER TABLE "CuttingTaskLay"
  ADD CONSTRAINT "CuttingTaskLay_completedById_fkey"
  FOREIGN KEY ("completedById") REFERENCES "Employee"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Индекс под FK (выборка «расклады, закрытые сотрудником»).
CREATE INDEX "CuttingTaskLay_completedById_idx" ON "CuttingTaskLay"("completedById");
