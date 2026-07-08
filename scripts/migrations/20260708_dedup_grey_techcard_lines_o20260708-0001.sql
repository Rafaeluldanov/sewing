-- 2026-07-08 data-fix: задвоенные строки материалов в серой техкарте
-- (потребность серого считалась вдвое — Кулирка/Кашкорсе ×2 + лишняя «Нитки кг»).
--
-- Техкарта cmrbz7fed059wap8yib486orh («Футболка Over/Кулирная гладь 100%
-- хлопок варенка/Кашкорсе», серый цвет заказа O-20260708-0001) была заведена
-- сразу с дублями (все 8 строк созданы одним батчем 2026-07-08 11:20:49):
--   sort 10 Кулирка(кг) / 20 Кашкорсе(кг) / 30 Нитки(м) / 40 Размерник(шт) /
--   50 Составник(шт)  — корректные 5 строк (как в чистой розовой техкарте);
--   sort 60 Нитки(кг) / 70 Кулирка(кг) / 80 Кашкорсе(кг) — ДУБЛИ, удаляем.
-- Техкарту использует ТОЛЬКО O-20260708-0001 (серая расцветка + order-level).
-- Расчёт кода верен — суммирует то, что в техкарте; баг в данных.
--
-- FK OrderMaterialRequirement.sourceTechCardLineId → onDelete: SetNull,
-- поэтому удаление строк техкарты безопасно (снимок пересоберётся при
-- пересохранении серой расцветки — resyncColorwayDerived).
--
-- BACKUP удаляемых строк (для отката — при необходимости заинсертить назад):
--   id                        name     unit qtyPerUnit role         sort colorRule   fabricType subtypeKey  density width
--   cmrbzlgnm05rhap8y3ya6rv45 Нитки    кг   1.0000     THREAD       60   FIXED_COLOR Нитки      THREAD      NULL    NULL
--   cmrbzlgnm05riap8ycxnmvphx Кулирка  кг   1.0000     MAIN_FABRIC  70   FIXED_COLOR Кулирка    MAIN_FABRIC 170     185
--   cmrbzlgnm05rjap8y1ccct1pw Кашкорсе кг   1.0000     RIB          80   FIXED_COLOR Кашкорсе   KASHKORSE   330     120

DELETE FROM "TechCardMaterialLine"
WHERE id IN (
  'cmrbzlgnm05rhap8y3ya6rv45', -- Нитки (кг), sort 60
  'cmrbzlgnm05riap8ycxnmvphx', -- Кулирка (кг), sort 70
  'cmrbzlgnm05rjap8y1ccct1pw'  -- Кашкорсе (кг), sort 80
);

-- Проверка: должно остаться 5 чистых строк (Кулирка/Кашкорсе/Нитки м/Размерник/Составник).
SELECT "sortOrder", name, unit, "materialRole"
FROM "TechCardMaterialLine"
WHERE "techCardId" = 'cmrbz7fed059wap8yib486orh'
ORDER BY "sortOrder";
