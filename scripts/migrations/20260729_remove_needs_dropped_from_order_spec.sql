-- 29.07.2026 — заказ 02-00002: «Лейбл» и «Киперная лента» убраны из
-- спецификации заказа (OrderMaterialRequirement), но остались в потребностях.
--
-- Причина: количество для category-driven заказа берётся из номенклатуры
-- (PatternItemParameterNorm), а норма одна на все заказы. Цикл по нормам в
-- WorkshopNeedsService.calculateForOrder не спрашивал снимок заказа, поэтому
-- удалённая в заказе строка возвращалась в потребность на каждом пересчёте.
-- Код починен (isNormRemovedFromSpec); этот патч убирает уже созданные строки.
--
-- Обе строки в статусе CALCULATED, без ссылок из PurchaseOrderLine /
-- PurchaseReceiptLine / OrderCostEstimateLine / OrderMaterialArrivalOverride /
-- MaterialIssueLine / MaterialIssueReturnLine / StockBalance / StockMovement
-- (проверено перед применением) — удаление ничего не осиротит.
--
-- Условие NOT EXISTS повторяет решение кода: строку сносим, только если в
-- снимке заказа НЕТ ни привязки к этой норме (`qtySourceRef`), ни строки,
-- названной как сам параметр. Патч идемпотентен.
DELETE FROM "WorkshopNeed" w
WHERE w."orderId" = (SELECT id FROM "Order" WHERE number = '02-00002')
  AND w."sourceType" = 'PATTERN_PARAMETER_NORM'
  AND w.status = 'CALCULATED'
  AND w."isManual" = false
  AND NOT EXISTS (
    SELECT 1 FROM "OrderMaterialRequirement" r
    WHERE r."orderId" = w."orderId"
      AND (
        r."qtySourceRef" = w."sourceId"
        OR lower(trim(r.name)) = lower(trim(w."sourceName"))
        OR lower(trim(r.name)) LIKE lower(trim(w."sourceName")) || ' %'
      )
  );
