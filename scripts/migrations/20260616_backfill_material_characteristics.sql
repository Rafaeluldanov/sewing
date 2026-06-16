-- Фаза 1, бэкфилл: проставить subtypeKey и собрать characteristics из
-- legacy-колонок для существующих строк материалов.
--
-- subtypeKey: по (materialRole, name) — см. MATERIAL_SUBTYPES в
--   @sewing/shared/material-characteristics. Полотна/подкладка/нитки —
--   один подтип на группу; рибана, клеевые, наполнитель, фурнитура —
--   по ключевым словам имени. MARKING не маппится (Фаза 3) → остаётся null.
-- characteristics: density←densityGsm, rollWidth←plannedWidthCm,
--   size←hardwareSizeText, material←hardwareMaterialText (null/'' пропуск).
--   Цвет НЕ входит (он в colorRule). Пустой объект → null.
--
-- Идемпотентно: повторный прогон даёт тот же результат (UPDATE по всем
-- строкам, не зависит от текущего значения subtypeKey/characteristics).

BEGIN;

-- Временный резолвер подтипа (порядок WHEN важен для пересечений:
-- «полукольцо» до «кольцо», «шляпн» до «резинк», «шнур» до общего).
CREATE OR REPLACE FUNCTION pg_temp._mc_subtype(role text, nm text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN role = 'MAIN_FABRIC'        THEN 'MAIN_FABRIC'
    WHEN role = 'ADDITIONAL_FABRIC'  THEN 'ADDITIONAL_FABRIC'
    WHEN role = 'LINING'             THEN 'LINING'
    WHEN role = 'THREAD'             THEN 'THREAD'
    WHEN role = 'RIB' THEN CASE
      WHEN nm ILIKE '%кашкорсе%' THEN 'KASHKORSE'
      ELSE 'RIB' END
    WHEN role = 'FILLER' THEN CASE
      WHEN nm ILIKE '%синтепон%' THEN 'SINTEPON'
      WHEN nm ILIKE '%пух%'      THEN 'ARTIFICIAL_DOWN'
      ELSE NULL END
    WHEN role = 'INTERLINING' THEN CASE
      WHEN nm ILIKE '%дублерин%'  THEN 'DUBLERIN'
      WHEN nm ILIKE '%флизелин%'  THEN 'FLIZELIN'
      WHEN nm ILIKE '%паутинк%'   THEN 'PAUTINKA'
      WHEN nm ILIKE '%кром%'      THEN 'GLUE_EDGE'
      WHEN nm ILIKE '%бортовк%'   THEN 'BORTOVKA'
      ELSE NULL END
    WHEN role = 'PACKAGING' THEN CASE
      WHEN nm ILIKE '%молни%'                                THEN 'ZIPPER'
      WHEN nm ILIKE '%кнопк%'                                THEN 'SNAP_BUTTON'
      WHEN nm ILIKE '%люверс%'                               THEN 'EYELET'
      WHEN nm ILIKE '%фастекс%'                              THEN 'FASTEX'
      WHEN nm ILIKE '%фиксатор%'                             THEN 'CORD_LOCK'
      WHEN nm ILIKE '%полукольц%'                            THEN 'HALF_RING'
      WHEN nm ILIKE '%кольц%'                                THEN 'RING'
      WHEN nm ILIKE '%концевик%' OR nm ILIKE '%наконечник%' THEN 'CORD_END'
      WHEN nm ILIKE '%стропа%'                              THEN 'WEBBING'
      WHEN nm ILIKE '%кипер%'  OR nm ILIKE '%лента%'         THEN 'TAPE'
      WHEN nm ILIKE '%окантовк%' OR nm ILIKE '%кант%'       THEN 'PIPING'
      WHEN nm ILIKE '%шляпн%'                               THEN 'HAT_ELASTIC'
      WHEN nm ILIKE '%резинк%'                              THEN 'ELASTIC'
      WHEN nm ILIKE '%шнур%'                                THEN 'CORD'
      WHEN nm ILIKE '%подвяз%'                              THEN 'KNIT_CUFF'
      WHEN nm ILIKE '%воротник%'                            THEN 'KNIT_COLLAR'
      WHEN nm ILIKE '%пуговиц%'                             THEN 'BUTTON'
      ELSE NULL END
    ELSE NULL
  END;
$$;

-- characteristics из legacy-колонок (общий шаблон в каждом UPDATE ниже).

UPDATE "TechCardMaterialLine" SET
  "subtypeKey" = pg_temp._mc_subtype("materialRole", name),
  "characteristics" = NULLIF(jsonb_strip_nulls(jsonb_build_object(
    'density',  "densityGsm",
    'rollWidth', "plannedWidthCm",
    'size',     NULLIF(trim("hardwareSizeText"), ''),
    'material', NULLIF(trim("hardwareMaterialText"), '')
  )), '{}'::jsonb);

UPDATE "OrderMaterialRequirement" SET
  "subtypeKey" = pg_temp._mc_subtype("materialRole", name),
  "characteristics" = NULLIF(jsonb_strip_nulls(jsonb_build_object(
    'density',  "densityGsm",
    'rollWidth', "plannedWidthCm",
    'size',     NULLIF(trim("hardwareSizeText"), ''),
    'material', NULLIF(trim("hardwareMaterialText"), '')
  )), '{}'::jsonb);

-- WorkshopNeed: имя источника материала лежит в sourceName.
UPDATE "WorkshopNeed" SET
  "subtypeKey" = pg_temp._mc_subtype("materialRole", coalesce("sourceName", description)),
  "characteristics" = NULLIF(jsonb_strip_nulls(jsonb_build_object(
    'density',  "densityGsm",
    'rollWidth', "plannedWidthCm"
  )), '{}'::jsonb);

COMMIT;
