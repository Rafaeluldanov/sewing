'use server';

import { revalidatePath, revalidateTag } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  AddPassportToBoxSchema,
  CreateBoxSchema,
  PlaceBoxSchema,
  type BoxDetailDto,
  type BoxListItemDto,
} from '@sewing/shared/packing';
import { ApiRequestError, errorText } from '@/lib/api';
import {
  addPassportToBox,
  closeBox,
  createBox,
  getBox,
  listBoxes,
  placeBox,
} from '@/lib/packing-api';
import type { PackingFormState } from './form-state';

function explainApiError(e: unknown): string {
  if (e instanceof ApiRequestError) {
    return errorText(e);
  }
  return 'Не удалось выполнить запрос';
}

function errorRequestId(e: unknown): string | undefined {
  return e instanceof ApiRequestError ? e.requestId : undefined;
}

function revalidateBox(box: BoxDetailDto): void {
  revalidatePath('/packing');
  revalidatePath(`/packing/boxes/${box.id}`);
  for (const it of box.items) {
    revalidatePath(`/orders/${it.orderId}`);
    revalidatePath(`/admin/orders/${it.orderId}`);
    revalidatePath(`/passports/${it.passportId}`);
    revalidatePath(`/admin/passports/${it.passportId}`);
  }
  // Закрытие коробки апрувит начисления — `/earnings` тоже стоит освежить.
  revalidatePath('/earnings');
  revalidateTag('cells');
}

// ---------------------------------------------------------------------------
// Legacy form-actions для старых страниц (`/packing/boxes/[id]`,
// форма «Новая коробка» в SHOP_MANAGER/ADMIN-вьюхе списка). Остаются
// для обратной совместимости с менеджерским сценарием — packing-терминал
// теперь живёт через client-actions ниже.
// ---------------------------------------------------------------------------

export async function createBoxAction(
  _prev: PackingFormState,
  _form: FormData,
): Promise<PackingFormState> {
  const parsed = CreateBoxSchema.safeParse({});
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Невалидные данные' };
  }
  let createdId: string;
  try {
    const box = await createBox(parsed.data);
    createdId = box.id;
  } catch (e) {
    return { error: explainApiError(e) };
  }
  revalidatePath('/packing');
  redirect(`/packing/boxes/${createdId}`);
}

export async function addPassportToBoxAction(
  boxId: string,
  _prev: PackingFormState,
  form: FormData,
): Promise<PackingFormState> {
  const code = String(form.get('code') ?? '').trim();
  if (!code) {
    return { error: 'Введите или отсканируйте код паспорта' };
  }
  const parsed = AddPassportToBoxSchema.safeParse({ code });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Невалидные данные' };
  }
  try {
    const box = await addPassportToBox(boxId, parsed.data);
    revalidateBox(box);
    return {
      info: `Паспорт добавлен. В коробке ${box.totalQty} шт.`,
    };
  } catch (e) {
    return { error: explainApiError(e) };
  }
}

export async function closeBoxAction(
  boxId: string,
  _prev: PackingFormState,
  _form: FormData,
): Promise<PackingFormState> {
  try {
    const box = await closeBox(boxId);
    revalidateBox(box);
    return { info: 'Коробка закрыта, начисления подтверждены' };
  } catch (e) {
    return { error: explainApiError(e) };
  }
}

// ---------------------------------------------------------------------------
// Scan-driven packing terminal: client actions. Возвращают данные
// (а не делают `redirect`/`revalidate`-only), чтобы терминал мог
// плавно обновлять состояние без перезагрузок и не «терять» текущую
// коробку между сканами.
// ---------------------------------------------------------------------------

export type PackingTerminalResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; errorRequestId?: string };

/**
 * Загрузить детальную карточку коробки по id.
 *
 * Используется при возврате на `/packing` (если у пользователя в
 * cookie/localStorage запомнился id активной коробки) и для refresh
 * после успешного скана (`addPassport` уже возвращает свежий
 * `BoxDetailDto`, отдельный вызов нужен только для ручного refresh
 * и поллера).
 */
export async function getActiveBoxAction(
  boxId: string,
): Promise<PackingTerminalResult<BoxDetailDto>> {
  try {
    const box = await getBox(boxId);
    return { ok: true, data: box };
  } catch (e) {
    return {
      ok: false,
      error: explainApiError(e),
      errorRequestId: errorRequestId(e),
    };
  }
}

/**
 * Список открытых (не закрытых) коробок — для Stage 1 терминала.
 * Упаковщик видит все коробки со статусом `OPEN` и может вернуться
 * к любой из них (своей или коллеги) одним кликом, не перетыкая
 * id вручную и не теряя коробку, оставленную с другого устройства.
 *
 * Backend (`PackingController.list`) уже отдаёт этот срез по
 * `?status=OPEN`; клиенту достаточно лёгкой обёртки, которая
 * возвращает массив без пагинации (на MVP коробок «в полёте»
 * меньше, чем pageSize=50).
 */
export async function listOpenBoxesTerminalAction(): Promise<
  PackingTerminalResult<BoxListItemDto[]>
> {
  try {
    const page = await listBoxes({ status: 'OPEN', page: 1, pageSize: 50 });
    return { ok: true, data: page.items };
  } catch (e) {
    return {
      ok: false,
      error: explainApiError(e),
      errorRequestId: errorRequestId(e),
    };
  }
}

/**
 * Список «закрытых, но ещё не размещённых» коробок — для Stage 1
 * терминала. Упаковщик видит, какие коробки уже упакованы и ждут,
 * пока их разнесут по ячейкам склада. После `placeBoxTerminalAction`
 * коробка из этого списка пропадает.
 */
export async function listClosedUnplacedBoxesTerminalAction(): Promise<
  PackingTerminalResult<BoxListItemDto[]>
> {
  try {
    const page = await listBoxes({
      status: 'CLOSED',
      placed: false,
      page: 1,
      pageSize: 50,
    });
    return { ok: true, data: page.items };
  } catch (e) {
    return {
      ok: false,
      error: explainApiError(e),
      errorRequestId: errorRequestId(e),
    };
  }
}

/**
 * Разместить закрытую коробку в ячейку. Принимает QR-payload `cell:<id>`
 * либо код ячейки (`Cell.code` / `Cell.qrCode`). Backend
 * (`PackingService.place`) сам резолвит код через ту же логику, что и
 * `findCellByCode` в `PassportsService`.
 */
export async function placeBoxTerminalAction(
  boxId: string,
  code: string,
): Promise<PackingTerminalResult<BoxDetailDto>> {
  const trimmed = code.trim();
  if (!trimmed) {
    return { ok: false, error: 'Введите или отсканируйте код ячейки' };
  }
  const parsed = PlaceBoxSchema.safeParse({ code: trimmed });
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
    };
  }
  try {
    const box = await placeBox(boxId, parsed.data);
    revalidateBox(box);
    return { ok: true, data: box };
  } catch (e) {
    return {
      ok: false,
      error: explainApiError(e),
      errorRequestId: errorRequestId(e),
    };
  }
}

/**
 * Создать новую коробку.
 *
 * `revalidate*` не делаем сами — терминал живёт в client-state, а
 * перезагрузка списка `/packing` (для менеджера) не нужна, пока
 * упаковщик не закроет коробку.
 */
export async function createBoxTerminalAction(): Promise<
  PackingTerminalResult<BoxDetailDto>
> {
  const parsed = CreateBoxSchema.safeParse({});
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
    };
  }
  try {
    const box = await createBox(parsed.data);
    return { ok: true, data: box };
  } catch (e) {
    return {
      ok: false,
      error: explainApiError(e),
      errorRequestId: errorRequestId(e),
    };
  }
}

/**
 * Добавить отсканированный паспорт в активную коробку.
 *
 * Источник истины — backend (`PackingService.addPassport`): он
 * проверит, что коробка открыта, паспорт жив и однороден коробке,
 * и переведёт `Passport.status = PACKED`. Финальный апрув
 * pending-начислений переехал в `closeBox` (см. ADR-0005, ADR-0011).
 */
export async function scanPassportToBoxAction(
  boxId: string,
  code: string,
): Promise<PackingTerminalResult<BoxDetailDto>> {
  const trimmed = code.trim();
  if (!trimmed) {
    return { ok: false, error: 'Введите или отсканируйте код паспорта' };
  }
  const parsed = AddPassportToBoxSchema.safeParse({ code: trimmed });
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
    };
  }
  try {
    const box = await addPassportToBox(boxId, parsed.data);
    revalidateBox(box);
    return { ok: true, data: box };
  } catch (e) {
    return {
      ok: false,
      error: explainApiError(e),
      errorRequestId: errorRequestId(e),
    };
  }
}

/**
 * Закрыть текущую коробку. По факту закрытия backend идемпотентно
 * апрувит pending-начисления всем участникам цепочки по каждому
 * упакованному в коробке паспорту (см. ADR-0005 §«Подтверждение»).
 */
export async function closeBoxTerminalAction(
  boxId: string,
): Promise<PackingTerminalResult<BoxDetailDto>> {
  try {
    const box = await closeBox(boxId);
    revalidateBox(box);
    return { ok: true, data: box };
  } catch (e) {
    return {
      ok: false,
      error: explainApiError(e),
      errorRequestId: errorRequestId(e),
    };
  }
}
