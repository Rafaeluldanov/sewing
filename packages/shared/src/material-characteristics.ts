/**
 * Справочник характеристик номенклатуры материалов (Фаза 0).
 *
 * Источник истины — спецификация TEEON.pdf: каждый ПОДТИП материала
 * («Параметр» в терминах PDF: Молния, Кнопка, Дублерин, Синтепон,
 * Кашкорсе, ...) принадлежит ГРУППЕ (`roleKey` из
 * `PATTERN_CATEGORY_PARAMETER_GROUPS`, см. `./pattern-categories.ts`)
 * и несёт фиксированный набор характеристик с правилами обязательности.
 *
 * Архитектура (решение пользователя): таксономия живёт в shared-конфиге,
 * без БД-таблиц, по образцу `PATTERN_CATEGORY_PARAMETER_GROUPS`.
 * Расширение списка подтипов/характеристик не требует миграции схемы.
 *
 * ЦВЕТ сознательно НЕ моделируется здесь как характеристика: он уже
 * управляется механизмом `colorRule`/`fixedColorText`/`resolvedColorText`
 * на строке техкарты и в снапшоте заказа (см.
 * `TECH_CARD_MATERIAL_COLOR_RULES` в `./tech-cards.ts`). В PDF «Цвет»
 * указан почти у каждого подтипа — он считается универсальным и
 * покрывается существующим colorRule, а не дублируется в `characteristics`.
 *
 * Хранение ЗНАЧЕНИЙ характеристик (`characteristics Json` на
 * `TechCardMaterialLine`/снапшотах) и динамическая форма — Фазы 1–2.
 */

import { z } from 'zod';

import type { PatternCategoryParameterInputType } from './pattern-categories';

// ---------------------------------------------------------------------------
// Каталог характеристик
// ---------------------------------------------------------------------------

/** Тип значения характеристики. */
export type MaterialCharacteristicValueType = 'text' | 'number';

/**
 * Legacy-колонка `TechCardMaterialLine`, в которую характеристика
 * зеркалируется в Фазе 1 (downstream — cut-readiness, costing — читают
 * старые колонки, поэтому они остаются заполнены).
 */
export type MaterialCharacteristicLegacyColumn =
  | 'densityGsm'
  | 'plannedWidthCm'
  | 'hardwareSizeText'
  | 'hardwareMaterialText';

export interface MaterialCharacteristicDef {
  /** Технический ключ (camelCase), пишется в `characteristics`-JSON. */
  key: string;
  /** Человекочитаемый лейбл для UI (шапка поля формы). */
  label: string;
  valueType: MaterialCharacteristicValueType;
  /** Единица значения (для number): г/м², см, мм. Для text — undefined. */
  unit?: string;
  /** Куда зеркалировать в Фазе 1 (если есть соответствие). */
  legacyColumn?: MaterialCharacteristicLegacyColumn;
}

/**
 * Полный набор характеристик из PDF (стр. 3), кроме «Цвета»
 * (см. шапку файла). `densityGsm`/`plannedWidthCm`/`hardwareSizeText`/
 * `hardwareMaterialText` имеют legacy-колонки; остальные (`width`,
 * `thickness`, `type`, `length`, `holesCount`) — новые, колонок нет,
 * живут только в `characteristics`-JSON.
 */
export const MATERIAL_CHARACTERISTICS: readonly MaterialCharacteristicDef[] = [
  {
    key: 'density',
    label: 'Плотность',
    valueType: 'number',
    unit: 'г/м²',
    legacyColumn: 'densityGsm',
  },
  {
    key: 'rollWidth',
    label: 'Ширина рулона',
    valueType: 'number',
    unit: 'см',
    legacyColumn: 'plannedWidthCm',
  },
  {
    // Ширина лент/фурнитуры (стропа, лента, кант, резинка, паутинка,
    // клеевая кромка) — это НЕ ширина рулона полотна.
    key: 'width',
    label: 'Ширина',
    valueType: 'number',
    unit: 'мм',
  },
  {
    // Толщина: нитки = текст («50/2»), шнур/шляпная резинка = мм —
    // поэтому text, чтобы принять оба формата.
    key: 'thickness',
    label: 'Толщина',
    valueType: 'text',
  },
  { key: 'type', label: 'Тип', valueType: 'text' },
  {
    key: 'material',
    label: 'Материал',
    valueType: 'text',
    legacyColumn: 'hardwareMaterialText',
  },
  {
    key: 'size',
    label: 'Размер',
    valueType: 'text',
    legacyColumn: 'hardwareSizeText',
  },
  { key: 'length', label: 'Длина', valueType: 'number', unit: 'см' },
  {
    key: 'holesCount',
    label: 'Количество проколов',
    valueType: 'number',
  },
] as const;

const CHARACTERISTIC_BY_KEY = new Map<string, MaterialCharacteristicDef>(
  MATERIAL_CHARACTERISTICS.map((c) => [c.key, c] as const),
);

export function getMaterialCharacteristic(
  key: string,
): MaterialCharacteristicDef | null {
  return CHARACTERISTIC_BY_KEY.get(key) ?? null;
}

// ---------------------------------------------------------------------------
// Подтипы материалов
// ---------------------------------------------------------------------------

export interface MaterialSubtypeCharacteristic {
  /** Ключ из `MATERIAL_CHARACTERISTICS`. */
  key: string;
  /** Обязательна всегда. */
  required?: boolean;
  /**
   * Обязательна только если единица материала = «кг» (правило PDF
   * «ЕСЛИ КГ»: для полотен нужны ширина рулона + плотность, чтобы
   * пересчитать кг ↔ м пог.).
   */
  requiredIfUnitKg?: boolean;
}

export interface MaterialSubtypeConfig {
  /** Технический ключ подтипа (UPPER_SNAKE), пишется в `subtypeKey`. */
  subtypeKey: string;
  /** Человекочитаемый лейбл («Молния», «Кашкорсе», ...). */
  label: string;
  /** `roleKey` группы из `PATTERN_CATEGORY_PARAMETER_GROUPS`. */
  groupRoleKey: string;
  /** Единица, которую форма подставляет по умолчанию. */
  defaultUnit: string;
  /** Допустимые единицы (подмножество `allowedUnits` группы). */
  allowedUnits: readonly string[];
  /**
   * Тип ввода в номенклатуре по TEEON.pdf для ЭТОГО подтипа. Внутри
   * одной группы он может различаться: синтепон вводится «по размерам»
   * (`LINEAR_M_BY_SIZE`, «м пог.»), а искусственный пух — нормой
   * «кг на изделие» (`QTY_PER_ITEM`). При выборе подтипа в форме
   * категории это значение подставляется в колонку «Ввод». Обязан
   * входить в `allowedInputTypes` своей группы
   * (`PATTERN_CATEGORY_PARAMETER_GROUPS[groupRoleKey]`).
   */
  defaultInputType: PatternCategoryParameterInputType;
  /** Применимые характеристики (без «Цвета» — он через colorRule). */
  characteristics: readonly MaterialSubtypeCharacteristic[];
}

// Хелперы сборки записей (сокращают повторы ниже).
const fabricChars: readonly MaterialSubtypeCharacteristic[] = [
  { key: 'rollWidth', requiredIfUnitKg: true },
  { key: 'density', requiredIfUnitKg: true },
];

/**
 * Подтипы из PDF. `groupRoleKey` совпадает с `roleKey` групп в
 * `PATTERN_CATEGORY_PARAMETER_GROUPS`. Для одногрупповых сущностей
 * (полотна, подкладка) подтип = сама группа.
 *
 * ВНИМАНИЕ: группа MARKING (Маркировка) в PDF не раскрыта (нет
 * подтипов/характеристик) — отложена в Фазу 3 после уточнения.
 */
export const MATERIAL_SUBTYPES: readonly MaterialSubtypeConfig[] = [
  // --- Полотна (Цвет; ЕСЛИ КГ → ширина рулона + плотность) ---------------
  {
    subtypeKey: 'MAIN_FABRIC',
    defaultInputType: 'LINEAR_M_BY_SIZE',
    label: 'Основное полотно',
    groupRoleKey: 'MAIN_FABRIC',
    defaultUnit: 'м пог.',
    allowedUnits: ['м пог.', 'кг', 'м²'],
    characteristics: fabricChars,
  },
  {
    subtypeKey: 'ADDITIONAL_FABRIC',
    defaultInputType: 'LINEAR_M_BY_SIZE',
    label: 'Дополнительное полотно',
    groupRoleKey: 'ADDITIONAL_FABRIC',
    defaultUnit: 'м пог.',
    allowedUnits: ['м пог.', 'кг', 'м²'],
    characteristics: fabricChars,
  },
  {
    subtypeKey: 'LINING',
    defaultInputType: 'LINEAR_M_BY_SIZE',
    label: 'Подкладка',
    groupRoleKey: 'LINING',
    defaultUnit: 'м пог.',
    allowedUnits: ['м пог.', 'кг', 'м²'],
    characteristics: fabricChars,
  },
  // --- Рибана / кашкорсе (Цвет) -----------------------------------------
  // Ширина/плотность как у полотен: словарь разрешает «кг», а пересчёт в
  // него требует обеих характеристик — пустой набор здесь приводил к тому,
  // что смена подтипа вычищала уже заполненные rollWidth/density.
  {
    subtypeKey: 'RIB',
    defaultInputType: 'LINEAR_M_BY_SIZE',
    label: 'Рибана',
    groupRoleKey: 'RIB',
    defaultUnit: 'м пог.',
    allowedUnits: ['м пог.', 'кг', 'м²'],
    characteristics: fabricChars,
  },
  {
    subtypeKey: 'KASHKORSE',
    defaultInputType: 'LINEAR_M_BY_SIZE',
    label: 'Кашкорсе',
    groupRoleKey: 'RIB',
    defaultUnit: 'м пог.',
    allowedUnits: ['м пог.', 'кг', 'м²'],
    characteristics: fabricChars,
  },
  // --- Клеевые материалы -------------------------------------------------
  {
    subtypeKey: 'DUBLERIN',
    defaultInputType: 'LINEAR_M_BY_SIZE',
    label: 'Дублерин',
    groupRoleKey: 'INTERLINING',
    defaultUnit: 'м пог.',
    allowedUnits: ['м пог.', 'м²', 'кг'],
    characteristics: [{ key: 'density', required: true }],
  },
  {
    subtypeKey: 'FLIZELIN',
    defaultInputType: 'LINEAR_M_BY_SIZE',
    label: 'Флизелин',
    groupRoleKey: 'INTERLINING',
    defaultUnit: 'м пог.',
    allowedUnits: ['м пог.', 'м²', 'кг'],
    characteristics: [{ key: 'density', required: true }],
  },
  {
    subtypeKey: 'PAUTINKA',
    defaultInputType: 'LINEAR_M_BY_SIZE',
    label: 'Паутинка',
    groupRoleKey: 'INTERLINING',
    defaultUnit: 'м',
    allowedUnits: ['м'],
    characteristics: [{ key: 'width', required: true }],
  },
  {
    subtypeKey: 'GLUE_EDGE',
    defaultInputType: 'LINEAR_M_BY_SIZE',
    label: 'Клеевая кромка',
    groupRoleKey: 'INTERLINING',
    defaultUnit: 'м',
    allowedUnits: ['м'],
    characteristics: [{ key: 'width', required: true }],
  },
  {
    subtypeKey: 'BORTOVKA',
    defaultInputType: 'LINEAR_M_BY_SIZE',
    label: 'Бортовка',
    groupRoleKey: 'INTERLINING',
    defaultUnit: 'м пог.',
    allowedUnits: ['м пог.', 'м²', 'кг'],
    characteristics: [{ key: 'density', required: true }],
  },
  // --- Наполнитель -------------------------------------------------------
  {
    subtypeKey: 'SINTEPON',
    defaultInputType: 'LINEAR_M_BY_SIZE',
    label: 'Синтепон',
    groupRoleKey: 'FILLER',
    defaultUnit: 'м пог.',
    allowedUnits: ['м пог.', 'кг'],
    characteristics: [{ key: 'density', required: true }],
  },
  {
    subtypeKey: 'ARTIFICIAL_DOWN',
    defaultInputType: 'QTY_PER_ITEM',
    label: 'Искусственный пух',
    groupRoleKey: 'FILLER',
    defaultUnit: 'кг',
    allowedUnits: ['кг'],
    characteristics: [],
  },
  // --- Нитки -------------------------------------------------------------
  {
    subtypeKey: 'THREAD',
    defaultInputType: 'QTY_PER_ITEM',
    label: 'Нитки',
    groupRoleKey: 'THREAD',
    defaultUnit: 'м',
    allowedUnits: ['м'],
    characteristics: [{ key: 'thickness', required: true }],
  },
  // --- Фурнитура ---------------------------------------------------------
  {
    subtypeKey: 'ZIPPER',
    defaultInputType: 'QTY_PER_ITEM',
    label: 'Молния',
    groupRoleKey: 'PACKAGING',
    defaultUnit: 'шт',
    allowedUnits: ['шт'],
    characteristics: [
      { key: 'type' },
      { key: 'material' },
      { key: 'size' },
      { key: 'length' },
    ],
  },
  {
    subtypeKey: 'SNAP_BUTTON',
    defaultInputType: 'QTY_PER_ITEM',
    label: 'Кнопка',
    groupRoleKey: 'PACKAGING',
    defaultUnit: 'шт',
    allowedUnits: ['шт'],
    characteristics: [{ key: 'type' }, { key: 'material' }, { key: 'size' }],
  },
  {
    subtypeKey: 'EYELET',
    defaultInputType: 'QTY_PER_ITEM',
    label: 'Люверс',
    groupRoleKey: 'PACKAGING',
    defaultUnit: 'шт',
    allowedUnits: ['шт'],
    characteristics: [{ key: 'material' }, { key: 'size' }],
  },
  {
    subtypeKey: 'FASTEX',
    defaultInputType: 'QTY_PER_ITEM',
    label: 'Фастекс',
    groupRoleKey: 'PACKAGING',
    defaultUnit: 'шт',
    allowedUnits: ['шт'],
    characteristics: [{ key: 'material' }, { key: 'size' }],
  },
  {
    subtypeKey: 'CORD_LOCK',
    defaultInputType: 'QTY_PER_ITEM',
    label: 'Фиксатор',
    groupRoleKey: 'PACKAGING',
    defaultUnit: 'шт',
    allowedUnits: ['шт'],
    characteristics: [{ key: 'material' }, { key: 'size' }],
  },
  {
    subtypeKey: 'RING',
    defaultInputType: 'QTY_PER_ITEM',
    label: 'Кольцо',
    groupRoleKey: 'PACKAGING',
    defaultUnit: 'шт',
    allowedUnits: ['шт'],
    characteristics: [{ key: 'material' }, { key: 'size' }],
  },
  {
    subtypeKey: 'HALF_RING',
    defaultInputType: 'QTY_PER_ITEM',
    label: 'Полукольцо',
    groupRoleKey: 'PACKAGING',
    defaultUnit: 'шт',
    allowedUnits: ['шт'],
    characteristics: [{ key: 'material' }, { key: 'size' }],
  },
  {
    subtypeKey: 'CORD_END',
    defaultInputType: 'QTY_PER_ITEM',
    label: 'Концевик',
    groupRoleKey: 'PACKAGING',
    defaultUnit: 'шт',
    allowedUnits: ['шт'],
    characteristics: [{ key: 'material' }, { key: 'size' }],
  },
  {
    subtypeKey: 'WEBBING',
    defaultInputType: 'QTY_PER_ITEM',
    label: 'Стропа',
    groupRoleKey: 'PACKAGING',
    defaultUnit: 'м',
    allowedUnits: ['м'],
    characteristics: [{ key: 'width' }],
  },
  {
    subtypeKey: 'TAPE',
    defaultInputType: 'QTY_PER_ITEM',
    label: 'Лента',
    groupRoleKey: 'PACKAGING',
    defaultUnit: 'м',
    allowedUnits: ['м'],
    characteristics: [{ key: 'material' }, { key: 'width' }],
  },
  {
    subtypeKey: 'PIPING',
    defaultInputType: 'QTY_PER_ITEM',
    label: 'Кант',
    groupRoleKey: 'PACKAGING',
    defaultUnit: 'м',
    allowedUnits: ['м'],
    characteristics: [{ key: 'material' }, { key: 'width' }],
  },
  {
    subtypeKey: 'ELASTIC',
    defaultInputType: 'QTY_PER_ITEM',
    label: 'Резинка',
    groupRoleKey: 'PACKAGING',
    defaultUnit: 'м',
    allowedUnits: ['м'],
    characteristics: [{ key: 'type' }, { key: 'width' }],
  },
  {
    subtypeKey: 'HAT_ELASTIC',
    defaultInputType: 'QTY_PER_ITEM',
    label: 'Шляпная резинка',
    groupRoleKey: 'PACKAGING',
    defaultUnit: 'м',
    allowedUnits: ['м'],
    characteristics: [{ key: 'thickness' }],
  },
  {
    subtypeKey: 'CORD',
    defaultInputType: 'QTY_PER_ITEM',
    label: 'Шнур',
    groupRoleKey: 'PACKAGING',
    defaultUnit: 'м',
    allowedUnits: ['м', 'м/шт', 'шт'],
    characteristics: [{ key: 'thickness' }],
  },
  {
    subtypeKey: 'KNIT_CUFF',
    defaultInputType: 'QTY_PER_ITEM',
    label: 'Подвяз',
    groupRoleKey: 'PACKAGING',
    defaultUnit: 'шт',
    allowedUnits: ['шт', 'м/шт', 'м'],
    characteristics: [{ key: 'material' }],
  },
  {
    subtypeKey: 'KNIT_COLLAR',
    defaultInputType: 'QTY_PER_ITEM',
    label: 'Вязаный воротник',
    groupRoleKey: 'PACKAGING',
    // Ввод — в штуках; потребность считают и в штуках, и в метрах
    // (решение пользователя 16.06.2026).
    defaultUnit: 'шт',
    allowedUnits: ['шт', 'м/шт'],
    characteristics: [{ key: 'material' }],
  },
  {
    subtypeKey: 'BUTTON',
    defaultInputType: 'QTY_PER_ITEM',
    label: 'Пуговица',
    groupRoleKey: 'PACKAGING',
    defaultUnit: 'шт',
    allowedUnits: ['шт'],
    characteristics: [
      { key: 'type' },
      { key: 'material' },
      { key: 'size' },
      { key: 'holesCount' },
    ],
  },
] as const;

const SUBTYPE_BY_KEY = new Map<string, MaterialSubtypeConfig>(
  MATERIAL_SUBTYPES.map((s) => [s.subtypeKey, s] as const),
);

export function getMaterialSubtype(
  subtypeKey: string,
): MaterialSubtypeConfig | null {
  return SUBTYPE_BY_KEY.get(subtypeKey) ?? null;
}

export function isKnownMaterialSubtype(subtypeKey: string): boolean {
  return SUBTYPE_BY_KEY.has(subtypeKey);
}

/** Подтипы, относящиеся к группе (`roleKey`), в порядке объявления. */
export function getMaterialSubtypesByGroup(
  groupRoleKey: string,
): MaterialSubtypeConfig[] {
  return MATERIAL_SUBTYPES.filter((s) => s.groupRoleKey === groupRoleKey);
}

/**
 * Ключи характеристик, обязательных для подтипа при данной единице.
 * Учитывает правило «ЕСЛИ КГ» (`requiredIfUnitKg` срабатывает при
 * `unit === 'кг'`). Незнакомый подтип → пустой список.
 */
export function resolveRequiredCharacteristicKeys(
  subtypeKey: string,
  unit: string,
): string[] {
  const subtype = getMaterialSubtype(subtypeKey);
  if (!subtype) return [];
  return subtype.characteristics
    .filter((c) => c.required || (c.requiredIfUnitKg && unit === 'кг'))
    .map((c) => c.key);
}

// ---------------------------------------------------------------------------
// Zod
// ---------------------------------------------------------------------------

export const MaterialSubtypeKeySchema = z.enum(
  MATERIAL_SUBTYPES.map((s) => s.subtypeKey) as [string, ...string[]],
);
export type MaterialSubtypeKey = z.infer<typeof MaterialSubtypeKeySchema>;

/**
 * Обобщённая схема значений характеристик (для хранения/передачи).
 * Ключ — `MATERIAL_CHARACTERISTICS[].key`, значение — строка либо
 * число (number-характеристики могут приходить строкой из формы и
 * нормализуются на сервисном слое в Фазе 1). Строгая валидация
 * «обязательности по подтипу» — отдельным хелпером в Фазе 2.
 */
export const MaterialCharacteristicsSchema = z.record(
  z.string(),
  z.union([z.string(), z.number()]),
);
export type MaterialCharacteristics = z.infer<
  typeof MaterialCharacteristicsSchema
>;

// ---------------------------------------------------------------------------
// Пер­еходные хелперы (Фаза 1): legacy-колонки ↔ characteristics, описание
// ---------------------------------------------------------------------------

/** Подмножество строки материала с legacy-колонками (для бэкфилла). */
export interface MaterialLineLegacyColumns {
  densityGsm?: number | null;
  plannedWidthCm?: number | null;
  hardwareSizeText?: string | null;
  hardwareMaterialText?: string | null;
}

/**
 * Собрать `characteristics` из legacy-колонок (Фаза 1, бэкфилл и
 * зеркалирование). Маппинг — по `legacyColumn` из
 * `MATERIAL_CHARACTERISTICS`. null/empty пропускаются. Цвет не входит
 * (он в `colorRule`).
 */
export function legacyColumnsToCharacteristics(
  line: MaterialLineLegacyColumns,
): MaterialCharacteristics {
  const out: MaterialCharacteristics = {};
  for (const def of MATERIAL_CHARACTERISTICS) {
    if (!def.legacyColumn) continue;
    const raw = line[def.legacyColumn];
    if (raw === null || raw === undefined) continue;
    if (typeof raw === 'string' && raw.trim() === '') continue;
    out[def.key] = raw;
  }
  return out;
}

/**
 * Человекочитаемое описание материала из подтипа + характеристик
 * (+ цвет, который приходит отдельно из `colorRule`-механизма).
 * Пример: «Молния, чёрный, тип: спираль, металл, размер 5, длина 60 см».
 * Незнакомый подтип → собираем из переданных характеристик как есть.
 */
export function buildMaterialDescription(
  subtypeKey: string | null | undefined,
  characteristics: MaterialCharacteristics | null | undefined,
  opts?: { color?: string | null; fallbackName?: string | null },
): string {
  const subtype = subtypeKey ? getMaterialSubtype(subtypeKey) : null;
  const parts: string[] = [];

  const head = subtype?.label ?? opts?.fallbackName ?? '';
  if (head) parts.push(head);

  const color = opts?.color?.trim();
  if (color) parts.push(color);

  const values = characteristics ?? {};
  // Порядок — как у подтипа (если известен), иначе по каталогу.
  const orderedKeys = subtype
    ? subtype.characteristics.map((c) => c.key)
    : MATERIAL_CHARACTERISTICS.map((c) => c.key);

  for (const key of orderedKeys) {
    const raw = values[key];
    if (raw === null || raw === undefined || raw === '') continue;
    const def = getMaterialCharacteristic(key);
    const unit = def?.unit ? ` ${def.unit}` : '';
    // «Тип» выводим с лейблом для однозначности; остальные — значением.
    if (key === 'type') parts.push(`тип: ${raw}`);
    else if (key === 'size') parts.push(`размер ${raw}${unit}`);
    else if (key === 'length') parts.push(`длина ${raw}${unit}`);
    else if (key === 'holesCount') parts.push(`${raw} прокол(ов)`);
    else parts.push(`${raw}${unit}`);
  }

  return parts.join(', ');
}
