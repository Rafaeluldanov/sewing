-- Привязка операции «Раскрой» (CUT_CUT) к раскройному столу
-- `cutting-table-01` — нужна для смены раскройщика.
--
-- Контекст: раскрой стал scan-shift ролью — раскройщик на `/cutter`
-- сканирует QR раскройного стола и открывает смену (табель + часовая
-- оплата для SALARY/MIXED). Форма старта смены показывает только
-- операции из allow-листа `EquipmentOperation` для этого Equipment
-- (ADR-0017). До этой строки у `cutting-table-01` были только
-- подготовительные операции (CUT_DIVISION/CUT_BASE_PREP/...), но не
-- сам «Раскрой», поэтому смену нельзя было открыть на CUT_CUT.
--
-- В `prisma/seed.ts` CUT_CUT уже добавлен первым в `allowedOperations`
-- стола, так что свежий `db:seed` создаёт связь сам. Этот скрипт —
-- для уже существующих БД (dev/prod), где seed повторно не гоняется.
--
-- sortOrder = 5 (< существующих 10/20/...), чтобы «Раскрой» шёл первым
-- в списке выбора и пред-выбирался одной рукой. Существующие строки
-- не трогаем.
--
-- Идемпотентно: WHERE NOT EXISTS по паре (equipmentId, operationId) +
-- ON CONFLICT (id) DO NOTHING. id детерминированный.

BEGIN;

INSERT INTO "EquipmentOperation" (
  id, "equipmentId", "operationId", "sortOrder", "isActive", "createdAt", "updatedAt"
)
SELECT
  'eqop_cuttbl01_cutcut',
  eq.id,
  op.id,
  5,
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Equipment" eq
CROSS JOIN "Operation" op
WHERE eq.code = 'cutting-table-01'
  AND op.code = 'CUT_CUT'
  AND NOT EXISTS (
    SELECT 1 FROM "EquipmentOperation" link
    WHERE link."equipmentId" = eq.id
      AND link."operationId" = op.id
  )
ON CONFLICT (id) DO NOTHING;

COMMIT;
