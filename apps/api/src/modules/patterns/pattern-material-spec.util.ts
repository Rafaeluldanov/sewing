import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  legacyColumnsToCharacteristics,
  type MaterialCharacteristics,
} from '@sewing/shared/material-characteristics';
import { isKnownTechCardMaterialRoleKey } from '@sewing/shared/tech-cards';
import type {
  PatternItemMaterialLineInput,
  PatternItemSpecParameterInput,
} from '@sewing/shared/pattern-item-spec';

/**
 * Нормализация строки СОСТАВА МАТЕРИАЛОВ номенклатуры перед записью.
 *
 * Адаптация `TechCardsService.materialLineCreateData` (этап 1 плана
 * «техкарты → номенклатура»): та же роль-зависимая очистка полей, то же
 * зеркалирование `characteristics` ↔ legacy-колонки — снапшотный конвейер
 * заказа (этап 3) должен читать строку номенклатуры бит-в-бит как строку
 * техкарты. Дублирование с техкартой сознательное и временное: исходник
 * умирает на этапе 5 вместе с модулем tech-cards.
 *
 * Отличие одно: строка номенклатуры редактирует `normUnit` (единицу НОРМЫ
 * при закупке в другой единице) прямо в форме.
 */
export function patternMaterialLineCreateData(
  patternItemId: string,
  line: PatternItemMaterialLineInput,
  index: number,
  opts: { existingRoleKeys?: ReadonlySet<string> } = {},
): Prisma.PatternItemMaterialLineCreateManyInput {
  // Инвариант: «фиксированный цвет имеет смысл только при FIXED_COLOR» —
  // сервис зачищает поле даже если форма по ошибке его прислала.
  const colorRule = line.colorRule ?? null;
  const fixedColorText =
    colorRule === 'FIXED_COLOR' ? line.fixedColorText ?? null : null;
  // Hardware-поля имеют смысл только для роли PACKAGING (фурнитура).
  const isHardwareRole = line.materialRole === 'PACKAGING';
  // `characteristics` — источник истины, если форма их прислала; иначе
  // собираем из явных legacy-полей (backward-compat). Затем зеркалим
  // legacy-колонки из characteristics — downstream читает плоские колонки.
  const sentChars =
    line.characteristics && Object.keys(line.characteristics).length > 0
      ? line.characteristics
      : null;
  const chars: MaterialCharacteristics = {
    ...legacyColumnsToCharacteristics({
      densityGsm: line.densityGsm,
      plannedWidthCm: line.plannedWidthCm,
      hardwareSizeText: line.hardwareSizeText,
      hardwareMaterialText: line.hardwareMaterialText,
    }),
    ...(sentChars ?? {}),
  };
  const toInt = (v: unknown): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
  };
  const toText = (v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    return s === '' ? null : s;
  };
  // Роль-зависимая очистка: density/rollWidth — только для не-PACKAGING;
  // size/material — только для PACKAGING.
  const densityGsm = isHardwareRole ? null : toInt(chars.density);
  const plannedWidthCm = isHardwareRole ? null : toInt(chars.rollWidth);
  const hardwareSizeText = isHardwareRole ? toText(chars.size) : null;
  const hardwareMaterialText = isHardwareRole ? toText(chars.material) : null;
  // Итоговый characteristics: зеркало legacy-колонок (после роль-очистки)
  // + прочие характеристики из присланных формой.
  const cleanedChars: MaterialCharacteristics = {};
  if (densityGsm != null) cleanedChars.density = densityGsm;
  if (plannedWidthCm != null) cleanedChars.rollWidth = plannedWidthCm;
  if (hardwareSizeText != null) cleanedChars.size = hardwareSizeText;
  if (hardwareMaterialText != null) cleanedChars.material = hardwareMaterialText;
  for (const [k, v] of Object.entries(chars)) {
    if (k === 'density' || k === 'rollWidth' || k === 'size' || k === 'material') {
      continue;
    }
    if (v === null || v === undefined || v === '') continue;
    cleanedChars[k] = v;
  }
  const characteristics =
    Object.keys(cleanedChars).length > 0 ? cleanedChars : null;
  // Роль для НОВЫХ строк — из `PATTERN_CATEGORY_PARAMETER_GROUPS`
  // (whitelist `TECH_CARD_MATERIAL_ROLE_KEYS`). Legacy-роли, уже лежащие
  // в БД (например, `APPLICATION` из бэкфилла техкарт — этап 2),
  // пропускаем при full-replace без проверки — менеджер должен уметь
  // сохранить карточку, не редактируя legacy-строку.
  const role = line.materialRole ?? null;
  if (role !== null) {
    const allowed = isKnownTechCardMaterialRoleKey(role);
    const isLegacyKept = opts.existingRoleKeys?.has(role) ?? false;
    if (!allowed && !isLegacyKept) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'PATTERN_MATERIAL_ROLE_INVALID',
        message: `Роль материала «${role}» не входит в список доступных. Используйте роли из групп номенклатуры.`,
      });
    }
  }
  const normUnitRaw = line.normUnit == null ? null : line.normUnit.trim();
  const unit = line.unit;
  return {
    patternItemId,
    sortOrder: (index + 1) * 10,
    name: line.name,
    unit,
    // Пустая строка и «совпадает с закупочной» = нет расщепления единиц.
    normUnit:
      normUnitRaw && normUnitRaw.length > 0 && normUnitRaw !== unit
        ? normUnitRaw
        : null,
    qtyPerUnit: new Prisma.Decimal(line.qtyPerUnit ?? '0'),
    note: line.note,
    materialRole: role,
    fabricType: line.fabricType ?? null,
    densityGsm,
    plannedWidthCm,
    colorRule,
    fixedColorText,
    hardwareSizeText,
    hardwareMaterialText,
    materialImageUrl: line.materialImageUrl ?? null,
    materialImageOriginalFileName: line.materialImageOriginalFileName ?? null,
    subtypeKey:
      line.subtypeKey && line.subtypeKey.length ? line.subtypeKey : null,
    characteristics: characteristics ?? Prisma.DbNull,
    parameterBindings:
      line.parameterBindings && Object.keys(line.parameterBindings).length > 0
        ? (line.parameterBindings as Prisma.InputJsonValue)
        : Prisma.DbNull,
  };
}

/**
 * Нормализация слота-параметра спецификации (зеркало
 * `TechCardsService.parameterCreateData`).
 */
export function patternSpecParameterCreateData(
  patternItemId: string,
  p: PatternItemSpecParameterInput,
  index: number,
): Prisma.PatternItemSpecParameterCreateManyInput {
  return {
    patternItemId,
    key: p.key,
    label: p.label,
    inputType: p.inputType,
    options:
      p.inputType === 'ENUM' && p.options && p.options.length > 0
        ? (p.options as Prisma.InputJsonValue)
        : Prisma.DbNull,
    unit: p.unit ?? null,
    isRequired: p.isRequired,
    defaultValue: p.defaultValue ?? null,
    owner: p.owner,
    // Тот же порядок нормализации, что у строк: (i + 1) * 10.
    sortOrder: p.sortOrder ?? (index + 1) * 10,
  };
}
