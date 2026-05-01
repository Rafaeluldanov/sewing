-- Этап 3 «Потребности цеха» — структура данных техкарты для будущего
-- расчёта потребности материалов цеха.
--
-- См. `docs/recon-soft-integration.md §«Этап 3»`,
-- `prisma/schema.prisma` (`TechCardMaterialLine`,
-- `OrderMaterialRequirement`),
-- `apps/api/src/modules/tech-cards/tech-cards.service.ts`,
-- `apps/api/src/modules/orders/orders.service.ts`.
--
-- Дизайн миграции:
--   * Меняем ТОЛЬКО `TechCardMaterialLine` и `OrderMaterialRequirement`
--     — все колонки nullable, без default, чтобы существующие
--     техкарты и snapshot-строки оставались валидными как есть.
--   * Никаких изменений `Order`, `OrderItem`, `Passport`,
--     `RouteTemplate`, `Product`, `PatternItem`, `PatternSizeFile`,
--     `PatternMaterialArea`, `TechCardOutsourceLine`,
--     `OrderOutsourceRequirement` — этот этап чисто additive поверх
--     уже существующего модуля «Техкарты».
--   * Никаких Prisma enum для `materialRole` / `colorRule`: список
--     ролей материала и список правил цвета сознательно расширяемый
--     без миграции (см. `@sewing/shared/material-roles` и
--     `@sewing/shared/tech-cards`). Валидация значений — на стороне
--     Zod-схем DTO.
--   * Index `*_materialRole_idx` нужен под будущий расчёт
--     «Потребности цеха» (соединение по `materialRole` с
--     `PatternMaterialArea`); стоимость минимальная, отдельная
--     миграция позже на production обошлась бы дороже.

-- Этап 3: новые поля в строке материала техкарты.
ALTER TABLE "TechCardMaterialLine"
  ADD COLUMN "materialRole"   TEXT,
  ADD COLUMN "fabricType"     TEXT,
  ADD COLUMN "densityGsm"     INTEGER,
  ADD COLUMN "plannedWidthCm" INTEGER,
  ADD COLUMN "colorRule"      TEXT,
  ADD COLUMN "fixedColorText" TEXT;

CREATE INDEX "TechCardMaterialLine_materialRole_idx"
  ON "TechCardMaterialLine"("materialRole");

-- Этап 3: snapshot новых полей на конкретном заказе. `resolvedColorText`
-- вычисляется в `OrdersService.start()` по `colorRule` — см. JSDoc
-- модели в `prisma/schema.prisma`.
ALTER TABLE "OrderMaterialRequirement"
  ADD COLUMN "materialRole"      TEXT,
  ADD COLUMN "fabricType"        TEXT,
  ADD COLUMN "densityGsm"        INTEGER,
  ADD COLUMN "plannedWidthCm"    INTEGER,
  ADD COLUMN "colorRule"         TEXT,
  ADD COLUMN "fixedColorText"    TEXT,
  ADD COLUMN "resolvedColorText" TEXT;

CREATE INDEX "OrderMaterialRequirement_materialRole_idx"
  ON "OrderMaterialRequirement"("materialRole");
