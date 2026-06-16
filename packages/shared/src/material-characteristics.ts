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
    label: 'Основное полотно',
    groupRoleKey: 'MAIN_FABRIC',
    defaultUnit: 'м пог.',
    allowedUnits: ['м пог.', 'кг', 'м²'],
    characteristics: fabricChars,
  },
  {
    subtypeKey: 'ADDITIONAL_FABRIC',
    label: 'Дополнительное полотно',
    groupRoleKey: 'ADDITIONAL_FABRIC',
    defaultUnit: 'м пог.',
    allowedUnits: ['м пог.', 'кг', 'м²'],
    characteristics: fabricChars,
  },
  {
    subtypeKey: 'LINING',
    label: 'Подкладка',
    groupRoleKey: 'LINING',
    defaultUnit: 'м пог.',
    allowedUnits: ['м пог.', 'кг', 'м²'],
    characteristics: fabricChars,
  },
  // --- Рибана / кашкорсе (Цвет) -----------------------------------------
  {
    subtypeKey: 'RIB',
    label: 'Рибана',
    groupRoleKey: 'RIB',
    defaultUnit: 'м пог.',
    allowedUnits: ['м пог.', 'кг', 'м²'],
    characteristics: [],
  },
  {
    subtypeKey: 'KASHKORSE',
    label: 'Кашкорсе',
    groupRoleKey: 'RIB',
    defaultUnit: 'м пог.',
    allowedUnits: ['м пог.', 'кг', 'м²'],
    characteristics: [],
  },
  // --- Клеевые материалы -------------------------------------------------
  {
    subtypeKey: 'DUBLERIN',
    label: 'Дублерин',
    groupRoleKey: 'INTERLINING',
    defaultUnit: 'м пог.',
    allowedUnits: ['м пог.', 'м²', 'кг'],
    characteristics: [{ key: 'density', required: true }],
  },
  {
    subtypeKey: 'FLIZELIN',
    label: 'Флизелин',
    groupRoleKey: 'INTERLINING',
    defaultUnit: 'м пог.',
    allowedUnits: ['м пог.', 'м²', 'кг'],
    characteristics: [{ key: 'density', required: true }],
  },
  {
    subtypeKey: 'PAUTINKA',
    label: 'Паутинка',
    groupRoleKey: 'INTERLINING',
    defaultUnit: 'м',
    allowedUnits: ['м'],
    characteristics: [{ key: 'width', required: true }],
  },
  {
    subtypeKey: 'GLUE_EDGE',
    label: 'Клеевая кромка',
    groupRoleKey: 'INTERLINING',
    defaultUnit: 'м',
    allowedUnits: ['м'],
    characteristics: [{ key: 'width', required: true }],
  },
  {
    subtypeKey: 'BORTOVKA',
    label: 'Бортовка',
    groupRoleKey: 'INTERLINING',
    defaultUnit: 'м пог.',
    allowedUnits: ['м пог.', 'м²', 'кг'],
    characteristics: [{ key: 'density', required: true }],
  },
  // --- Наполнитель -------------------------------------------------------
  {
    subtypeKey: 'SINTEPON',
    label: 'Синтепон',
    groupRoleKey: 'FILLER',
    defaultUnit: 'м пог.',
    allowedUnits: ['м пог.', 'кг'],
    characteristics: [{ key: 'density', required: true }],
  },
  {
    subtypeKey: 'ARTIFICIAL_DOWN',
    label: 'Искусственный пух',
    groupRoleKey: 'FILLER',
    defaultUnit: 'кг',
    allowedUnits: ['кг'],
    characteristics: [],
  },
  // --- Нитки -------------------------------------------------------------
  {
    subtypeKey: 'THREAD',
    label: 'Нитки',
    groupRoleKey: 'THREAD',
    defaultUnit: 'м',
    allowedUnits: ['м'],
    characteristics: [{ key: 'thickness', required: true }],
  },
  // --- Фурнитура ---------------------------------------------------------
  {
    subtypeKey: 'ZIPPER',
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
    label: 'Кнопка',
    groupRoleKey: 'PACKAGING',
    defaultUnit: 'шт',
    allowedUnits: ['шт'],
    characteristics: [{ key: 'type' }, { key: 'material' }, { key: 'size' }],
  },
  {
    subtypeKey: 'EYELET',
    label: 'Люверс',
    groupRoleKey: 'PACKAGING',
    defaultUnit: 'шт',
    allowedUnits: ['шт'],
    characteristics: [{ key: 'material' }, { key: 'size' }],
  },
  {
    subtypeKey: 'FASTEX',
    label: 'Фастекс',
    groupRoleKey: 'PACKAGING',
    defaultUnit: 'шт',
    allowedUnits: ['шт'],
    characteristics: [{ key: 'material' }, { key: 'size' }],
  },
  {
    subtypeKey: 'CORD_LOCK',
    label: 'Фиксатор',
    groupRoleKey: 'PACKAGING',
    defaultUnit: 'шт',
    allowedUnits: ['шт'],
    characteristics: [{ key: 'material' }, { key: 'size' }],
  },
  {
    subtypeKey: 'RING',
    label: 'Кольцо',
    groupRoleKey: 'PACKAGING',
    defaultUnit: 'шт',
    allowedUnits: ['шт'],
    characteristics: [{ key: 'material' }, { key: 'size' }],
  },
  {
    subtypeKey: 'HALF_RING',
    label: 'Полукольцо',
    groupRoleKey: 'PACKAGING',
    defaultUnit: 'шт',
    allowedUnits: ['шт'],
    characteristics: [{ key: 'material' }, { key: 'size' }],
  },
  {
    subtypeKey: 'CORD_END',
    label: 'Концевик',
    groupRoleKey: 'PACKAGING',
    defaultUnit: 'шт',
    allowedUnits: ['шт'],
    characteristics: [{ key: 'material' }, { key: 'size' }],
  },
  {
    subtypeKey: 'WEBBING',
    label: 'Стропа',
    groupRoleKey: 'PACKAGING',
    defaultUnit: 'м',
    allowedUnits: ['м'],
    characteristics: [{ key: 'width' }],
  },
  {
    subtypeKey: 'TAPE',
    label: 'Лента',
    groupRoleKey: 'PACKAGING',
    defaultUnit: 'м',
    allowedUnits: ['м'],
    characteristics: [{ key: 'material' }, { key: 'width' }],
  },
  {
    subtypeKey: 'PIPING',
    label: 'Кант',
    groupRoleKey: 'PACKAGING',
    defaultUnit: 'м',
    allowedUnits: ['м'],
    characteristics: [{ key: 'material' }, { key: 'width' }],
  },
  {
    subtypeKey: 'ELASTIC',
    label: 'Резинка',
    groupRoleKey: 'PACKAGING',
    defaultUnit: 'м',
    allowedUnits: ['м'],
    characteristics: [{ key: 'type' }, { key: 'width' }],
  },
  {
    subtypeKey: 'HAT_ELASTIC',
    label: 'Шляпная резинка',
    groupRoleKey: 'PACKAGING',
    defaultUnit: 'м',
    allowedUnits: ['м'],
    characteristics: [{ key: 'thickness' }],
  },
  {
    subtypeKey: 'CORD',
    label: 'Шнур',
    groupRoleKey: 'PACKAGING',
    defaultUnit: 'м',
    allowedUnits: ['м', 'м/шт', 'шт'],
    characteristics: [{ key: 'thickness' }],
  },
  {
    subtypeKey: 'KNIT_CUFF',
    label: 'Подвяз',
    groupRoleKey: 'PACKAGING',
    defaultUnit: 'шт',
    allowedUnits: ['шт', 'м/шт', 'м'],
    characteristics: [{ key: 'material' }],
  },
  {
    subtypeKey: 'KNIT_COLLAR',
    label: 'Вязаный воротник',
    groupRoleKey: 'PACKAGING',
    defaultUnit: 'шт',
    allowedUnits: ['шт'],
    characteristics: [{ key: 'material' }],
  },
  {
    subtypeKey: 'BUTTON',
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
