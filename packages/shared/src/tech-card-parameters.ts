/**
 * ПАРАМЕТРЫ ТЕХКАРТЫ — именованные слоты в ячейках строк материала.
 *
 * Задача. Сегодня плотность/состав/ширина рулона зашиты в строку шаблона
 * жёстко: чтобы отшить ту же кулирку в 190 г/м² вместо 160, нужен
 * шаблон-близнец. Параметр выносит такую ячейку в переменную, значение
 * которой вводится в ЗАКАЗЕ (на каждой расцветке отдельно). Один шаблон
 * с параметром «плотность» заменяет четыре близнеца.
 *
 * Механизм не новый — это ОБОБЩЕНИЕ `colorRule = ORDER_SELECTED_COLOR`
 * (см. `./tech-cards.ts`): там шаблон уже говорит «спроси менеджера», а
 * снапшот заказа получает пустое поле под ввод. Цвет из-под параметров
 * сознательно ВЫВЕДЕН (см. `TECH_CARD_PARAMETER_TARGETS`): два писателя
 * в одну ячейку — гарантированный баг.
 *
 * НЕ ПУТАТЬ с `PatternCategoryParameter` (`./pattern-categories.ts`):
 * тот про НОРМЫ РАСХОДА ПО РАЗМЕРАМ в номенклатуре (ось = размер), а
 * здесь — СЛОТ В ЯЧЕЙКЕ строки материала (ось = расцветка заказа).
 *
 * Привязка «параметр → ячейка» хранится JSON-колонкой на самой строке
 * (`TechCardMaterialLine.parameterBindings`), а НЕ внешним ключом:
 * `TechCardsService.update` сохраняет шаблон через deleteMany+createMany,
 * поэтому id строк пересоздаются при каждом сейве и FK бы отваливался.
 */

import { z } from 'zod';

import {
  MATERIAL_CHARACTERISTICS,
  legacyColumnsToCharacteristics,
  type MaterialCharacteristics,
  type MaterialCharacteristicValueType,
} from './material-characteristics';

// ---------------------------------------------------------------------------
// Словари
// ---------------------------------------------------------------------------

/** Тип ввода значения параметра. */
export const TECH_CARD_PARAMETER_INPUT_TYPES = [
  'NUMBER',
  'TEXT',
  'ENUM',
] as const;
export const TechCardParameterInputTypeSchema = z.enum(
  TECH_CARD_PARAMETER_INPUT_TYPES,
);
export type TechCardParameterInputType = z.infer<
  typeof TechCardParameterInputTypeSchema
>;
export const TECH_CARD_PARAMETER_INPUT_TYPE_LABELS: Record<
  TechCardParameterInputType,
  string
> = {
  NUMBER: 'Число',
  TEXT: 'Текст',
  ENUM: 'Список',
};

/**
 * Кто владеет параметром. `ERP` — задел под интеграцию с upgifts:
 * такие параметры заполняет коммерсант на своей стороне, а в PLM они
 * приезжают заблокированными. Пока интеграции нет — все `MANUAL`.
 */
export const TECH_CARD_PARAMETER_OWNERS = ['MANUAL', 'ERP'] as const;
export const TechCardParameterOwnerSchema = z.enum(TECH_CARD_PARAMETER_OWNERS);
export type TechCardParameterOwner = z.infer<
  typeof TechCardParameterOwnerSchema
>;

/** Откуда взялось значение (аудит + задел под ERP). */
export const TECH_CARD_PARAMETER_VALUE_SOURCES = [
  'MANUAL',
  'TEMPLATE',
  'ERP',
] as const;
export const TechCardParameterValueSourceSchema = z.enum(
  TECH_CARD_PARAMETER_VALUE_SOURCES,
);
export type TechCardParameterValueSource = z.infer<
  typeof TechCardParameterValueSourceSchema
>;

// ---------------------------------------------------------------------------
// Целевые ячейки (куда параметр подставляется)
// ---------------------------------------------------------------------------

/**
 * Ячейка строки материала, в которую может подставляться параметр.
 *
 * `field` — стабильный ключ вида `core:<колонка>` либо `char:<ключ>`.
 * Префикс обязателен: он разводит «настоящие колонки строки» и ключи
 * внутри `characteristics`-JSON, у которых свои правила зеркалирования.
 */
export interface TechCardParameterTargetDef {
  field: string;
  label: string;
  valueType: MaterialCharacteristicValueType;
  unit?: string;
}

/**
 * Базовые колонки строки. ЦВЕТА здесь нет намеренно: за него отвечает
 * `colorRule` + `selectedColorText` (см. шапку файла).
 */
export const TECH_CARD_PARAMETER_CORE_TARGETS: readonly TechCardParameterTargetDef[] =
  [
    { field: 'core:qtyPerUnit', label: 'Норма расхода на изделие', valueType: 'number' },
    { field: 'core:unit', label: 'Единица измерения', valueType: 'text' },
    { field: 'core:name', label: 'Название материала', valueType: 'text' },
    { field: 'core:note', label: 'Примечание', valueType: 'text' },
    { field: 'core:fabricType', label: 'Тип полотна', valueType: 'text' },
  ] as const;

/**
 * Полный whitelist. Ячейки характеристик ВЫВОДЯТСЯ из
 * `MATERIAL_CHARACTERISTICS`, а не переписываются: единственный источник
 * истины о том, какие ячейки есть у строки, остаётся один. Новая
 * характеристика автоматически становится доступной как цель параметра.
 */
export const TECH_CARD_PARAMETER_TARGETS: readonly TechCardParameterTargetDef[] =
  [
    ...TECH_CARD_PARAMETER_CORE_TARGETS,
    ...MATERIAL_CHARACTERISTICS.map((c) => ({
      field: `char:${c.key}`,
      label: c.label,
      valueType: c.valueType,
      unit: c.unit,
    })),
  ];

const TARGET_BY_FIELD = new Map<string, TechCardParameterTargetDef>(
  TECH_CARD_PARAMETER_TARGETS.map((t) => [t.field, t] as const),
);

export function getTechCardParameterTarget(
  field: string,
): TechCardParameterTargetDef | null {
  return TARGET_BY_FIELD.get(field) ?? null;
}

export function isKnownTechCardParameterTarget(field: string): boolean {
  return TARGET_BY_FIELD.has(field);
}

export const TechCardParameterTargetSchema = z
  .string()
  .refine(isKnownTechCardParameterTarget, {
    message: 'Неизвестная ячейка строки материала для параметра',
  });

// ---------------------------------------------------------------------------
// Ключ параметра и привязки
// ---------------------------------------------------------------------------

/** Ключ параметра: lower_snake, уникален в рамках техкарты. */
export const TECH_CARD_PARAMETER_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;

export const TechCardParameterKeySchema = z
  .string()
  .trim()
  .regex(
    TECH_CARD_PARAMETER_KEY_RE,
    'Ключ параметра: латиница в нижнем регистре, цифры и «_», до 40 символов',
  );

/**
 * Привязки строки материала: `{ "<целевая ячейка>": "<ключ параметра>" }`.
 * Одна ячейка — максимум один параметр (ключ объекта уникален по природе).
 * Один параметр может питать ячейки в нескольких строках — это штатно
 * (два полотна одной плотности).
 */
export const TechCardParameterBindingsSchema = z.record(
  TechCardParameterTargetSchema,
  TechCardParameterKeySchema,
);
export type TechCardParameterBindings = z.infer<
  typeof TechCardParameterBindingsSchema
>;

/** Определение параметра (вход формы шаблона и ad-hoc в заказе). */
export const TechCardParameterInputSchema = z
  .object({
    key: TechCardParameterKeySchema,
    label: z.string().trim().min(1, 'Укажите название параметра').max(120),
    inputType: TechCardParameterInputTypeSchema.default('TEXT'),
    /** Для ENUM — список допустимых значений. */
    options: z.array(z.string().trim().min(1)).max(50).optional(),
    unit: z.string().trim().max(20).nullish(),
    isRequired: z.boolean().default(true),
    defaultValue: z.string().trim().max(200).nullish(),
    owner: TechCardParameterOwnerSchema.default('MANUAL'),
    sortOrder: z.number().int().min(0).max(100000).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.inputType === 'ENUM' && (!v.options || v.options.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options'],
        message: 'Для параметра-списка укажите хотя бы одно значение',
      });
    }
    if (
      v.inputType === 'NUMBER' &&
      v.defaultValue != null &&
      v.defaultValue !== '' &&
      !isFiniteNumeric(v.defaultValue)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['defaultValue'],
        message: 'Значение по умолчанию должно быть числом',
      });
    }
  });
export type TechCardParameterInput = z.infer<
  typeof TechCardParameterInputSchema
>;

// ---------------------------------------------------------------------------
// Ячейки строки материала: нормализация и подстановка
// ---------------------------------------------------------------------------

/**
 * Ячейки строки материала в том виде, в каком они лежат в БД
 * (`TechCardMaterialLine` и снапшот `OrderMaterialRequirement`).
 * `qtyPerUnit` — строка-Decimal, чтобы не терять точность вне Prisma.
 */
export interface MaterialLineCells {
  name: string;
  unit: string;
  qtyPerUnit: string;
  note: string | null;
  materialRole: string | null;
  fabricType: string | null;
  densityGsm: number | null;
  plannedWidthCm: number | null;
  hardwareSizeText: string | null;
  hardwareMaterialText: string | null;
  characteristics: MaterialCharacteristics | null;
}

function isFiniteNumeric(raw: string): boolean {
  const n = Number(raw);
  return Number.isFinite(n);
}

function toPositiveInt(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function toText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/**
 * Привести ячейки к инвариантам БД: роль-зависимая очистка + ЗЕРКАЛО
 * `characteristics` ↔ legacy-колонки.
 *
 * Зеркало критично: downstream (`WorkshopNeedsService`, cut-readiness,
 * себестоимость) читает СТАРЫЕ колонки `densityGsm`/`plannedWidthCm`/
 * `hardware*`, а не JSON. Параметр, записавший только JSON, был бы виден
 * в интерфейсе и НЕ повлиял бы на расчёт закупки — самый дорогой промах
 * в этой фиче, поэтому подстановка обязана проходить через эту функцию.
 *
 * Логика повторяет инварианты `TechCardsService.materialLineCreateData`:
 * density/rollWidth — только для не-PACKAGING, size/material — только для
 * PACKAGING (иначе после смены роли остались бы «висячие» значения).
 */
export function normalizeMaterialLineCells(
  cells: MaterialLineCells,
): MaterialLineCells {
  const merged: MaterialCharacteristics = {
    ...legacyColumnsToCharacteristics({
      densityGsm: cells.densityGsm,
      plannedWidthCm: cells.plannedWidthCm,
      hardwareSizeText: cells.hardwareSizeText,
      hardwareMaterialText: cells.hardwareMaterialText,
    }),
    ...(cells.characteristics ?? {}),
  };

  const isHardwareRole = cells.materialRole === 'PACKAGING';
  const densityGsm = isHardwareRole ? null : toPositiveInt(merged.density);
  const plannedWidthCm = isHardwareRole ? null : toPositiveInt(merged.rollWidth);
  const hardwareSizeText = isHardwareRole ? toText(merged.size) : null;
  const hardwareMaterialText = isHardwareRole ? toText(merged.material) : null;

  const cleaned: MaterialCharacteristics = {};
  if (densityGsm != null) cleaned.density = densityGsm;
  if (plannedWidthCm != null) cleaned.rollWidth = plannedWidthCm;
  if (hardwareSizeText != null) cleaned.size = hardwareSizeText;
  if (hardwareMaterialText != null) cleaned.material = hardwareMaterialText;
  for (const [k, v] of Object.entries(merged)) {
    if (k === 'density' || k === 'rollWidth' || k === 'size' || k === 'material') {
      continue;
    }
    if (v === null || v === undefined || v === '') continue;
    cleaned[k] = v;
  }

  return {
    ...cells,
    densityGsm,
    plannedWidthCm,
    hardwareSizeText,
    hardwareMaterialText,
    characteristics: Object.keys(cleaned).length > 0 ? cleaned : null,
  };
}

/** Значение параметра в заказе (для подстановки). */
export interface TechCardParameterValue {
  key: string;
  value: string | null;
  isRequired: boolean;
  inputType: TechCardParameterInputType;
}

export interface ApplyParametersResult {
  cells: MaterialLineCells;
  /** Ключи обязательных параметров строки, оставшихся без значения. */
  missingRequiredKeys: string[];
}

/**
 * Очистить ячейку, за которую отвечает незаполненный параметр.
 * NOT NULL-колонки (`name`, `unit`, `qtyPerUnit`) не трогаем — их нельзя
 * обнулить, у них остаётся прежнее значение.
 */
function clearCell(cells: MaterialLineCells, field: string): void {
  if (field === 'core:fabricType') {
    cells.fabricType = null;
    return;
  }
  if (field === 'core:note') {
    cells.note = null;
    return;
  }
  if (!field.startsWith('char:')) return;
  const charKey = field.slice('char:'.length);
  if (cells.characteristics) delete cells.characteristics[charKey];
  // Зеркальную legacy-колонку тоже: `normalizeMaterialLineCells` ниже
  // восстановил бы её из старого значения колонки.
  const def = MATERIAL_CHARACTERISTICS.find((c) => c.key === charKey);
  switch (def?.legacyColumn) {
    case 'densityGsm':
      cells.densityGsm = null;
      break;
    case 'plannedWidthCm':
      cells.plannedWidthCm = null;
      break;
    case 'hardwareSizeText':
      cells.hardwareSizeText = null;
      break;
    case 'hardwareMaterialText':
      cells.hardwareMaterialText = null;
      break;
    default:
      break;
  }
}

/**
 * ЕДИНСТВЕННАЯ точка подстановки значений параметров в ячейки строки.
 *
 * ЯЧЕЙКА ПРИНАДЛЕЖИТ ПАРАМЕТРУ. Если параметр не заполнен, ячейка ОЧИЩАЕТСЯ,
 * а не сохраняет значение из шаблона. Иначе получили бы тихо устаревшие
 * данные: технолог стёр плотность, а в снимке осталось прежнее число и уехало
 * в закупку. Значение «по умолчанию» задаётся у самого параметра
 * (`defaultValue`), а не остатком в ячейке — так у значения ровно один
 * владелец.
 *
 * Исключение — NOT NULL-колонки (`name`, `unit`, `qtyPerUnit`): обнулить их
 * нельзя, поэтому у них сохраняется прежнее значение.
 *
 * Незаполненный ОБЯЗАТЕЛЬНЫЙ параметр попадает в `missingRequiredKeys` —
 * заказ не пустят в расчёт (гейт `ORDER_SPEC_INCOMPLETE`).
 */
export function applyParametersToCells(
  base: MaterialLineCells,
  bindings: TechCardParameterBindings | null | undefined,
  valuesByKey: ReadonlyMap<string, TechCardParameterValue>,
): ApplyParametersResult {
  const missingRequiredKeys: string[] = [];
  if (!bindings || Object.keys(bindings).length === 0) {
    return { cells: normalizeMaterialLineCells(base), missingRequiredKeys };
  }

  const next: MaterialLineCells = {
    ...base,
    characteristics: { ...(base.characteristics ?? {}) },
  };

  for (const [field, paramKey] of Object.entries(bindings)) {
    const target = getTechCardParameterTarget(field);
    if (!target) continue; // ячейка исчезла из whitelist — игнорируем

    const param = valuesByKey.get(paramKey);
    if (!param) continue; // параметр не заведён (или удалён) — ячейка как в шаблоне

    const raw = param.value == null ? '' : param.value.trim();
    if (raw === '') {
      if (param.isRequired) missingRequiredKeys.push(paramKey);
      clearCell(next, field);
      continue;
    }

    if (target.valueType === 'number' && !isFiniteNumeric(raw)) {
      // Нечисловое значение в числовой ячейке: не подставляем, но и не
      // объявляем «незаполненным» — это ошибка валидации на записи.
      continue;
    }

    if (field.startsWith('char:')) {
      const charKey = field.slice('char:'.length);
      const chars = next.characteristics ?? {};
      chars[charKey] = target.valueType === 'number' ? Number(raw) : raw;
      next.characteristics = chars;
      continue;
    }

    switch (field) {
      case 'core:qtyPerUnit':
        next.qtyPerUnit = raw;
        break;
      case 'core:unit':
        next.unit = raw;
        break;
      case 'core:name':
        next.name = raw;
        break;
      case 'core:note':
        next.note = raw;
        break;
      case 'core:fabricType':
        next.fabricType = raw;
        break;
      default:
        break;
    }
  }

  // Зеркало + роль-очистка — обязательно после подстановки (см. JSDoc
  // `normalizeMaterialLineCells`).
  return { cells: normalizeMaterialLineCells(next), missingRequiredKeys };
}

/**
 * Все ключи параметров, на которые ссылается строка. Нужен валидации
 * («в биндингах нет ключа, которого нет среди параметров техкарты») и
 * подсчёту незаполненного в UI.
 */
export function collectBoundParameterKeys(
  bindings: TechCardParameterBindings | null | undefined,
): string[] {
  if (!bindings) return [];
  return Array.from(new Set(Object.values(bindings)));
}

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

/** Параметр в справочнике техкарт. */
export interface TechCardParameterDto {
  id: string;
  key: string;
  label: string;
  inputType: TechCardParameterInputType;
  options: string[] | null;
  unit: string | null;
  isRequired: boolean;
  defaultValue: string | null;
  owner: TechCardParameterOwner;
  sortOrder: number;
}

/** Параметр внутри заказа: определение + значение на расцветке. */
export interface OrderTechCardParameterDto extends TechCardParameterDto {
  orderVariantId: string | null;
  value: string | null;
  valueSource: TechCardParameterValueSource;
  /** true — параметр заведён в заказе, а не пришёл из шаблона. */
  isAdHoc: boolean;
  /** Ячейки, в которые он подставляется: «Полотно основное → плотность». */
  targets: Array<{ requirementId: string; lineName: string; field: string; fieldLabel: string }>;
}
