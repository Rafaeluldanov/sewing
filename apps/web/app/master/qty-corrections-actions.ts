'use server';

import { revalidatePath } from 'next/cache';
import type {
  ApprovePassportQtyCorrectionResultDto,
  PassportQtyCorrectionDto,
} from '@sewing/shared/passport-qty-corrections';
import { ApiRequestError, errorText } from '@/lib/api';
import {
  approveQtyCorrection,
  listPendingQtyCorrections,
  rejectQtyCorrection,
} from '@/lib/master-qty-corrections-api';

function explainApiError(e: unknown): string {
  if (e instanceof ApiRequestError) return errorText(e);
  return 'Не удалось выполнить запрос';
}

export type QtyCorrectionsListResult =
  | { ok: true; items: PassportQtyCorrectionDto[] }
  | { ok: false; error: string };

/** Перечитать очередь открытых корректировок (polling мастера). */
export async function refreshPendingQtyCorrectionsAction(): Promise<QtyCorrectionsListResult> {
  try {
    const items = await listPendingQtyCorrections();
    return { ok: true, items };
  } catch (e) {
    return { ok: false, error: explainApiError(e) };
  }
}

export type ApproveQtyCorrectionResult =
  | { ok: true; result: ApprovePassportQtyCorrectionResultDto }
  | { ok: false; error: string };

/** Мастер подтверждает корректировку. */
export async function approveQtyCorrectionAction(
  id: string,
  note?: string,
): Promise<ApproveQtyCorrectionResult> {
  try {
    const result = await approveQtyCorrection(id, {
      note: note && note.trim() ? note.trim() : undefined,
    });
    revalidatePath('/master');
    revalidatePath(`/orders/${result.correction.orderId}`);
    revalidatePath(`/admin/orders/${result.correction.orderId}`);
    revalidatePath(`/admin/passports/${result.correction.passportId}`);
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: explainApiError(e) };
  }
}

export type RejectQtyCorrectionResult =
  | { ok: true; correction: PassportQtyCorrectionDto }
  | { ok: false; error: string };

/** Мастер отклоняет корректировку. */
export async function rejectQtyCorrectionAction(
  id: string,
  note?: string,
): Promise<RejectQtyCorrectionResult> {
  try {
    const correction = await rejectQtyCorrection(id, {
      note: note && note.trim() ? note.trim() : undefined,
    });
    revalidatePath('/master');
    return { ok: true, correction };
  } catch (e) {
    return { ok: false, error: explainApiError(e) };
  }
}
