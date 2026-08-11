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
  MasterSelfOperationSchema,
  ReturnPassportToCellSchema,
  SetRouteStepSchema,
  TransferPassportSchema,
  UnassignPassportSchema,
  type FindMasterPassportByCodeResultDto,
  type MasterActionResultDto,
  type MasterSelfOperationStepsDto,
  type MasterTransferCandidatesDto,
  type PassportHistoryDto,
} from '@sewing/shared';
import {
  CreatePassportDefectSchema,
  ReturnToReworkSchema,
  type QcPassportDetailDto,
} from '@sewing/shared/qc';
import {
  CreatePassportQtyCorrectionSchema,
  type ApprovePassportQtyCorrectionResultDto,
} from '@sewing/shared/passport-qty-corrections';
import { ApiRequestError, errorText } from '@/lib/api';
import { fetchPassportHistory } from '@/lib/passports-api';
import {
  applyMasterQtyCorrection,
  findMasterPassportByCode,
  getMasterPassportQcDetail,
  getMasterSelfOperationSteps,
  listMasterTransferCandidates,
  performMasterSelfOperation,
  recordMasterPassportDefect,
  returnMasterPassportToCell,
  returnMasterPassportToRework,
  setMasterPassportRouteStep,
  transferMasterPassport,
  unassignMasterPassport,
} from '@/lib/master-actions-api';

function explainApiError(e: unknown): string {
  if (e instanceof ApiRequestError) {
    return errorText(e);
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

export type MasterTransferCandidatesResult =
  | { ok: true; result: MasterTransferCandidatesDto }
  | { ok: false; error: string; errorRequestId?: string };

/**
 * Список сотрудников для «Передать сотруднику». Read-only —
 * `revalidatePath` не нужен. `passportId` передаём всегда, когда он
 * известен: от него зависит порядок строк (сначала те, чья смена стоит
 * на текущем шаге паспорта).
 */
export async function fetchMasterTransferCandidatesAction(
  passportId?: string,
): Promise<MasterTransferCandidatesResult> {
  try {
    const result = await listMasterTransferCandidates(passportId);
    return { ok: true, result };
  } catch (e) {
    return {
      ok: false,
      error: explainApiError(e),
      errorRequestId: errorRequestId(e),
    };
  }
}

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
// «Выполнить операцию самой»: мастер работает руками.
// ---------------------------------------------------------------------------

export type MasterSelfOperationStepsResult =
  | { ok: true; result: MasterSelfOperationStepsDto }
  | { ok: false; error: string; errorRequestId?: string };

/**
 * Шаги маршрута для режима «выполнить операцию самой». Read-only —
 * `revalidatePath` не нужен.
 */
export async function fetchMasterSelfOperationStepsAction(
  passportId: string,
): Promise<MasterSelfOperationStepsResult> {
  if (!passportId) return { ok: false, error: 'Не передан паспорт.' };
  try {
    const result = await getMasterSelfOperationSteps(passportId);
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
 * Мастер выполнила операцию сама. Паспорт двигается по маршруту теми же
 * событиями, что и у швеи, поэтому ревалидируем `/master` — карточки
 * вызовов и доска «Движение тиража» обязаны это увидеть.
 */
export async function masterSelfOperationAction(
  passportId: string,
  raw: unknown,
): Promise<MasterActionResult> {
  const parsed = MasterSelfOperationSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Выберите операцию маршрута.',
    };
  }
  try {
    const result = await performMasterSelfOperation(passportId, parsed.data);
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

export type MasterQtyCorrectionResult =
  | { ok: true; result: ApprovePassportQtyCorrectionResultDto }
  | { ok: false; error: string; errorRequestId?: string };

/**
 * Одношаговая корректировка количества по паспорту: мастер сам аппрувер,
 * заявка создаётся и применяется сразу (см.
 * `PassportQtyCorrectionsService.applyByMaster`). Ревалидируем те же
 * страницы, что и approve заявки ОТК
 * (`apps/web/app/master/qty-corrections-actions.ts`) — количества
 * паспорта видны в заказе и карточке паспорта.
 */
export async function applyMasterQtyCorrectionAction(
  passportId: string,
  qtyAfter: number,
  reason?: string,
): Promise<MasterQtyCorrectionResult> {
  const parsed = CreatePassportQtyCorrectionSchema.safeParse({
    qtyAfter,
    reason: reason && reason.trim() ? reason.trim() : undefined,
  });
  if (!parsed.success) {
    return {
      ok: false,
      error:
        parsed.error.issues[0]?.message ?? 'Невалидные данные корректировки.',
    };
  }
  try {
    const result = await applyMasterQtyCorrection(passportId, parsed.data);
    revalidatePath('/master');
    revalidatePath(`/orders/${result.correction.orderId}`);
    revalidatePath(`/admin/orders/${result.correction.orderId}`);
    revalidatePath(`/admin/passports/${result.correction.passportId}`);
    return { ok: true, result };
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
