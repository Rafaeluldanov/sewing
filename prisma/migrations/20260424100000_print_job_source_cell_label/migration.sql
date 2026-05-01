-- Добавляем CELL_LABEL в enum PrintJobSource (см. docs/api.md §15,
-- docs/screens.md §10b, README «Post-Шаг 23 — Массовая печать ячеек
-- склада»). Это значение используется массовой печатью «Печать всех
-- ячеек» из карточки склада: payloadUrl job-а указывает на готовую
-- HTML-этикетку 38×58 (`/api/cells/:id/print`).
--
-- Изменение чисто additive — старые записи (`PASSPORT_QR`, ...,
-- `CELL_QR`, `TEST`) остаются валидными, существующие потребители
-- enum-а продолжают работать.

ALTER TYPE "PrintJobSource" ADD VALUE IF NOT EXISTS 'CELL_LABEL';
