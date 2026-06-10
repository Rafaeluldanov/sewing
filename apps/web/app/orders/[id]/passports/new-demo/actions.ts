'use server';

import { revalidatePath } from 'next/cache';
import { CreatePassportSchema } from '@sewing/shared/passports';
import { ApiRequestError, errorText } from '@/lib/api';
import { createPassport } from '@/lib/passports-api';
import { createPrintJob } from '@/lib/printers-api';

export interface PassportDemoFormState {
  error?: string;
  success?: {
    created: number;
    failed: number;
    /** Сколько паспортов успешно отправлено в печать. */
    printed: number;
    /** Сколько паспортов создано, но печать не ушла (нет смены/принтера/etc). */
    printFailed: number;
    /** Первое сообщение об ошибке создания (для частичного успеха). */
    firstError?: string;
    /** Первое сообщение об ошибке печати — отдельно, оно не критичное. */
    firstPrintError?: string;
  };
}

function explainApiError(e: unknown): string {
  if (e instanceof ApiRequestError) {
    return errorText(e);
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

  let created = 0;
  let failed = 0;
  let printed = 0;
  let printFailed = 0;
  let firstError: string | undefined;
  let firstPrintError: string | undefined;

  for (let i = 0; i < quantities.length; i++) {
    const qty = Math.floor(quantities[i] ?? 0);
    if (!Number.isFinite(qty) || qty <= 0) continue;

    const body = {
      orderId,
      sizeId,
      cutDate,
      qtyCut: qty,
      // По требованию — печатаем простой порядковый номер рулона: «1»,
      // «2», … (рулон 1 → rollNumber = "1"). Уникальности по rollNumber
      // схема и БД не требуют, поэтому пересечения между сабмитами не
      // ломают создание.
      rollNumber: String(i + 1),
      ...(cutterIdRaw ? { cutterId: cutterIdRaw } : {}),
    };
    const parsed = CreatePassportSchema.safeParse(body);
    if (!parsed.success) {
      failed++;
      if (!firstError) firstError = parsed.error.issues[0]?.message;
      continue;
    }

    let createdPassport;
    try {
      createdPassport = await createPassport(parsed.data);
      created++;
    } catch (e) {
      failed++;
      if (!firstError) firstError = explainApiError(e);
      continue;
    }

    // Автопечать: тот же `POST /api/print-jobs`, что использует общий
    // `<PrintButton>` после обычного выпуска. Принтер резолвится по
    // equipmentId активной смены помощника раскройщика
    // (см. `print-jobs.service.ts::resolvePrinter`). Если печать
    // не ушла (нет принтера / нет агента), паспорт всё равно создан —
    // считаем только в `printFailed`, а не в `failed`.
    try {
      await createPrintJob({
        sourceType: 'PASSPORT_PRINT',
        sourceId: createdPassport.id,
      });
      printed++;
    } catch (e) {
      printFailed++;
      if (!firstPrintError) firstPrintError = explainApiError(e);
    }
  }

  revalidatePath(`/orders/${orderId}`);
  revalidatePath('/orders');

  if (created === 0) {
    return { error: firstError ?? 'Не удалось создать ни одного паспорта' };
  }
  return {
    success: {
      created,
      failed,
      printed,
      printFailed,
      firstError,
      firstPrintError,
    },
  };
}
