'use server';

import type { MaterialCharacteristicOptionDto } from '@sewing/shared/material-characteristic-options';
import { errorText } from '@/lib/api';
import {
  createMaterialCharacteristicOption,
  deleteMaterialCharacteristicOption,
  listMaterialCharacteristicOptions,
} from '@/lib/material-characteristic-options-api';

/**
 * Server actions справочника «Характеристика» для клиентского комбобокса
 * (`characteristic-combobox.tsx`).
 *
 * Живут рядом с компонентом, а не в `app/.../actions.ts`, потому что
 * комбобокс работает на ДВУХ экранах: форма шаблона техкарты
 * (`/admin/tech-cards/*`) и спецификация заказа (`ColorwaySpec`). Держать
 * одну копию действий рядом с общим компонентом честнее, чем дублировать
 * их в двух `actions.ts`.
 *
 * Все три возвращают результат-объект, а не бросают: комбобокс — часть
 * большой формы, и падать целиком из-за недоступного справочника он не
 * должен. Не смог загрузить список — покажет ввод без подсказок.
 *
 * ВАЖНО (см. память проекта про `'use server'`): в файле могут жить
 * ТОЛЬКО async-функции. Любой не-async export здесь роняет страницу
 * в рантайме, и ни tsc, ни lint этого не поймают.
 */

export interface CharacteristicOptionsResult {
  ok: boolean;
  options?: MaterialCharacteristicOptionDto[];
  error?: string;
}

export interface CharacteristicOptionResult {
  ok: boolean;
  option?: MaterialCharacteristicOptionDto;
  error?: string;
}

/** Весь справочник (встроенные + пользовательские) по всем ролям. */
export async function loadCharacteristicOptionsAction(): Promise<CharacteristicOptionsResult> {
  try {
    const options = await listMaterialCharacteristicOptions();
    return { ok: true, options };
  } catch (e) {
    return {
      ok: false,
      error: errorText(e, 'Не удалось загрузить список характеристик'),
    };
  }
}

/**
 * Пополнить список значением, которое менеджер набрал руками.
 * Идемпотентно на бэкенде: повтор не создаёт дубль и возвращает то же
 * значение (в том числе встроенное, если набрали «молния» с маленькой).
 */
export async function addCharacteristicOptionAction(input: {
  roleKey: string;
  value: string;
}): Promise<CharacteristicOptionResult> {
  try {
    const option = await createMaterialCharacteristicOption({
      roleKey: input.roleKey,
      value: input.value,
    });
    return { ok: true, option };
  } catch (e) {
    return {
      ok: false,
      error: errorText(e, 'Не удалось добавить значение в список'),
    };
  }
}

/**
 * Убрать пользовательское значение из подсказок. Техкарты, где оно уже
 * проставлено, не меняются — значение живёт в строке, а не в справочнике.
 */
export async function removeCharacteristicOptionAction(
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await deleteMaterialCharacteristicOption(id);
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      error: errorText(e, 'Не удалось убрать значение из списка'),
    };
  }
}
