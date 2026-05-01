/**
 * Frontend-хелперы для seamstress flow на /work.
 *
 * Источник истины «оборудование → разрешённые операции» — теперь
 * backend (таблица `EquipmentOperation`, см. ADR-0017). Старый
 * mapping по префиксу `Equipment.code` удалён: набор приходит в
 * `EquipmentLiteDto.allowedOperationIds` через `GET /api/shifts/meta`.
 *
 * Здесь остался только UI-helper для распаковки QR оборудования
 * (формат ADR-0008 `equipment:{id}` плюс fallback на голый id/code).
 */
import type {
  EquipmentLiteDto,
  OperationLiteDto,
} from '@sewing/shared/shifts';

/**
 * Возвращает упорядоченный список операций, разрешённых для данной
 * единицы оборудования. Порядок берётся из `allowedOperationIds`
 * (его задаёт backend через `EquipmentOperation.sortOrder`). Из
 * результата исключаются неактивные операции — на /work их быть не
 * должно.
 */
export function operationsForEquipment(
  equipment: EquipmentLiteDto,
  allOperations: readonly OperationLiteDto[],
): OperationLiteDto[] {
  const byId = new Map(allOperations.map((o) => [o.id, o] as const));
  const out: OperationLiteDto[] = [];
  for (const id of equipment.allowedOperationIds) {
    const op = byId.get(id);
    if (op && op.active) out.push(op);
  }
  return out;
}

/**
 * Парсит произвольный QR/код оборудования и пытается найти соответствие
 * в списке `meta.equipment`. Поддерживаемые форматы:
 *   - `equipment:{id}`  — формат seed (см. ADR-0008);
 *   - голый `id`        — сырая строка, если QR уже распарсен;
 *   - `code`            — человекочитаемый код (overlock-01 и т.п.).
 */
export function matchEquipmentByCode(
  equipment: readonly EquipmentLiteDto[],
  raw: string,
): EquipmentLiteDto | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const value = trimmed.startsWith('equipment:')
    ? trimmed.slice('equipment:'.length)
    : trimmed;
  return (
    equipment.find((eq) => eq.id === value || eq.code === value) ?? null
  );
}
