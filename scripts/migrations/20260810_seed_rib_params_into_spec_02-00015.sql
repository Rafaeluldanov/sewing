-- 10.08.2026 — «Кашкорсе» и «Рибана» в состав заказа 02-00015.
--
-- Предыстория. Потребность цеха у этого заказа считается category-driven: по
-- параметрам лекала «Поло Basic (Сакура)». Два из них — «Рибана» и «Кашкорсе»,
-- роль RIB — в техкарте «Поло» строк не имеют вовсе. Спецификация заказа
-- собиралась ТОЛЬКО из строк техкарты, поэтому в расцветке их было не видно:
-- показать нечем, править нечем, убрать из заказа нечем — а в закупку они
-- шли. Менеджер оставил в составе 9 строк, в потребность уезжало 11.
--
-- Код это чинит (main `ddc8b27`): такие параметры материализуются в
-- спецификацию наравне со строками техкарты, а их удаление гасит потребность.
-- Но сеются они только при МАТЕРИАЛИЗАЦИИ снимка (создание заказа, смена
-- техкарты, «Обновить из шаблона») — обычный пересчёт в шаблон не ходит, и
-- это правильно: иначе удалённая строка возвращалась бы на каждом ресинке.
-- Заказ 02-00015 свой снимок уже материализовал 10.08 в 16:18 МСК, значит сам
-- строк не получит, а «Обновить из шаблона» воскресило бы удалённые менеджером
-- «Лейбл» и «Подвяз на метраж» и снесло бы правки по «Основному полотну».
-- Поэтому — точечно.
--
-- Что делаем:
--   1. заводим 4 строки спецификации (2 параметра × 2 расцветки) ровно с теми
--      полями, которые проставил бы билдер снимка: `sourceTechCardLineId =
--      NULL` (строки шаблона под них нет), `qtySource = NOMENCLATURE` +
--      `qtySourceRef = <id параметра категории>`, норма в «м пог.»,
--      закупочная единица — из параметра («кг»), `isManual = false`;
--   2. ставим заказу отметку `specPatternParamsSeededAt` — по ней расчёт
--      потребности понимает, что удаление этих строк означает «материал из
--      заказа убрали», а не «строки тут никогда не было».
--
-- Числа НЕ вписаны руками: норма на изделие считается средневзвешенной по
-- плану расцветки (как `derivePatternNormPerUnit`), расход = норма × тираж
-- (пересчёт в «кг» невозможен — у параметра нет ширины и плотности, ровно об
-- этом и предупреждает расчёт потребности). Ожидаемый результат:
--   Серый  (60 шт): Рибана 0.2 × 60 = 12 м пог., Кашкорсе 12 м пог.;
--   Серый 2 (40 шт): по 8 м пог.
--
-- Потребность цеха от этого не поедет: «Рибана» и «Кашкорсе» в ней и так
-- есть с теми же числами. Меняется ровно одно — теперь их видно в расцветке
-- и можно убрать.
--
-- Все допущения проверяются ассертами; при любом расхождении транзакция
-- падает целиком.

BEGIN;

CREATE TEMP TABLE seed_rib_rows ON COMMIT DROP AS
WITH ord AS (
  SELECT o.id, o."patternItemId", o."techCardId", o."specPatternParamsSeededAt"
    FROM "Order" o
   WHERE o.number = '02-00015'
),
-- Параметр лекала = группа значений по размерам под одним
-- `categoryParameterId`. Берём только те, под которые в спецификации заказа
-- нет ни одной строки: полотно и дублерин свои строки в техкарте имеют.
param AS (
  SELECT v."categoryParameterId"     AS param_id,
         min(v."roleKey")            AS role_key,
         min(v."labelSnapshot")      AS label,
         min(v.unit)                 AS purchase_unit,
         min(v.id)                   AS order_key
    FROM "PatternItemSizeParameterValue" v
    JOIN ord ON ord."patternItemId" = v."patternItemId"
   WHERE v."inputTypeSnapshot" = 'LINEAR_M_BY_SIZE'
     AND v.value > 0
     AND NOT EXISTS (
           SELECT 1
             FROM "OrderMaterialRequirement" r
            WHERE r."orderId" = ord.id
              AND r."qtySourceRef" = v."categoryParameterId"
         )
   GROUP BY v."categoryParameterId"
),
variant AS (
  SELECT ov.id                                         AS variant_id,
         ov.color                                      AS color,
         coalesce(sum(s."qtyPlan"), 0)                 AS qty
    FROM "OrderVariant" ov
    JOIN ord ON ord.id = ov."orderId"
    LEFT JOIN "OrderVariantSize" s ON s."variantId" = ov.id
   GROUP BY ov.id, ov.color
),
-- Средневзвешенная норма на изделие: Σ(значение × план размера) / Σ(план).
-- Размеры без значения в лекале в знаменатель не попадают — так же, как в
-- `derivePatternNormPerUnit`.
norm AS (
  SELECT vr.variant_id,
         p.param_id,
         round(
           sum(v.value * s."qtyPlan")::numeric / nullif(sum(s."qtyPlan"), 0),
           4
         ) AS qty_per_unit
    FROM variant vr
    JOIN "OrderVariantSize" s
      ON s."variantId" = vr.variant_id AND s."qtyPlan" > 0
    CROSS JOIN param p
    JOIN ord ON true
    JOIN "PatternItemSizeParameterValue" v
      ON v."patternItemId" = ord."patternItemId"
     AND v."categoryParameterId" = p.param_id
     AND v."sizeId" = s."sizeId"
     AND v.value > 0
   GROUP BY vr.variant_id, p.param_id
),
-- Строку ставим после последней строки ШАБЛОНА — так же, как билдер снимка.
base_sort AS (
  SELECT coalesce(max(l."sortOrder"), 0) AS max_sort
    FROM "TechCardMaterialLine" l
    JOIN ord ON ord."techCardId" = l."techCardId"
)
SELECT gen_random_uuid()::text                          AS id,
       ord.id                                           AS order_id,
       vr.variant_id,
       vr.color,
       p.param_id,
       p.role_key,
       p.label,
       p.purchase_unit,
       n.qty_per_unit,
       round(n.qty_per_unit * vr.qty, 4)                AS total_qty,
       bs.max_sort
         + 10 * (dense_rank() OVER (ORDER BY p.order_key))::int
                                                        AS sort_order,
       ord."techCardId"                                 AS tech_card_id
  FROM ord
  CROSS JOIN base_sort bs
  JOIN param p ON true
  JOIN variant vr ON vr.qty > 0
  JOIN norm n ON n.variant_id = vr.variant_id AND n.param_id = p.param_id;

-- ---------------------------------------------------------------------------
-- Пред-проверки
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_count int;
  v_labels text;
  v_bad int;
  v_seeded timestamp;
BEGIN
  SELECT count(*) INTO v_count FROM seed_rib_rows;
  IF v_count <> 4 THEN
    RAISE EXCEPTION 'Ожидали 4 строки к заведению (2 параметра × 2 расцветки), отобрано % — правка отменена', v_count;
  END IF;

  SELECT string_agg(DISTINCT label, ', ' ORDER BY label) INTO v_labels FROM seed_rib_rows;
  IF v_labels <> 'Кашкорсе, Рибана' THEN
    RAISE EXCEPTION 'Ожидали параметры «Кашкорсе, Рибана», отобраны «%» — правка отменена', v_labels;
  END IF;

  SELECT count(*) INTO v_bad FROM seed_rib_rows WHERE role_key <> 'RIB';
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'У % строк роль не RIB — правка отменена', v_bad;
  END IF;

  -- Расход: Серый 60 × 0.2 = 12, Серый 2 40 × 0.2 = 8.
  SELECT count(*) INTO v_bad
    FROM seed_rib_rows
   WHERE NOT (
     (color = 'Серый'   AND qty_per_unit = 0.2 AND total_qty = 12)
     OR (color = 'Серый 2' AND qty_per_unit = 0.2 AND total_qty = 8)
   );
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'У % строк расход разошёлся с ожидаемым (12 / 8 м пог.) — правка отменена', v_bad;
  END IF;

  SELECT "specPatternParamsSeededAt" INTO v_seeded
    FROM "Order" WHERE number = '02-00015';
  IF v_seeded IS NOT NULL THEN
    RAISE EXCEPTION 'Отметка specPatternParamsSeededAt уже стоит (%) — правка уже применялась, отмена', v_seeded;
  END IF;

  -- В составе заказа сейчас 9 строк на расцветку (11 строк техкарты минус
  -- удалённые менеджером «Лейбл» и «Подвяз на метраж»).
  SELECT count(*) INTO v_count
    FROM "OrderMaterialRequirement" r
    JOIN "Order" o ON o.id = r."orderId"
   WHERE o.number = '02-00015';
  IF v_count <> 18 THEN
    RAISE EXCEPTION 'Ожидали 18 строк спецификации, нашли % — состав заказа изменился, правка отменена', v_count;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Заведение строк
-- ---------------------------------------------------------------------------
INSERT INTO "OrderMaterialRequirement" (
  id, "orderId", "orderVariantId", "variantColor",
  "sourceTechCardLineId", "sortOrder",
  name, unit, "normUnit", "qtyPerUnit", "totalQty",
  "materialRole", "fabricType",
  "colorRule", "resolvedColorText", "requiresColorSelection",
  "sourceTechCardId", "isManual", "qtySource", "qtySourceRef",
  "createdAt"
)
SELECT s.id, s.order_id, s.variant_id, s.color,
       NULL, s.sort_order,
       s.label, s.purchase_unit, 'м пог.', s.qty_per_unit, s.total_qty,
       s.role_key, s.label,
       'ORDER_COLOR', s.color, false,
       s.tech_card_id, false, 'NOMENCLATURE', s.param_id,
       now()
  FROM seed_rib_rows s;

-- Отметка «снимок собран новым правилом»: с этого момента удаление строки
-- под параметр лекала гасит потребность по нему.
UPDATE "Order"
   SET "specPatternParamsSeededAt" = now()
 WHERE number = '02-00015'
   AND "specPatternParamsSeededAt" IS NULL;

-- ---------------------------------------------------------------------------
-- Пост-проверки
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_count int;
  v_bad int;
BEGIN
  SELECT count(*) INTO v_count
    FROM "OrderMaterialRequirement" r
    JOIN "Order" o ON o.id = r."orderId"
   WHERE o.number = '02-00015';
  IF v_count <> 22 THEN
    RAISE EXCEPTION 'После заведения ожидали 22 строки спецификации, получили %', v_count;
  END IF;

  -- По 11 строк на расцветку — столько же, сколько строк в потребности.
  SELECT count(*) INTO v_bad FROM (
    SELECT r."orderVariantId"
      FROM "OrderMaterialRequirement" r
      JOIN "Order" o ON o.id = r."orderId"
     WHERE o.number = '02-00015'
     GROUP BY r."orderVariantId"
    HAVING count(*) <> 11
  ) x;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'У % расцветок в составе не 11 строк', v_bad;
  END IF;

  SELECT count(*) INTO v_count
    FROM "Order" WHERE number = '02-00015' AND "specPatternParamsSeededAt" IS NOT NULL;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'Отметка specPatternParamsSeededAt не проставилась';
  END IF;
END $$;

COMMIT;
