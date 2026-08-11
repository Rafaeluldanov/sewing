-- Этап 2 плана «техкарты → номенклатура» (анализ 11.08.2026): бэкфилл
-- спецификаций номенклатуры из техкарт.
--
-- Откуда берётся пара «изделие → техкарта»: из ЗАКАЗОВ. Для каждого
-- `PatternItem` берём самый свежий заказ с этим лекалом и его техкарту
-- (`Order.techCardId`; если order-level пуст — техкарта первичной
-- расцветки, `OrderVariant.ordinal` ASC). «Последний заказ выигрывает» —
-- это и есть правило разрешения конфликтов: изделие, которое возили по
-- нескольким техкартам, получает состав из последней использованной.
-- Отчёт о конфликтах для ручной сверки —
-- `scripts/migrations/20260811_pattern_spec_backfill_report.sql`.
--
-- Идемпотентно и не разрушает ручную работу: бэкфиллим ТОЛЬКО карточки,
-- у которых спецификация полностью пуста (ни строк, ни слотов). Повторный
-- прогон — no-op. Категорийные привязки техкарт (`patternCategoryId`)
-- сознательно НЕ используются: без заказа пара «изделие ↔ техкарта»
-- не доказуема, менеджер заполнит вручную или «Подтянуть из группы».
--
-- Техкарты и заказы не меняются вовсе — читаем и копируем.

CREATE TEMP TABLE _spec_backfill_pairs AS
WITH pair AS (
  SELECT DISTINCT ON (o."patternItemId")
    o."patternItemId" AS pattern_id,
    COALESCE(o."techCardId", v."techCardId") AS tech_card_id
  FROM "Order" o
  LEFT JOIN LATERAL (
    SELECT vv."techCardId"
    FROM "OrderVariant" vv
    WHERE vv."orderId" = o.id AND vv."techCardId" IS NOT NULL
    ORDER BY vv."ordinal" ASC
    LIMIT 1
  ) v ON TRUE
  WHERE o."patternItemId" IS NOT NULL
    AND COALESCE(o."techCardId", v."techCardId") IS NOT NULL
  ORDER BY o."patternItemId", o."createdAt" DESC, o.id DESC
)
SELECT p.pattern_id, p.tech_card_id
FROM pair p
WHERE NOT EXISTS (
    SELECT 1 FROM "PatternItemMaterialLine" e
    WHERE e."patternItemId" = p.pattern_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM "PatternItemSpecParameter" e2
    WHERE e2."patternItemId" = p.pattern_id
  );

-- Строки состава: колонки идентичны, `sortOrder` сохраняем как есть.
INSERT INTO "PatternItemMaterialLine" (
  "id", "patternItemId", "sortOrder", "name", "unit", "normUnit",
  "qtyPerUnit", "note", "materialRole", "fabricType", "densityGsm",
  "plannedWidthCm", "colorRule", "fixedColorText", "hardwareSizeText",
  "hardwareMaterialText", "materialImageUrl",
  "materialImageOriginalFileName", "subtypeKey", "characteristics",
  "parameterBindings", "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid()::text, bp.pattern_id, l."sortOrder", l."name", l."unit",
  l."normUnit", l."qtyPerUnit", l."note", l."materialRole", l."fabricType",
  l."densityGsm", l."plannedWidthCm", l."colorRule", l."fixedColorText",
  l."hardwareSizeText", l."hardwareMaterialText", l."materialImageUrl",
  l."materialImageOriginalFileName", l."subtypeKey", l."characteristics",
  l."parameterBindings", now(), now()
FROM _spec_backfill_pairs bp
JOIN "TechCardMaterialLine" l ON l."techCardId" = bp.tech_card_id;

-- Слоты-параметры: ключи уникальны в рамках техкарты → уникальность
-- `(patternItemId, key)` не нарушается (спецификация была пуста).
INSERT INTO "PatternItemSpecParameter" (
  "id", "patternItemId", "key", "label", "inputType", "options", "unit",
  "isRequired", "defaultValue", "owner", "sortOrder", "createdAt",
  "updatedAt"
)
SELECT
  gen_random_uuid()::text, bp.pattern_id, p."key", p."label", p."inputType",
  p."options", p."unit", p."isRequired", p."defaultValue", p."owner",
  p."sortOrder", now(), now()
FROM _spec_backfill_pairs bp
JOIN "TechCardParameter" p ON p."techCardId" = bp.tech_card_id;

DROP TABLE _spec_backfill_pairs;
