-- Stage «Patterns MVP-2» — мягкая связка `Order` ↔ `PatternItem`.
-- См. `prisma/schema.prisma` (`model Order` ниже после `techCardId`,
-- `model PatternItem`), `apps/api/src/modules/orders/orders.service.ts`,
-- `docs/recon-soft-integration.md §«План внедрения»».
--
-- Дизайн миграции:
--   * Меняем ТОЛЬКО таблицу `Order` — `ALTER TABLE ... ADD COLUMN`
--     четырёх nullable-полей плюс FK + index на `patternItemId`.
--     Никаких изменений `OrderItem`, `Passport`, `TechCard*`,
--     `RouteTemplate`, `Product`, `PatternItem`, `PatternSizeFile`,
--     `PatternMaterialArea` — этап 2 чисто «soft snapshot» поверх
--     уже существующего модуля «Лекала».
--   * Все колонки nullable, FK `ON DELETE SET NULL` — все исторические
--     заказы остаются валидными после миграции, лекало в заказе
--     остаётся опциональным.
--   * Snapshot-поля (`patternNameSnapshot` / `patternArticleSnapshot`
--     / `patternPreviewSnapshotUrl`) фиксируются `OrdersService.start()`
--     по той же транзакционной семантике, что snapshot маршрута и
--     техкарты. Это защищает уже запущенный заказ от поздних правок
--     карточки лекала (см. `OrderRouteStep`/`OrderMaterialRequirement`
--     и ADR-0022 «soft snapshot pattern»).
--   * Index `Order_patternItemId_idx` нужен для частого UI-фильтра
--     «заказы по лекалу» (даже если на этапе 2 такого экрана нет —
--     стоимость индекса минимальная, а отдельная миграция позже на
--     production обойдётся дороже).

ALTER TABLE "Order"
  ADD COLUMN "patternItemId"             TEXT,
  ADD COLUMN "patternNameSnapshot"       TEXT,
  ADD COLUMN "patternArticleSnapshot"    TEXT,
  ADD COLUMN "patternPreviewSnapshotUrl" TEXT;

CREATE INDEX "Order_patternItemId_idx" ON "Order"("patternItemId");

ALTER TABLE "Order"
  ADD CONSTRAINT "Order_patternItemId_fkey"
    FOREIGN KEY ("patternItemId") REFERENCES "PatternItem"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
