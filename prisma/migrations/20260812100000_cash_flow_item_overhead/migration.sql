-- Себестоимость, Фаза 2 (срез 3): признак «накладные» на статье ДДС.
-- OUT-проводки по статьям с isOverhead=true образуют пул накладных,
-- который распределяется на заказы пропорционально прямой себестоимости.
ALTER TABLE "CashFlowItem" ADD COLUMN "isOverhead" BOOLEAN NOT NULL DEFAULT false;
