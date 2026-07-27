'use server';

/**
 * Server actions для блока «Фактический расход материалов» в карточке
 * заказа (`/admin/orders/[id]?tab=needs`, компонент
 * `MaterialIssuesSection`).
 *
 * См. `apps/api/src/modules/material-issues/*`,
 * `apps/web/lib/material-issues-api.ts`,
 * `apps/web/components/orders/material-issues/*`,
 * `docs/api.md §20a «Material issues»`.
 *
 * Контракт сабмита:
 *   - `createMaterialIssueAction` — создание DRAFT-документа. Сабмит
 *     идёт через `<form action>` + hidden `payload` с JSON-ом строк
 *     (см. `CreateMaterialIssueDialog`). После успеха —
 *     `revalidatePath('/admin/orders/[id]')`, чтобы RSC блока
 *     перечитал список.
 *   - `postMaterialIssueAction` — перевод DRAFT → POSTED. Сабмит
 *     идёт из маленькой `<form>` с hidden `id`.
 *   - `cancelMaterialIssueAction` — перевод DRAFT → CANCELLED. Сабмит
 *     из `<form>` с hidden `id` + опциональный `reason` (textarea
 *     внутри confirm-диалога).
 *
 * Контракт state-объекта идентичен другим server-actions блока
 * заказа (см. `applications-actions.ts`,
 * `material-arrivals-actions.ts`): `ok`, `error`, `fieldErrors`,
 * `successMessage`. Совместим с `useFormState`.
 */

import { revalidatePath } from 'next/cache';
import {
  CancelMaterialIssueSchema,
  CreateMaterialIssueSchema,
  ReturnMaterialIssueSchema,
  type CancelMaterialIssueDto,
  type CreateMaterialIssueDto,
  type ReturnMaterialIssueDto,
} from '@sewing/shared/material-issues';
import { ApiRequestError, errorText } from '@/lib/api';
import {
  cancelMaterialIssue,
  createMaterialIssue,
  postMaterialIssue,
  returnMaterialIssue,
} from '@/lib/material-issues-api';
// Тип и initial state живут в отдельном модуле: `'use server'` файл
// может экспортировать только async-функции.
import type { MaterialIssueFormState } from './material-issues-form-state';

function explainApiError(e: unknown, fallback: string): string {
  if (e instanceof ApiRequestError) {
    return errorText(e);
  }
  return fallback;
}

function revalidateOrder(orderId: string): void {
  revalidatePath('/admin/orders');
  revalidatePath(`/admin/orders/${orderId}`);
  revalidatePath(`/orders/${orderId}`);
}

// ---------------------------------------------------------------------------
// CREATE
// ---------------------------------------------------------------------------

/**
 * Парсит hidden-поле `payload` из `<form>`-сабмита в объект
 * `CreateMaterialIssueDto`-совместимого формата. Валидируется ниже
 * через `CreateMaterialIssueSchema` — мы не доверяем клиентскому JSON.
 */
function parseCreatePayload(form: FormData): unknown {
  const raw = form.get('payload');
  if (raw === null) return null;
  const text = String(raw).trim();
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Сигнатура совместима с `useFormState` + `bind(null, orderId)`:
 * `(orderId, prev, formData) → next`.
 *
 * Поля FormData:
 *   - `payload` — `JSON.stringify({ passportId?, lines: [...] })`,
 *     сериализованный клиентским диалогом. `orderId` server action
 *     подставляет самостоятельно — не верим клиенту.
 */
export async function createMaterialIssueAction(
  orderId: string,
  _prev: MaterialIssueFormState,
  form: FormData,
): Promise<MaterialIssueFormState> {
  const raw = parseCreatePayload(form);
  if (!raw || typeof raw !== 'object') {
    return {
      ok: false,
      error: 'Невалидные данные формы расхода',
    };
  }

  const candidate = {
    ...(raw as Record<string, unknown>),
    // Server action — источник истины для `orderId`. Клиентский JSON
    // не может изменить, в какой заказ попадёт документ.
    orderId,
  };

  const parsed = CreateMaterialIssueSchema.safeParse(candidate);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const path = issue.path.join('.');
      fieldErrors[path] = issue.message;
    }
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
      fieldErrors,
    };
  }

  const dto: CreateMaterialIssueDto = parsed.data;
  try {
    const created = await createMaterialIssue(dto);
    revalidateOrder(orderId);
    return {
      ok: true,
      createdId: created.id,
      successMessage: `Создан черновик расхода (${created.lines.length} стр.)`,
    };
  } catch (e) {
    return {
      ok: false,
      error: explainApiError(e, 'Не удалось создать документ расхода'),
    };
  }
}

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

/**
 * Сигнатура совместима с `useFormState` + `bind(null, orderId, id)`:
 * `(orderId, id, prev, formData) → next`.
 *
 * FormData не содержит обязательных полей — id и orderId уже
 * зашиты в bind-аргументы, а backend сам проверяет, что документ в
 * статусе `DRAFT`.
 */
export async function postMaterialIssueAction(
  orderId: string,
  id: string,
  _prev: MaterialIssueFormState,
  _form: FormData,
): Promise<MaterialIssueFormState> {
  try {
    await postMaterialIssue(id);
    revalidateOrder(orderId);
    return {
      ok: true,
      successMessage: 'Документ расхода проведён.',
    };
  } catch (e) {
    return {
      ok: false,
      error: explainApiError(e, 'Не удалось провести документ расхода'),
    };
  }
}

// ---------------------------------------------------------------------------
// CANCEL
// ---------------------------------------------------------------------------

/**
 * Сигнатура совместима с `useFormState` + `bind(null, orderId, id)`:
 * `(orderId, id, prev, formData) → next`.
 *
 * Поля FormData:
 *   - `reason` (опционально) — причина отмены, max 2000 символов.
 */
export async function cancelMaterialIssueAction(
  orderId: string,
  id: string,
  _prev: MaterialIssueFormState,
  form: FormData,
): Promise<MaterialIssueFormState> {
  const reasonRaw = form.get('reason');
  const reason =
    typeof reasonRaw === 'string' && reasonRaw.trim() !== ''
      ? reasonRaw.trim()
      : undefined;

  const parsed = CancelMaterialIssueSchema.safeParse({
    ...(reason === undefined ? {} : { reason }),
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const path = issue.path.join('.');
      fieldErrors[path] = issue.message;
    }
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
      fieldErrors,
    };
  }
  const dto: CancelMaterialIssueDto = parsed.data;

  try {
    await cancelMaterialIssue(id, dto);
    revalidateOrder(orderId);
    return {
      ok: true,
      successMessage: 'Документ расхода отменён.',
    };
  } catch (e) {
    return {
      ok: false,
      error: explainApiError(e, 'Не удалось отменить документ расхода'),
    };
  }
}

// ---------------------------------------------------------------------------
// RETURN (полное сторно или частичный возврат проведённого расхода)
// ---------------------------------------------------------------------------

/**
 * Парсит hidden-поле `linesPayload` (JSON-сериализованный массив
 * `[{ materialIssueLineId, returnedQty }]`) из `<form>`-сабмита.
 * Возвращает unknown → дальше валидируем через `ReturnMaterialIssueSchema`.
 *
 * Если `linesPayload` отсутствует или пустой → `undefined` (legacy-
 * полное сторно, backend сам посчитает остаток).
 */
function parseReturnLinesPayload(form: FormData): unknown {
  const raw = form.get('linesPayload');
  if (raw === null) return undefined;
  const text = String(raw).trim();
  if (text === '' || text === '[]') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // Невалидный JSON — пробросим через Zod с осмысленной ошибкой
    // (`lines` ожидает массив, передадим строку — Zod вернёт
    // type-mismatch).
    return text;
  }
}

/**
 * Сигнатура совместима с `useFormState` + `bind(null, orderId, id)`:
 * `(orderId, id, prev, formData) → next`.
 *
 * FormData:
 *   - `reason` (required, 2..500) — причина возврата;
 *   - `clientRequestId` (optional, 1..128) — UUID формы для
 *     идемпотентности повторного submit;
 *   - `linesPayload` (optional) — JSON-сериализованный массив
 *     `[{ materialIssueLineId: string, returnedQty: string }]`.
 *     Если отсутствует / пустой массив — backend выполняет полное
 *     сторно (legacy-режим, backward-compat). Если присутствует —
 *     частичный возврат только по указанным строкам.
 *
 * UI всегда отправляет `linesPayload`, кнопка «Заполнить всё
 * доступное» проставляет максимумы — это даёт «полное сторно»
 * через тот же механизм. Legacy-режим без `linesPayload` оставлен
 * для server-to-server клиентов и совместимости старых тестов.
 */
export async function returnMaterialIssueAction(
  orderId: string,
  id: string,
  _prev: MaterialIssueFormState,
  form: FormData,
): Promise<MaterialIssueFormState> {
  const reasonRaw = form.get('reason');
  const clientRequestIdRaw = form.get('clientRequestId');
  const reason = typeof reasonRaw === 'string' ? reasonRaw.trim() : '';
  const clientRequestId =
    typeof clientRequestIdRaw === 'string' && clientRequestIdRaw.trim() !== ''
      ? clientRequestIdRaw.trim()
      : undefined;
  const linesPayload = parseReturnLinesPayload(form);

  // Дополнительный фильтр на уровне server action: если клиент
  // прислал нулевые / пустые строки в JSON (теоретически возможно
  // для нестандартного клиента), убираем их ДО валидации, чтобы
  // Zod не поднимал шум на и так невалидных строках. Для UI это
  // безвредно — наш собственный диалог уже фильтрует zero qty.
  let normalizedLines: Array<unknown> | undefined;
  if (Array.isArray(linesPayload)) {
    normalizedLines = linesPayload.filter((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      const candidate = entry as { returnedQty?: unknown };
      const qty = candidate.returnedQty;
      if (qty === undefined || qty === null) return false;
      const n = typeof qty === 'number' ? qty : Number(String(qty).trim());
      return Number.isFinite(n) && n > 0;
    });
    if (normalizedLines.length === 0) {
      // Все строки нулевые — нечего возвращать.
      return {
        ok: false,
        error:
          'Укажите количество к возврату хотя бы по одной строке.',
      };
    }
  }

  const parsed = ReturnMaterialIssueSchema.safeParse({
    reason,
    ...(clientRequestId === undefined ? {} : { clientRequestId }),
    ...(normalizedLines === undefined ? {} : { lines: normalizedLines }),
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const path = issue.path.join('.');
      fieldErrors[path] = issue.message;
    }
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
      fieldErrors,
    };
  }
  const dto: ReturnMaterialIssueDto = parsed.data;

  try {
    await returnMaterialIssue(id, dto);
    revalidateOrder(orderId);
    return {
      ok: true,
      successMessage: 'Документ расхода сторнирован.',
    };
  } catch (e) {
    return {
      ok: false,
      error: explainApiError(e, 'Не удалось сторнировать документ расхода'),
    };
  }
}
