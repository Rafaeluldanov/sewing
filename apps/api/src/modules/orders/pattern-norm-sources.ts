import type { PatternNormSource } from '@sewing/shared/pattern-norms';

/**
 * Сбор источников норм из карточки номенклатуры в один плоский список.
 *
 * Три блока карточки лекала описывают норму по-разному, но для спецификации
 * заказа они равноправны:
 *   - «Фурнитура и нормы» (`PatternItemParameterNorm`, `QTY_PER_ITEM`) — число
 *     на изделие;
 *   - «Погонные метры по размерам» (`PatternItemSizeParameterValue`,
 *     `LINEAR_M_BY_SIZE`) — по значению на каждый размер;
 *   - площади (`PatternMaterialArea`) — м² на изделие по каждому размеру,
 *     сгруппированы по роли материала (имени параметра у них нет).
 *
 * Дальше со списком работает чистое правило из
 * `@sewing/shared/pattern-norms` — оно же используется и на чтении DTO, и на
 * пересборке снимка, чтобы «норма из номенклатуры» везде значила одно и то же.
 *
 * Decimal переводим в number сразу: правило сопоставления и средневзвешенная
 * норма — чистая арифметика, а в БД число всё равно ляжет как `Decimal(12,4)`.
 */
export interface PatternNormPrismaInput {
  parameterNorms: Array<{
    id: string;
    roleKey: string;
    labelSnapshot: string;
    inputTypeSnapshot: string;
    unit: string;
    qtyPerItem: { toString(): string };
  }>;
  sizeParameterValues: Array<{
    categoryParameterId: string;
    roleKey: string;
    labelSnapshot: string;
    inputTypeSnapshot: string;
    unit: string;
    sizeId: string;
    value: { toString(): string };
  }>;
  materialAreas: Array<{
    materialRole: string;
    sizeId: string;
    areaM2: { toString(): string };
  }>;
}

function toNumber(v: { toString(): string }): number {
  const n = Number(v.toString());
  return Number.isFinite(n) ? n : 0;
}

export function collectPatternNormSources(
  patternItem: PatternNormPrismaInput | null | undefined,
): PatternNormSource[] {
  if (!patternItem) return [];
  const sources: PatternNormSource[] = [];

  for (const norm of patternItem.parameterNorms) {
    if (norm.inputTypeSnapshot !== 'QTY_PER_ITEM') continue;
    const qty = toNumber(norm.qtyPerItem);
    if (qty <= 0) continue;
    sources.push({
      sourceId: norm.id,
      kind: 'QTY_PER_ITEM',
      roleKey: norm.roleKey,
      label: norm.labelSnapshot,
      unit: norm.unit,
      qtyPerItem: qty,
    });
  }

  // Погонные метры: одна строка-источник на ПАРАМЕТР (значений по размерам
  // много), ровно как их группирует расчёт потребности.
  const linearByParam = new Map<string, PatternNormSource>();
  for (const v of patternItem.sizeParameterValues) {
    if (v.inputTypeSnapshot !== 'LINEAR_M_BY_SIZE') continue;
    const value = toNumber(v.value);
    if (value <= 0) continue;
    const existing = linearByParam.get(v.categoryParameterId);
    if (existing) {
      (existing.bySize as Array<{ sizeId: string; value: number }>).push({
        sizeId: v.sizeId,
        value,
      });
      continue;
    }
    linearByParam.set(v.categoryParameterId, {
      sourceId: v.categoryParameterId,
      kind: 'LINEAR_M_BY_SIZE',
      roleKey: v.roleKey,
      label: v.labelSnapshot,
      unit: v.unit,
      bySize: [{ sizeId: v.sizeId, value }],
    });
  }
  sources.push(...linearByParam.values());

  // Площади: группируем по роли — `sourceId` = роль (так же, как
  // `WorkshopNeed.sourceId` для `PATTERN_MATERIAL_AREA`).
  const areaByRole = new Map<string, PatternNormSource>();
  for (const a of patternItem.materialAreas) {
    const value = toNumber(a.areaM2);
    if (value <= 0) continue;
    const existing = areaByRole.get(a.materialRole);
    if (existing) {
      (existing.bySize as Array<{ sizeId: string; value: number }>).push({
        sizeId: a.sizeId,
        value,
      });
      continue;
    }
    areaByRole.set(a.materialRole, {
      sourceId: a.materialRole,
      kind: 'AREA_M2_BY_SIZE',
      roleKey: a.materialRole,
      label: null,
      unit: 'м²',
      bySize: [{ sizeId: a.sizeId, value }],
    });
  }
  sources.push(...areaByRole.values());

  return sources;
}
