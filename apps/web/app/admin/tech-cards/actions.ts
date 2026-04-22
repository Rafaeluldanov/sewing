'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  CreateTechCardSchema,
  TECH_CARD_CODE_PATTERN,
  UpdateTechCardSchema,
  type TechCardMaterialLineInputDto,
  type TechCardOutsourceLineInputDto,
} from '@sewing/shared/tech-cards';
import { ApiRequestError } from '@/lib/api';
import { createTechCard, updateTechCard } from '@/lib/tech-cards-api';
import type { TechCardFormState } from './form-state';

/**
 * Парсит строки техкарты из FormData.
 *
 * UI рендерит динамический список строк с уникальными ключами вида
 * `material[<key>][name]`, `material[<key>][unit]` и т.д. (где `<key>`
 * — стабильный id строки в форме, а не sortOrder). Здесь мы собираем
 * пары по `<key>`, отсеиваем пустые «черновые» строки и сохраняем
 * порядок появления ключей в форме — backend нормализует `sortOrder`
 * как `(i + 1) * 10`. См. `TechCardsService.create/update`.
 */
function parseLines<T extends 'material' | 'outsource'>(
  form: FormData,
  prefix: T,
): T extends 'material'
  ? Array<Record<string, string>>
  : Array<Record<string, string>> {
  const re = new RegExp(`^${prefix}\\[([^\\]]+)\\]\\[([^\\]]+)\\]$`);
  const orderKeys: string[] = [];
  const seen = new Set<string>();
  const map = new Map<string, Record<string, string>>();
  for (const [key, rawVal] of form.entries()) {
    const m = re.exec(key);
    if (!m) continue;
    const [, lineKey, fieldName] = m;
    const value = String(rawVal ?? '').trim();
    if (!seen.has(lineKey)) {
      seen.add(lineKey);
      orderKeys.push(lineKey);
      map.set(lineKey, {});
    }
    const obj = map.get(lineKey);
    if (obj) obj[fieldName] = value;
  }
  return orderKeys
    .map((k) => map.get(k) as Record<string, string>)
    .filter((row) => Boolean(row));
}

function buildMaterialLines(
  form: FormData,
): Array<Partial<TechCardMaterialLineInputDto> & { name?: string }> {
  return parseLines(form, 'material')
    .map((r) => ({
      name: r.name ?? '',
      unit: r.unit ?? '',
      qtyPerUnit: r.qtyPerUnit ?? '',
      note: r.note ?? '',
    }))
    .filter(
      (r) =>
        r.name.length > 0 ||
        r.unit.length > 0 ||
        r.qtyPerUnit.length > 0 ||
        r.note.length > 0,
    );
}

function buildOutsourceLines(
  form: FormData,
): Array<Partial<TechCardOutsourceLineInputDto> & { name?: string }> {
  return parseLines(form, 'outsource')
    .map((r) => ({
      name: r.name ?? '',
      unit: r.unit ?? '',
      qtyPerUnit: r.qtyPerUnit ?? '',
      vendorName: r.vendorName ?? '',
      note: r.note ?? '',
    }))
    .filter(
      (r) =>
        r.name.length > 0 ||
        r.unit.length > 0 ||
        r.qtyPerUnit.length > 0 ||
        r.vendorName.length > 0 ||
        r.note.length > 0,
    );
}

function explainApiError(e: unknown, fallback: string): TechCardFormState {
  if (e instanceof ApiRequestError) {
    return {
      error: `${e.message}${e.code ? ` (${e.code})` : ''}`,
      errorRequestId: e.requestId,
    };
  }
  return { error: fallback };
}

export async function createTechCardAction(
  _prev: TechCardFormState,
  form: FormData,
): Promise<TechCardFormState> {
  const code = String(form.get('code') ?? '').trim();
  const name = String(form.get('name') ?? '').trim();
  const isActive = form.get('isActive') !== 'off';

  if (code.length === 0) return { error: 'Код техкарты обязателен' };
  if (!TECH_CARD_CODE_PATTERN.test(code)) {
    return {
      error:
        'Код техкарты: латинские заглавные буквы, цифры, "-" и "_" (начинается с буквы или цифры)',
    };
  }
  if (name.length === 0) return { error: 'Название техкарты обязательно' };

  const parsed = CreateTechCardSchema.safeParse({
    code,
    name,
    isActive,
    materialLines: buildMaterialLines(form),
    outsourceLines: buildOutsourceLines(form),
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные техкарты',
    };
  }

  let createdId: string | null = null;
  try {
    const created = await createTechCard(parsed.data);
    createdId = created.id;
    revalidatePath('/admin/tech-cards');
    revalidatePath('/orders/new');
  } catch (e) {
    return explainApiError(e, 'Не удалось создать техкарту');
  }
  if (createdId) {
    redirect(`/admin/tech-cards/${createdId}`);
  }
  return { ok: true, successMessage: 'Техкарта создана' };
}

export async function updateTechCardAction(
  _prev: TechCardFormState,
  form: FormData,
): Promise<TechCardFormState> {
  const id = String(form.get('id') ?? '').trim();
  if (id.length === 0) return { error: 'Не указан id техкарты' };

  const code = String(form.get('code') ?? '').trim();
  const name = String(form.get('name') ?? '').trim();
  const isActive = form.get('isActive') !== 'off';

  if (code.length === 0) return { error: 'Код техкарты обязателен' };
  if (!TECH_CARD_CODE_PATTERN.test(code)) {
    return {
      error:
        'Код техкарты: латинские заглавные буквы, цифры, "-" и "_" (начинается с буквы или цифры)',
    };
  }
  if (name.length === 0) return { error: 'Название техкарты обязательно' };

  const parsed = UpdateTechCardSchema.safeParse({
    code,
    name,
    isActive,
    materialLines: buildMaterialLines(form),
    outsourceLines: buildOutsourceLines(form),
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные техкарты',
    };
  }

  try {
    await updateTechCard(id, parsed.data);
    revalidatePath('/admin/tech-cards');
    revalidatePath(`/admin/tech-cards/${id}`);
    revalidatePath('/orders/new');
  } catch (e) {
    return explainApiError(e, 'Не удалось обновить техкарту');
  }
  return { ok: true, successMessage: 'Техкарта обновлена' };
}
