'use server';

/**
 * Server actions для shelf-placement flow помощника раскройщика
 * (см. `docs/flows.md §F3b`, `docs/screens.md §3.8`).
 *
 * Никаких новых бизнес-правил здесь не появляется — это тонкие
 * прокладки между UI на /work и существующими endpoint-ами:
 *
 *   - `POST /api/cells/by-code`     → резолвим ячейку до confirm-модалки;
 *   - `POST /api/passports/by-code` → резолвим паспорт по QR;
 *   - `POST /api/passports/:id/place` → собственно размещение в ячейку.
 *
 * Все ошибки нормализуются в `{ ok: false, error, errorRequestId }`,
 * чтобы фронтовая state-machine могла единообразно показать `error-box`
 * с request-id для поддержки (Шаг 12, Pilot Rollout). Каждый успешный
 * ответ revalidate-ит карточку паспорта и `/passports/:id`, чтобы
 * последующее открытие паспорта сразу видело новую ячейку.
 */

import { revalidatePath, revalidateTag } from 'next/cache';
import { ApiRequestError, errorText } from '@/lib/api';
import { findCellByCode, placePassport } from '@/lib/passports-api';
import { findPassportByCode } from '@/lib/shifts-api';
import type { CellDetailDto } from '@sewing/shared/passports';

export interface ShelfCellLite {
  id: string;
  code: string;
  qrCode: string;
  active: boolean;
  /** Сжатый срез содержимого (sizeCode × qty) — для confirm-модалки. */
  contents: { sizeCode: string; quantity: number }[];
}

export type ShelfCellResponse =
  | { ok: true; cell: ShelfCellLite }
  | { ok: false; error: string; errorRequestId?: string };

export interface ShelfPlacedPassport {
  id: string;
  number: string;
  productName: string;
  color: string;
  sizeCode: string;
  qtyCut: number;
  rollNumber: string;
  cellCode: string;
}

export type ShelfPlaceResponse =
  | { ok: true; passport: ShelfPlacedPassport }
  | {
      ok: false;
      error: string;
      /**
       * Backend `code` (например, `PASSPORT_ALREADY_PLACED`) — UI на
       * /work маппит его в дружелюбный двухстрочный текст. Если кода
       * нет (сетевая/неизвестная ошибка) — UI fallback-ит к `error`.
       */
      errorCode?: string;
      /**
       * Доп. контекст для конкретных кодов. Сейчас используется
       * только `placedInCellCode` для `PASSPORT_ALREADY_PLACED`,
       * чтобы UI смог показать «Паспорт уже размещён в ячейке D1»
       * без повторного запроса в API.
       */
      placedInCellCode?: string;
      errorRequestId?: string;
    };

function explainApiError(e: unknown): string {
  if (e instanceof ApiRequestError) {
    return errorText(e);
  }
  return 'Не удалось выполнить запрос';
}

function errorRequestId(e: unknown): string | undefined {
  return e instanceof ApiRequestError ? e.requestId : undefined;
}

function errorCode(e: unknown): string | undefined {
  return e instanceof ApiRequestError ? e.code : undefined;
}

/**
 * Backend message по `PASSPORT_ALREADY_PLACED` имеет фиксированный
 * формат «Паспорт уже размещён в ячейке {code}. ...» (см.
 * `apps/api/src/common/errors.ts`). Извлекаем код ячейки регуляркой,
 * чтобы UI показал помощнику конкретное место («D1»), а не общий
 * «уже размещён где-то» — иначе помощник будет искать паспорт
 * физически и потеряет минуту на каждом таком конфликте.
 */
function extractAlreadyPlacedCellCode(message: string): string | undefined {
  const m = message.match(/в ячейке\s+([^\s.,;]+)/i);
  return m?.[1];
}

function toLite(cell: CellDetailDto): ShelfCellLite {
  return {
    id: cell.id,
    code: cell.code,
    qrCode: cell.qrCode,
    active: cell.active,
    contents: cell.contents.map((c) => ({
      sizeCode: c.sizeCode,
      quantity: c.quantity,
    })),
  };
}

/**
 * Резолв ячейки по произвольному коду. Без побочных эффектов — нужен
 * для confirm-модалки перед стартом сессии размещения.
 */
export async function lookupCellByCodeAction(
  code: string,
): Promise<ShelfCellResponse> {
  const trimmed = code.trim();
  if (!trimmed) {
    return { ok: false, error: 'Введите или отсканируйте код ячейки' };
  }
  try {
    const cell = await findCellByCode(trimmed);
    return { ok: true, cell: toLite(cell) };
  } catch (e) {
    return {
      ok: false,
      error: explainApiError(e),
      errorRequestId: errorRequestId(e),
    };
  }
}

/**
 * Размещение конкретного паспорта в подтверждённую ранее ячейку.
 *
 * Вся бизнес-логика остаётся в backend (`POST /api/passports/:id/place`):
 * здесь мы только нормализуем известные коды ошибок (например,
 * `PASSPORT_ALREADY_PLACED`) для дружелюбного UI на /work. Сами
 * правила размещения backend не дублируем.
 *
 * Принимает уже подтверждённый `cellId` (получили его из
 * `lookupCellByCodeAction`) и сырой `passportCode` (ровно то, что
 * пришло из QR-сканера или ручного ввода). Резолв паспорта делаем
 * здесь же — UI на одной операции делает только один тап.
 */
export async function placePassportToCellAction(
  cellId: string,
  cellCode: string,
  passportCode: string,
): Promise<ShelfPlaceResponse> {
  const trimmed = passportCode.trim();
  if (!cellId) {
    return { ok: false, error: 'Сначала подтвердите ячейку' };
  }
  if (!trimmed) {
    return { ok: false, error: 'Введите или отсканируйте код паспорта' };
  }
  try {
    const passport = await findPassportByCode(trimmed);
    const result = await placePassport(passport.id, { cellId });
    revalidatePath(`/passports/${passport.id}`);
    revalidatePath(`/admin/passports/${passport.id}`);
    revalidatePath(`/orders/${passport.orderId}`);
    revalidatePath(`/admin/orders/${passport.orderId}`);
    revalidateTag('cells');
    const updated = result.passport;
    return {
      ok: true,
      passport: {
        id: updated.id,
        number: updated.number,
        productName: updated.productName,
        color: updated.color,
        sizeCode: updated.sizeCode,
        qtyCut: updated.qtyCut,
        rollNumber: updated.rollNumber,
        cellCode: result.cell.code || cellCode,
      },
    };
  } catch (e) {
    const code = errorCode(e);
    const message = e instanceof ApiRequestError ? e.message : '';
    return {
      ok: false,
      error: explainApiError(e),
      errorCode: code,
      placedInCellCode:
        code === 'PASSPORT_ALREADY_PLACED'
          ? extractAlreadyPlacedCellCode(message)
          : undefined,
      errorRequestId: errorRequestId(e),
    };
  }
}
