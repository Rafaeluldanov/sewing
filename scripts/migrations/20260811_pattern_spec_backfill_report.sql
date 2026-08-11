-- ОТЧЁТ (read-only) к этапу 2 плана «техкарты → номенклатура»:
-- что сделал бэкфилл `20261013100000_backfill_pattern_material_spec`
-- и что требует ручной сверки. Запускать на проде ПОСЛЕ deploy:
--   docker exec -i <db> psql -U <user> -d <db> < этот файл
-- Данных не меняет.

-- 1. КОНФЛИКТЫ: изделия, которые в заказах ездили по НЕСКОЛЬКИМ разным
--    техкартам. Бэкфилл взял техкарту самого свежего заказа — проверьте,
--    что выбор корректен (колонка chosen = что попало в спецификацию).
WITH usage AS (
  SELECT
    o."patternItemId"                              AS pattern_id,
    COALESCE(o."techCardId", v."techCardId")       AS tech_card_id,
    max(o."createdAt")                             AS last_used_at,
    count(*)                                       AS orders_count
  FROM "Order" o
  LEFT JOIN LATERAL (
    SELECT vv."techCardId" FROM "OrderVariant" vv
    WHERE vv."orderId" = o.id AND vv."techCardId" IS NOT NULL
    ORDER BY vv."ordinal" ASC LIMIT 1
  ) v ON TRUE
  WHERE o."patternItemId" IS NOT NULL
    AND COALESCE(o."techCardId", v."techCardId") IS NOT NULL
  GROUP BY 1, 2
)
SELECT
  pi."article",
  pi."name"                                        AS pattern_name,
  tc."code"                                        AS tech_card_code,
  u.orders_count,
  u.last_used_at,
  (u.tech_card_id = (
    SELECT u2.tech_card_id FROM usage u2
    WHERE u2.pattern_id = u.pattern_id
    ORDER BY u2.last_used_at DESC LIMIT 1
  ))                                               AS chosen
FROM usage u
JOIN "PatternItem" pi ON pi.id = u.pattern_id
JOIN "TechCardTemplate" tc ON tc.id = u.tech_card_id
WHERE u.pattern_id IN (
  SELECT pattern_id FROM usage GROUP BY pattern_id
  HAVING count(DISTINCT tech_card_id) > 1
)
ORDER BY pi."article", u.last_used_at DESC;

-- 2. РАСЦВЕТКИ С ОТЛИЧАЮЩЕЙСЯ ТЕХКАРТОЙ: заказы, где расцветка возила
--    НЕ ту техкарту, что заказ/первичная расцветка. Их состав в
--    спецификацию не попал (решение §1: одна спецификация на изделие,
--    различия расцветок задаются в заказе).
SELECT o."number" AS order_number, pi."article", v."ordinal", v."color",
       tc_v."code" AS variant_tech_card, tc_o."code" AS order_tech_card
FROM "OrderVariant" v
JOIN "Order" o ON o.id = v."orderId"
LEFT JOIN "PatternItem" pi ON pi.id = o."patternItemId"
LEFT JOIN "TechCardTemplate" tc_v ON tc_v.id = v."techCardId"
LEFT JOIN "TechCardTemplate" tc_o ON tc_o.id = o."techCardId"
WHERE v."techCardId" IS NOT NULL
  AND o."techCardId" IS NOT NULL
  AND v."techCardId" <> o."techCardId"
ORDER BY o."createdAt" DESC;

-- 3. НОМЕНКЛАТУРА БЕЗ СПЕЦИФИКАЦИИ после бэкфилла (не было заказов с
--    техкартой) — заполнить вручную или «Подтянуть из группы».
SELECT pi."article", pi."name", pi."status",
       (SELECT count(*) FROM "Order" o WHERE o."patternItemId" = pi.id)
         AS orders_total
FROM "PatternItem" pi
WHERE pi."status" <> 'ARCHIVED'
  AND NOT EXISTS (
    SELECT 1 FROM "PatternItemMaterialLine" l WHERE l."patternItemId" = pi.id
  )
ORDER BY orders_total DESC, pi."article";

-- 4. ТЕХКАРТЫ-СИРОТЫ: не использовались ни одним заказом с лекалом —
--    их состав никуда не скопирован (умрут вместе с разделом техкарт).
SELECT tc."code", tc."name", tc."isActive",
       (SELECT count(*) FROM "Order" o WHERE o."techCardId" = tc.id)
         AS orders_direct
FROM "TechCardTemplate" tc
WHERE NOT EXISTS (
  SELECT 1 FROM "Order" o
  WHERE o."patternItemId" IS NOT NULL
    AND (o."techCardId" = tc.id OR EXISTS (
      SELECT 1 FROM "OrderVariant" vv
      WHERE vv."orderId" = o.id AND vv."techCardId" = tc.id
    ))
)
ORDER BY tc."isActive" DESC, tc."code";
