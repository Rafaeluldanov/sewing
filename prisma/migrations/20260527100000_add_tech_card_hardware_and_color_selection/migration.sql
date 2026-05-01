-- Этап «Доработка UI и контракта техкарты» (см. ТЗ «UI и контракт
-- техкарты»):
--   * Фурнитура (`materialRole = PACKAGING`): дополнительные поля
--     `hardwareSizeText` / `hardwareMaterialText`.
--   * Изображение материала: `materialImageUrl` /
--     `materialImageOriginalFileName`.
--   * Правило цвета «Указать в заказе»: snapshot-флаг
--     `requiresColorSelection` + поле `selectedColorText` для
--     введённого менеджером значения по конкретной строке заказа.
--
-- Все колонки nullable / boolean default false, без миграции данных:
-- старые техкарты и snapshot-строки заказов остаются валидными как
-- есть. WorkshopNeed / PatternMaterialArea / OrderCostEstimate /
-- PurchaseOrder / PurchaseReceipt / Payroll / Passport не трогаем
-- (см. ТЗ §«Что НЕ трогать»).

-- Тех-карта: новые nullable поля строки материала.
ALTER TABLE "TechCardMaterialLine"
  ADD COLUMN "hardwareSizeText"              TEXT,
  ADD COLUMN "hardwareMaterialText"          TEXT,
  ADD COLUMN "materialImageUrl"              TEXT,
  ADD COLUMN "materialImageOriginalFileName" TEXT;

-- Snapshot заказа: флаг «требуется выбрать цвет» + сам цвет, который
-- менеджер ввёл по строке. `requiresColorSelection` — boolean с
-- default false, `selectedColorText` — nullable string. Дополнительно
-- snapshot-копии новых полей `TechCardMaterialLine` — на случай,
-- если в техкарте они задавались (для PACKAGING).
ALTER TABLE "OrderMaterialRequirement"
  ADD COLUMN "requiresColorSelection"        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "selectedColorText"             TEXT,
  ADD COLUMN "hardwareSizeText"              TEXT,
  ADD COLUMN "hardwareMaterialText"          TEXT,
  ADD COLUMN "materialImageUrl"              TEXT,
  ADD COLUMN "materialImageOriginalFileName" TEXT;
