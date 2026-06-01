'use server';

/**
 * Server actions Stage 2 «Мастер цеха» — ручные действия над паспортами
 * с мобильного экрана `/master`.
 *
 * Контракт API — `apps/api/src/modules/master-actions/*`,
 * `@sewing/shared` (`master-actions.ts`). UI-потребитель —
 * `apps/web/app/master/passport-actions-sheet.tsx` + интеграция в
 * `master-page-client.tsx`.
 *
 * Принципы:
 *   - имена action'ов префиксированы `master*`, чтобы не пересекаться с
 *     обычным flow паспортов (`/api/passports/...`) и с smoke-инвариантами
 *     `actions.ts`-теста (`tests/smoke/master-calls.smoke.test.ts`);
 *   - все action'ы возвращают единый `{ ok: true, ... } | { ok: false, error, errorRequestId? }`
 *     shape — UI единообразно обрабатывает результат и не ловит exceptions;
 *   - внутри обязательно `revalidatePath('/master')`, чтобы карточки на
 *     серверной стороне обновились вместе с polling'ом клиента.
 */

import { revalidatePath } from 'next/cache';
import {
  FindMasterPassportByCodeSchema,
  ReturnPassportToCellSchema,
  SetRouteStepSchema,
  TransferPassportSchema,
  UnassignPassportSchema,
  type FindMasterPassportByCodeResultDto,
  type MasterActionResultDto,
  type PassportHistoryDto,
} from '@sewing/shared';
import {
  CreatePassportDefectSchema,
  ReturnToReworkSchema,
  type QcPassportDetailDto,
} from '@sewing/shared/qc';
import { ApiRequestError } from '@/lib/api';
import { fetchPassportHistory } from '@/lib/passports-api';
import {
  findMasterPassportByCode,
  getMasterPassportQcDetail,
  recordMasterPassportDefect,
  returnMasterPassportToCell,
  returnMasterPassportToRework,
  setMasterPassportRouteStep,
  transferMasterPassport,
  unassignMasterPassport,
} from '@/lib/master-actions-api';

function explainApiError(e: unknown): string {
  if (e instanceof ApiRequestError) {
    const prefix = e.code ? `[${e.code}] ` : '';
    return `${prefix}${e.message}`;
  }
  return 'Не удалось выполнить действие';
}

function errorRequestId(e: unknown): string | undefined {
  return e instanceof ApiRequestError ? e.requestId : undefined;
}

export type MasterActionResult =
  | { ok: true; result: MasterActionResultDto }
  | { ok: false; error: string; errorRequestId?: string };

export async function masterUnassignPassportAction(
  passportId: string,
  raw: unknown,
): Promise<MasterActionResult> {
  const parsed = UnassignPassportSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error:
        parsed.error.issues[0]?.message ??
        'Не указана причина действия — выберите её и попробуйте снова.',
    };
  }
  try {
    const result = await unassignMasterPassport(passportId, parsed.data);
    revalidatePath('/master');
    return { ok: true, result };
  } catch (e) {
    return {
      ok: false,
      error: explainApiError(e),
      errorRequestId: errorRequestId(e),
    };
  }
}

export async function masterTransferToEmployeeAction(
  passportId: string,
  raw: unknown,
): Promise<MasterActionResult> {
  const parsed = TransferPassportSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error:
        parsed.error.issues[0]?.message ??
        'Не передан сотрудник или причина — проверьте поля и попробуйте снова.',
    };
  }
  try {
    const result = await transferMasterPassport(passportId, parsed.data);
    revalidatePath('/master');
    return { ok: true, result };
  } catch (e) {
    return {
      ok: false,
      error: explainApiError(e),
      errorRequestId: errorRequestId(e),
    };
  }
}

export async function masterReturnToCellAction(
  passportId: string,
  raw: unknown,
): Promise<MasterActionResult> {
  const parsed = ReturnPassportToCellSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error:
        parsed.error.issues[0]?.message ??
        'Не передана ячейка или причина — проверьте поля и попробуйте снова.',
    };
  }
  try {
    const result = await returnMasterPassportToCell(passportId, parsed.data);
    revalidatePath('/master');
    return { ok: true, result };
  } catch (e) {
    return {
      ok: false,
      error: explainApiError(e),
      errorRequestId: errorRequestId(e),
    };
  }
}

export async function masterSetRouteStepAction(
  passportId: string,
  raw: unknown,
): Promise<MasterActionResult> {
  const parsed = SetRouteStepSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error:
        parsed.error.issues[0]?.message ??
        'Не выбрана операция или причина — проверьте поля и попробуйте снова.',
    };
  }
  try {
    const result = await setMasterPassportRouteStep(passportId, parsed.data);
    revalidatePath('/master');
    return { ok: true, result };
  } catch (e) {
    return {
      ok: false,
      error: explainApiError(e),
      errorRequestId: errorRequestId(e),
    };
  }
}

/**
 * Кнопка «Посмотреть историю паспорта» в `PassportActionsSheet` —
 * read-only выборка `PassportEvent`. `revalidatePath` не нужен, в БД
 * ничего не меняется. RBAC enforce-ит backend (SHOPFLOOR_MASTER /
 * SHOP_MANAGER / ADMIN), здесь его не дублируем.
 */
export type PassportHistoryResult =
  | { ok: true; result: PassportHistoryDto }
  | { ok: false; error: string; errorRequestId?: string };

export async function fetchPassportHistoryAction(
  passportId: string,
): Promise<PassportHistoryResult> {
  if (!passportId) {
    return { ok: false, error: 'Не передан паспорт.' };
  }
  try {
    const result = await fetchPassportHistory(passportId);
    return { ok: true, result };
  } catch (e) {
    return {
      ok: false,
      error: explainApiError(e),
      errorRequestId: errorRequestId(e),
    };
  }
}

/**
 * Кнопка «Сканировать паспорт» на `/master`. Read-only lookup —
 * `revalidatePath` не нужен, т.к. ничего в БД не меняется. Возвращаем
 * результат `MasterCallPassportDto` + `ownerFullName`, чтобы UI
 * напрямую открыл `PassportActionsSheet`.
 */
export type FindMasterPassportResult =
  | { ok: true; result: FindMasterPassportByCodeResultDto }
  | { ok: false; error: string; errorRequestId?: string };

export async function findMasterPassportByCodeAction(
  raw: unknown,
): Promise<FindMasterPassportResult> {
  const parsed = FindMasterPassportByCodeSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error:
        parsed.error.issues[0]?.message ?? 'Передайте код паспорта.',
    };
  }
  try {
    const result = await findMasterPassportByCode(parsed.data.code);
    return { ok: true, result };
  } catch (e) {
    return {
      ok: false,
      error: explainApiError(e),
      errorRequestId: errorRequestId(e),
    };
  }
}

// ---------------------------------------------------------------------------
// ОТК-действия мастера: «зафиксировать брак» / «вернуть на доработку».
// Делегируют в `QcService` на бэке (см. `master-actions.controller.ts`).
// Все возвращают свежий `QcPassportDetailDto`, чтобы UI обновил карточку.
// ---------------------------------------------------------------------------

export type MasterQcDetailResult =
  | { ok: true; detail: QcPassportDetailDto }
  | { ok: false; error: string; errorRequestId?: string };

/**
 * ОТК-карточка паспорта для режимов «брак» / «возврат» в
 * `PassportActionsSheet`. Read-only — `revalidatePath` не нужен.
 */
export async function fetchMasterQcDetailAction(
  passportId: string,
): Promise<MasterQcDetailResult> {
  if (!passportId) return { ok: false, error: 'Не передан паспорт.' };
  try {
    const detail = await getMasterPassportQcDetail(passportId);
    return { ok: true, detail };
  } catch (e) {
    return {
      ok: false,
      error: explainApiError(e),
      errorRequestId: errorRequestId(e),
    };
  }
}

/** Зафиксировать брак по паспорту (см. `QcService.recordDefect`). */
export async function recordMasterDefectAction(
  passportId: string,
  raw: unknown,
): Promise<MasterQcDetailResult> {
  const parsed = CreatePassportDefectSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные брака.',
    };
  }
  try {
    const detail = await recordMasterPassportDefect(passportId, parsed.data);
    revalidatePath('/master');
    return { ok: true, detail };
  } catch (e) {
    return {
      ok: false,
      error: explainApiError(e),
      errorRequestId: errorRequestId(e),
    };
  }
}

/** Вернуть паспорт на выбранную SEW-операцию (см. `QcService.returnToRework`). */
export async function returnMasterToReworkAction(
  passportId: string,
  targetOperationId: string,
): Promise<MasterQcDetailResult> {
  const parsed = ReturnToReworkSchema.safeParse({ targetOperationId });
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Выберите операцию для возврата.',
    };
  }
  try {
    const detail = await returnMasterPassportToRework(
      passportId,
      parsed.data.targetOperationId,
    );
    revalidatePath('/master');
    return { ok: true, detail };
  } catch (e) {
    return {
      ok: false,
      error: explainApiError(e),
      errorRequestId: errorRequestId(e),
    };
  }
}
