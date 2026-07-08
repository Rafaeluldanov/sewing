-- 2026-07-08 data-fix: O-20260708-0001 — потребности не пересчитались после
-- смены техкарты розовой расцветки.
--
-- Причина (см. fix(colorways) ddbc1dd): правка расцветки в модуле
-- order-colorways писала только OrderVariant и НЕ пересобирала снимок
-- материалов / потребности цеха. Потребности считаются один раз в
-- startCalculation и замораживаются. Розовую расцветку переключили на
-- «…Розовая Сойлу…», но снимок/WorkshopNeed продолжали ссылаться на
-- прежнюю (серую) техкарту.
--
-- Пока код-фикс не задеплоен на прод, у заказа в статусе CALCULATION нет
-- штатного способа пересчитаться (startCalculation требует DRAFT,
-- reopenCalculation — CALCULATION_DONE, order-level правка техкарты
-- заблокирована вне DRAFT). Возвращаем заказ в DRAFT, чтобы менеджер
-- нажал «Перевести в расчёт» — уже задеплоенный startCalculation
-- пересоберёт снимок из ТЕКУЩИХ техкарт расцветок и пересчитает
-- потребности.
--
-- Безопасность: заказ пре-продакшн — нет CuttingTask / Passport /
-- OrderCostEstimate, потребности все в статусе CALCULATED (нет
-- REVIEWED/PURCHASE_PLANNED). Обратимо (повторный расчёт вернёт
-- CALCULATION). Применяется к тенанту default (БД myapp).

UPDATE "Order"
SET status = 'DRAFT'
WHERE number = 'O-20260708-0001'
  AND status = 'CALCULATION';

-- Проверка: должна вернуться одна строка со статусом DRAFT.
SELECT number, status FROM "Order" WHERE number = 'O-20260708-0001';
