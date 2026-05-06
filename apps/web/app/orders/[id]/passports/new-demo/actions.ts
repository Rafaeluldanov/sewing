'use server';

import { revalidatePath } from 'next/cache';
import { CreatePassportSchema } from '@sewing/shared/passports';
import { ApiRequestError } from '@/lib/api';
import { createPassport } from '@/lib/passports-api';

export interface PassportDemoFormState {
  error?: string;
  success?: {
    created: number;
    failed: number;
    /** Первое сообщение об ошибке для частичного успеха (created > 0). */
    firstError?: string;
  };
}

function explainApiError(e: unknown): string {
  if (e instanceof ApiRequestError) {
    const prefix = e.code ? `[${e.code}] ` : '';
    return `${prefix}${e.message}`;
  }
  return 'Не удалось выполнить запрос';
}

/**
 * Серийный выпуск паспортов в демо-режиме.
 *
 *   - `orderId` пробрасывается через `bind()` со страницы (источник
 *     истины — server, не доверяем hidden-input в клиентской форме);
 *   - `quantities` приходит JSON-массивом из формы; каждый элемент —
 *     количество для одного рулона. Рулоны с qty <= 0 пропускаются;
 *   - на каждый ненулевой рулон вызываем существующий `POST /api/passports`
 *     (новых endpoint-ов не заводим — это специально, чтобы демо-flow
 *     прогонял те же бизнес-проверки, что и обычный выпуск);
 *   - `cutDate` берём из формы (страница подставляет today), `cutterId`
 *     — из select-а или пустой для creator-CUTTER, как в обычной форме.
 *
 * Если хотя бы один паспорт создан — считаем сабмит успехом и возвращаем
 * `success` с разбивкой created/failed. Если все вызовы упали — отдаём
 * единый `error` с первым сообщением.
 */
export async function createPassportDemoBatchAction(
  orderId: string,
  _prev: PassportDemoFormState,
  form: FormData,
): Promise<PassportDemoFormState> {
  const sizeId = String(form.get('sizeId') ?? '').trim();
  const cutDate = String(form.get('cutDate') ?? '').trim();
  const cutterIdRaw = String(form.get('cutterId') ?? '').trim();
  const quantitiesRaw = String(form.get('quantities') ?? '[]');

  if (!sizeId) return { error: 'Выберите размер' };
  if (!cutDate) return { error: 'Не указана дата кроя' };

  let quantities: number[];
  try {
    const parsed: unknown = JSON.parse(quantitiesRaw);
    if (!Array.isArray(parsed)) {
      return { error: 'Невалидная сетка раскроя' };
    }
    quantities = parsed.map((n) => Number(n));
  } catch {
    return { error: 'Невалидная сетка раскроя' };
  }

  if (quantities.length === 0) {
    return { error: 'Создайте сетку раскроя' };
  }
  if (!quantities.some((q) => Number.isFinite(q) && q > 0)) {
    return { error: 'Укажите количество хотя бы для одного рулона' };
  }

  // Маркер серии — чтобы rollNumber-ы оставались различимыми между
  // последовательными демо-сабмитами (схема просто требует 1–64 chars,
  // уникальности нет, но визуально удобнее).
  const ts = Date.now().toString(36).slice(-6);

  let created = 0;
  let failed = 0;
  let firstError: string | undefined;

  for (let i = 0; i < quantities.length; i++) {
    const qty = Math.floor(quantities[i] ?? 0);
    if (!Number.isFinite(qty) || qty <= 0) continue;

    const body = {
      orderId,
      sizeId,
      cutDate,
      qtyCut: qty,
      rollNumber: `Демо-Р${i + 1}-${ts}`,
      ...(cutterIdRaw ? { cutterId: cutterIdRaw } : {}),
    };
    const parsed = CreatePassportSchema.safeParse(body);
    if (!parsed.success) {
      failed++;
      if (!firstError) firstError = parsed.error.issues[0]?.message;
      continue;
    }

    try {
      await createPassport(parsed.data);
      created++;
    } catch (e) {
      failed++;
      if (!firstError) firstError = explainApiError(e);
    }
  }

  revalidatePath(`/orders/${orderId}`);
  revalidatePath('/orders');

  if (created === 0) {
    return { error: firstError ?? 'Не удалось создать ни одного паспорта' };
  }
  return {
    success: { created, failed, firstError },
  };
}
