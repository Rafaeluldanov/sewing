/**
 * Справочник ЗНАЧЕНИЙ поля «Характеристика» строки материала техкарты.
 *
 * Контекст (решение пользователя 29.07.2026, макет
 * `docs/mockups/tech-card-characteristic-combobox-mockup.html`): поле
 * «Подтип» в форме техкарты убрано. Все его значения (Молния, Кнопка,
 * Кашкорсе, Дублерин, ...) переехали в список поля «Характеристика»,
 * которое стало комбобоксом: можно выбрать из списка, можно набрать
 * своё, а набранное пополняет список для всех следующих техкарт.
 *
 * Отсюда два источника значений:
 *
 *   1. ВСТРОЕННЫЕ (`builtin`) — лейблы подтипов из `MATERIAL_SUBTYPES`
 *      (см. `./material-characteristics`). Живут в коде, не хранятся в
 *      БД, не удаляются из UI. Именно они сохраняют скрытую связь
 *      «значение → подтип»: выбрали «Молния» → строка получает
 *      `subtypeKey = 'ZIPPER'` и вместе с ним набор доп. полей
 *      (Тип/Длина) и правила обязательности (ЕСЛИ КГ → плотность и
 *      ширина рулона). Набрали своё — `subtypeKey` пуст, доп. полей нет.
 *
 *   2. ПОЛЬЗОВАТЕЛЬСКИЕ (`custom`) — строки таблицы
 *      `MaterialCharacteristicOption` (роль + значение). Добавляются из
 *      комбобокса кнопкой «+ Добавить», удаляются оттуда же.
 *
 * Список всегда привязан к РОЛИ материала (`roleKey`, тот же справочник
 * ролей, что у `TechCardMaterialLine.materialRole`): у «Фурнитуры» свой
 * набор, у «Основного полотна» — свой. Раньше эту привязку давал
 * `MaterialSubtypeConfig.groupRoleKey`, теперь она же переносится на
 * пользовательские значения.
 *
 * Само ЗНАЧЕНИЕ характеристики хранится в существующей колонке
 * `fabricType` строки материала — новых колонок для него не заводим
 * (поле «Характеристика полотна» просто переименовано в
 * «Характеристику» и расширено на все роли).
 */

import { z } from 'zod';

import {
  MATERIAL_SUBTYPES,
  getMaterialSubtypesByGroup,
} from './material-characteristics';

/** Максимальная длина значения — как у `TechCardMaterialLine.fabricType`. */
export const MATERIAL_CHARACTERISTIC_OPTION_MAX_LENGTH = 120;

/**
 * Каноничный ключ значения для сравнения и защиты от дублей:
 * trim + схлопывание пробелов + нижний регистр + «ё» → «е».
 *
 * «Молния», «молния » и «МОЛНИЯ» — одно и то же значение: второй раз в
 * список не попадёт и не создаст дубль в БД (`@@unique([roleKey,
 * valueNorm])`). «ё» нормализуем сознательно: «шляпная резинка» люди
 * пишут и через «е», и через «ё», а два соседних пункта в выпадающем
 * списке — это шум.
 */
export function normalizeMaterialCharacteristicOptionValue(
  value: string,
): string {
  return value
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/ё/g, 'е');
}

/**
 * Встроенные значения роли — лейблы подтипов её группы, в порядке
 * объявления в `MATERIAL_SUBTYPES`. Пустая роль → пустой список
 * (комбобокс покажет только пользовательские значения).
 */
export function getBuiltinCharacteristicOptions(roleKey: string): string[] {
  if (!roleKey) return [];
  return getMaterialSubtypesByGroup(roleKey).map((s) => s.label);
}

/**
 * Обратный резолвер «значение характеристики → `subtypeKey`» — то самое
 * скрытое связывание, ради которого встроенные значения остаются
 * лейблами подтипов.
 *
 * Ищем ТОЛЬКО внутри роли: лейбл «Кашкорсе» принадлежит группе `RIB`, и
 * подставлять его подтип строке с ролью `PACKAGING` было бы враньём.
 * Сравнение — по нормализованному значению, поэтому «молния» с
 * маленькой буквы тоже находит подтип `ZIPPER`.
 *
 * Ничего не нашли (пользовательское значение, пустая строка) → `null`:
 * строка живёт без подтипа, доп. поля подтипа не показываются.
 */
export function resolveSubtypeKeyByCharacteristic(
  roleKey: string,
  value: string | null | undefined,
): string | null {
  const norm = normalizeMaterialCharacteristicOptionValue(value ?? '');
  if (norm === '') return null;
  const match = getMaterialSubtypesByGroup(roleKey).find(
    (s) => normalizeMaterialCharacteristicOptionValue(s.label) === norm,
  );
  return match ? match.subtypeKey : null;
}

/**
 * Прямой резолвер «`subtypeKey` → значение характеристики» для показа
 * СТАРЫХ строк: у техкарт, заполненных до этой правки, значение лежит в
 * `subtypeKey`, а `fabricType` может быть пуст. При открытии формы такая
 * строка показывает лейбл подтипа в поле «Характеристика» — менеджеру
 * ничего не нужно перезаполнять руками.
 *
 * Незнакомый (legacy) `subtypeKey` возвращаем как есть — пусть лучше в
 * поле будет технический ключ, чем пустота на месте заполненных данных.
 */
export function characteristicValueFromSubtypeKey(
  subtypeKey: string | null | undefined,
): string {
  if (!subtypeKey) return '';
  const match = MATERIAL_SUBTYPES.find((s) => s.subtypeKey === subtypeKey);
  return match ? match.label : subtypeKey;
}

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

/**
 * Значение списка «Характеристика» в том виде, в каком его отдаёт API и
 * показывает комбобокс.
 *
 * `id` есть только у пользовательских значений — по нему идёт удаление.
 * У встроенных `id = null` и `isBuiltin = true`: их нельзя удалить, и
 * именно они несут `subtypeKey`.
 */
export interface MaterialCharacteristicOptionDto {
  id: string | null;
  roleKey: string;
  value: string;
  isBuiltin: boolean;
  /** Подтип, который подставится строке при выборе (только у builtin). */
  subtypeKey: string | null;
}

export const CreateMaterialCharacteristicOptionSchema = z.object({
  roleKey: z
    .string()
    .trim()
    .min(1, 'Роль материала обязательна')
    .max(64, 'Роль материала не длиннее 64 символов'),
  value: z
    .string()
    .trim()
    .min(1, 'Значение обязательно')
    .max(
      MATERIAL_CHARACTERISTIC_OPTION_MAX_LENGTH,
      `Значение не длиннее ${MATERIAL_CHARACTERISTIC_OPTION_MAX_LENGTH} символов`,
    ),
});
export type CreateMaterialCharacteristicOptionDto = z.infer<
  typeof CreateMaterialCharacteristicOptionSchema
>;

export const ListMaterialCharacteristicOptionsQuerySchema = z.object({
  /** Фильтр по роли. Без него отдаём весь справочник (все роли). */
  roleKey: z.string().trim().min(1).max(64).optional(),
});
export type ListMaterialCharacteristicOptionsQuery = z.infer<
  typeof ListMaterialCharacteristicOptionsQuerySchema
>;

/**
 * Слить встроенные и пользовательские значения роли в один список для
 * комбобокса: сначала встроенные (в порядке `MATERIAL_SUBTYPES`), затем
 * пользовательские по алфавиту. Пользовательское значение, совпавшее со
 * встроенным после нормализации, отбрасывается — в списке не должно
 * быть двух «Молний».
 */
export function mergeCharacteristicOptions(
  roleKey: string,
  customValues: Array<{ id: string; value: string }>,
): MaterialCharacteristicOptionDto[] {
  const builtin = getMaterialSubtypesByGroup(roleKey).map(
    (s): MaterialCharacteristicOptionDto => ({
      id: null,
      roleKey,
      value: s.label,
      isBuiltin: true,
      subtypeKey: s.subtypeKey,
    }),
  );
  const taken = new Set(
    builtin.map((o) => normalizeMaterialCharacteristicOptionValue(o.value)),
  );
  const custom: MaterialCharacteristicOptionDto[] = [];
  for (const row of customValues) {
    const norm = normalizeMaterialCharacteristicOptionValue(row.value);
    if (taken.has(norm)) continue;
    taken.add(norm);
    custom.push({
      id: row.id,
      roleKey,
      value: row.value,
      isBuiltin: false,
      subtypeKey: null,
    });
  }
  custom.sort((a, b) => a.value.localeCompare(b.value, 'ru'));
  return [...builtin, ...custom];
}
