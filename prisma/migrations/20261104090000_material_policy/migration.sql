-- ПОЛИТИКА МАТЕРИАЛА: что считать затратой заказа и по какой цене.
--
-- До сих пор это было зашито в код: количество — только оформленный расход, цена — всегда
-- плановая котировка закупщика. На проде это давало ноль материала в документах выпуска
-- (списаний не оформляли) и нулевые суммы там, где списания были — у потребности не проставлена
-- `quotedPrice`.
--
-- ⛔ ДВЕ ОСИ, А НЕ ОДНА. Заказ поставщику делает настоящей ЦЕНУ, но не расход: рулон берут на
-- 60 м, когда нужно 47, и остаток принадлежит складу, а не тиражу. Свести их в один
-- переключатель — значит зашить в отчёт перерасход, которого не было, причём выглядеть он будет
-- как вина цеха.
--
-- ⛔ ГРАНИЦА «КОМПАНИЯ / ЗАКАЗ». Источники количества и цены — свойство ПРОЦЕССА, одинаковы для
-- цеха, живут в настройках компании. Признание («расход» или «вся закупка под заказ») —
-- управленческое решение по конкретному тиражу, живёт на заказе рядом с
-- `materialsAndHardwareCostPolicy`. Второго места для правил про материал не заводим.
--
-- ⛔ МОМЕНТ СПИСАНИЯ здесь НЕ трогается. Он остаётся булевым `autoIssueMaterialsOnCutRelease`,
-- у которого есть собственное переопределение по подразделениям
-- (`CompanyDivision.autoIssueMaterialsOnCutReleaseOverride`). Превратить его в перечисление
-- моментов — отдельная работа: без переноса override-слоя подразделения потеряли бы настройку
-- молча.

CREATE TYPE "MaterialQtySource" AS ENUM ('ISSUED_OR_CALCULATED', 'ISSUED', 'CALCULATED', 'ORDERED', 'RECEIVED');
CREATE TYPE "MaterialPriceSource" AS ENUM ('PURCHASE', 'PLANNED', 'RECEIPT');
CREATE TYPE "OrderMaterialRecognition" AS ENUM ('BY_CONSUMPTION', 'ALL_PURCHASED');

ALTER TABLE "CompanySettings"
  ADD COLUMN "materialQtySource"   "MaterialQtySource"   NOT NULL DEFAULT 'ISSUED_OR_CALCULATED',
  ADD COLUMN "materialPriceSource" "MaterialPriceSource" NOT NULL DEFAULT 'PURCHASE';

ALTER TABLE "Order"
  ADD COLUMN "materialRecognition" "OrderMaterialRecognition" NOT NULL DEFAULT 'BY_CONSUMPTION';

-- Снимок строк материала в документе выпуска: настройки могут смениться, а документ обязан
-- остаться тем, чем был в момент фиксации. Пересчитывать его «по текущим настройкам» значило бы
-- задним числом переписывать сданную себестоимость.
ALTER TABLE "ProductionDocument" ADD COLUMN "materialsSnapshot" JSONB;
