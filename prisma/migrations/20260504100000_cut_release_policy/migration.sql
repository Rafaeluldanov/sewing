-- Stage 3 «Мастер цеха» — таблица `CutReleasePolicy` (ограничение
-- выдачи кроя на ПЕРВОЙ операции маршрута / категории CUTTING).
--
-- Подробное описание модели и инвариантов — в `prisma/schema.prisma`
-- (`model CutReleasePolicy`). Кратко: одна активная политика за раз
-- (enforce — на сервисе), фильтры `color`/`sizeId` опциональны,
-- `limitQty` — общий cap по `Σ passport.qtyCut`, `consumedQty`
-- инкрементится атомарно в той же транзакции, что и issue.
--
-- Дизайн:
--   * `id` — `cuid()`-строка (как и во всех остальных таблицах);
--   * `color` / `sizeId` — TEXT NULLable, без FK на `Size` (см.
--     комментарий в schema: справочник размеров может меняться,
--     блокирующий FK сделал бы политику хрупкой к чисткам);
--   * `consumedQty` — `INTEGER NOT NULL DEFAULT 0`, так что
--     `update consumedQty = consumedQty + N` всегда корректен,
--     даже если запись только что создана;
--   * `createdById` — TEXT NOT NULL, без FK (учётка мастера может
--     быть деактивирована, политика должна жить дальше);
--   * `updatedAt` — без `DEFAULT now()`, обновляется триггером
--     prisma на любом `update` (поведение `@updatedAt`);
--   * единственный индекс — `(isActive)`, под горячий запрос
--     «найти текущую активную» (`findFirst({ where: { isActive: true } })`).

CREATE TABLE "CutReleasePolicy" (
    "id"          TEXT         NOT NULL,
    "isActive"    BOOLEAN      NOT NULL DEFAULT true,
    "color"       TEXT,
    "sizeId"      TEXT,
    "limitQty"    INTEGER      NOT NULL,
    "consumedQty" INTEGER      NOT NULL DEFAULT 0,
    "createdById" TEXT         NOT NULL,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CutReleasePolicy_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CutReleasePolicy_isActive_idx" ON "CutReleasePolicy"("isActive");
