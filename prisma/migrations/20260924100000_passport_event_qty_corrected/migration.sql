-- Новый тип события паспорта: `QTY_CORRECTED` — ОТК скорректировал
-- фактическое количество по паспорту, мастер цеха подтвердил
-- (см. `model PassportQtyCorrection`, модуль `passport-qty-corrections`).
--
-- ВАЖНО: `ALTER TYPE ... ADD VALUE` нельзя выполнять внутри транзакции,
-- поэтому расширение enum вынесено в ОТДЕЛЬНУЮ «raw»-миграцию с одним
-- `ALTER TYPE` (тот же приём, что `20260905100000_salary_source_recut`).
-- Создание самого справочника заявок — в следующей миграции
-- `20260924100010_passport_qty_corrections`.

ALTER TYPE "PassportEventType" ADD VALUE IF NOT EXISTS 'QTY_CORRECTED';
