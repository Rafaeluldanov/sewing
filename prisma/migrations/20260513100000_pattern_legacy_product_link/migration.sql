-- Этап «Номенклатура = Лекала» — мягкая связка `PatternItem` ↔ legacy `Product`.
-- См. `prisma/schema.prisma` (`model PatternItem.legacyProductId`,
-- `model Product.patternItems`), `apps/api/src/modules/orders/orders.service.ts`
-- (`OrdersService.ensureLegacyProductForPattern`),
-- `docs/recon-soft-integration.md §«Номенклатура = Лекала»».
--
-- Дизайн миграции:
--   * Меняем ТОЛЬКО таблицу `PatternItem` — `ALTER TABLE ... ADD COLUMN`
--     одного nullable поля `legacyProductId` плюс UNIQUE-индекс и FK на
--     `Product.id`. Никаких изменений `OrderItem`, `Passport`,
--     `Product` (только back-relation в Prisma — на уровне SQL ничего
--     не меняем), `PieceRate`, `Order` — этап «Номенклатура = Лекала»
--     чисто additive: backend получает скрытую legacy-ссылку, UI
--     перестаёт показывать `productId` в форме создания заказа,
--     никаких destructive миграций.
--   * Все колонки nullable, FK `ON DELETE SET NULL` — карточка лекала
--     остаётся валидной, если кто-то удалит привязанный Product
--     (например, ручной cleanup на stage). При следующем создании
--     заказа `ensureLegacyProductForPattern` создаст новый Product
--     по требованию.
--   * UNIQUE-индекс на `legacyProductId` гарантирует инвариант
--     «один PatternItem = один технический Product»: helper не
--     создаёт второй Product для уже привязанного лекала, повторное
--     создание заказа по тому же лекалу переиспользует existing.
--   * `ON UPDATE CASCADE` оставлен по умолчанию Prisma (cuid у нас
--     никогда не меняется, но оставляем «как везде» для консистентности).

ALTER TABLE "PatternItem"
  ADD COLUMN "legacyProductId" TEXT;

CREATE UNIQUE INDEX "PatternItem_legacyProductId_key"
  ON "PatternItem"("legacyProductId");

ALTER TABLE "PatternItem"
  ADD CONSTRAINT "PatternItem_legacyProductId_fkey"
    FOREIGN KEY ("legacyProductId") REFERENCES "Product"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
