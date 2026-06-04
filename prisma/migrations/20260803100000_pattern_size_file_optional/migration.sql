-- Размер номенклатуры можно добавить БЕЗ файла лекала (заглушка):
-- файл (PDF/PLT/DXF) догружается позже, в т.ч. после запуска заказа.
-- Делаем fileUrl/originalFileName необязательными. Существующие записи
-- не трогаем (у них значения уже заполнены).
ALTER TABLE "PatternSizeFile" ALTER COLUMN "fileUrl" DROP NOT NULL;
ALTER TABLE "PatternSizeFile" ALTER COLUMN "originalFileName" DROP NOT NULL;
