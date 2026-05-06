'use server';

/**
 * Server actions для блока «Отгрузка готовой продукции» в карточке
 * заказа (`/admin/orders/[id]?tab=production`, компонент
 * `OrderFinishedGoodsShipmentSection`).
 *
 * См. `apps/api/src/modules/finished-goods/finished-goods.service.ts::createShipmentForOrder`,
 * `apps/web/lib/finished-goods-api.ts`,
 * `apps/web/components/orders/finished-goods/*`,
 * `docs/api.md §«Finished goods shipments»`.
 *
 * Контракт сабмита:
 *   - Сабмит идёт через `<form action>` + hidden `payload` с JSON-ом
 *     строк (см. `CreateFinishedGoodsShipmentDialog`).
 *   - `orderId` берётся из bind-аргумента server action — клиент не
 *     может его переопределить.
 *   - После успеха — `revalidatePath('/admin/orders/[id]')`, чтобы RSC
 *     блока перечитал список балансов / shipments. Балансы тоже
 *     обновятся (мы их грузим через `listFinishedGoodsBalances`).
 *
 * Контракт state-объекта совместим с `useFormState`. Совпадает по
 * shape с другими order-actions (`material-issues-actions.ts` и т.п.).
 */

import { revalidatePath } from 'next/cache';
import { ApiRequestError } from '@/lib/api';
import {
  createOrderFinishedGoodsShipment,
  type CreateFinishedGoodsShipmentDto,
} from '@/lib/finished-goods-api';

export interface FinishedGoodsShipmentFormState {
  ok?: boolean;
  error?: string;
  successMessage?: string;
  /** Id только что созданного документа — UI может показать ссылку. */
  createdId?: string;
  createdNumber?: string;
}

export const initialFinishedGoodsShipmentFormState: FinishedGoodsShipmentFormState =
  {};

function explainApiError(e: unknown, fallback: string): string {
  if (e instanceof ApiRequestError) {
    const prefix = e.code ? `[${e.code}] ` : '';
    return `${prefix}${e.message}`;
  }
  return fallback;
}

function revalidateOrder(orderId: string): void {
  revalidatePath('/admin/orders');
  revalidatePath(`/admin/orders/${orderId}`);
}

/**
 * Парсит hidden-поле `payload` из `<form>`-сабмита в объект
 * `CreateFinishedGoodsShipmentDto`-совместимого формата. Backend
 * валидирует body через Zod, поэтому здесь делаем минимальную
 * нормализацию типов: строковый qty → number, отбрасываем строки
 * с qty <= 0, оставляем только знакомые поля.
 */
function normalizePayload(
  raw: unknown,
): CreateFinishedGoodsShipmentDto | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Record<string, unknown>;
  const linesRaw = candidate.lines;
  if (!Array.isArray(linesRaw)) return null;

  const lines: CreateFinishedGoodsShipmentDto['lines'] = [];
  for (const entry of linesRaw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const balanceId = typeof e.finishedGoodsBalanceId === 'string'
      ? e.finishedGoodsBalanceId.trim()
      : '';
    if (!balanceId) continue;
    const qtyRaw = e.qty;
    const qty =
      typeof qtyRaw === 'number'
        ? qtyRaw
        : Number(typeof qtyRaw === 'string' ? qtyRaw.trim() : NaN);
    if (!Number.isInteger(qty) || qty <= 0) continue;
    const comment =
      typeof e.comment === 'string' && e.comment.trim() !== ''
        ? e.comment.trim()
        : undefined;
    lines.push({
      finishedGoodsBalanceId: balanceId,
      qty,
      ...(comment ? { comment } : {}),
    });
  }
  if (lines.length === 0) return null;

  const dto: CreateFinishedGoodsShipmentDto = { lines };
  if (typeof candidate.shippedAt === 'string' && candidate.shippedAt.trim() !== '') {
    dto.shippedAt = candidate.shippedAt;
  }
  if (typeof candidate.comment === 'string' && candidate.comment.trim() !== '') {
    dto.comment = candidate.comment.trim();
  }
  if (
    typeof candidate.clientRequestId === 'string' &&
    candidate.clientRequestId.trim() !== ''
  ) {
    dto.clientRequestId = candidate.clientRequestId.trim();
  }
  return dto;
}

/**
 * Сигнатура совместима с `useFormState` + `bind(null, orderId)`:
 * `(orderId, prev, formData) → next`.
 *
 * Поля FormData:
 *   - `payload` — `JSON.stringify({ shippedAt?, comment?,
 *     clientRequestId, lines: [{ finishedGoodsBalanceId, qty,
 *     comment? }] })`.
 */
export async function createFinishedGoodsShipmentAction(
  orderId: string,
  _prev: FinishedGoodsShipmentFormState,
  form: FormData,
): Promise<FinishedGoodsShipmentFormState> {
  const raw = form.get('payload');
  if (typeof raw !== 'string' || raw.trim() === '') {
    return {
      ok: false,
      error: 'Не передана форма отгрузки.',
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      error: 'Невалидные данные формы отгрузки.',
    };
  }

  const dto = normalizePayload(parsed);
  if (!dto) {
    return {
      ok: false,
      error: 'Укажите количество хотя бы по одной строке.',
    };
  }

  try {
    const created = await createOrderFinishedGoodsShipment(orderId, dto);
    revalidateOrder(orderId);
    return {
      ok: true,
      createdId: created.id,
      createdNumber: created.number,
      successMessage: `Создан документ отгрузки ${created.number} (${created.lines.length} стр.).`,
    };
  } catch (e) {
    return {
      ok: false,
      error: explainApiError(e, 'Не удалось создать отгрузку готовой продукции'),
    };
  }
}
