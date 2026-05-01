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
  ReturnPassportToCellSchema,
  SetRouteStepSchema,
  TransferPassportSchema,
  UnassignPassportSchema,
  type MasterActionResultDto,
} from '@sewing/shared';
import { ApiRequestError } from '@/lib/api';
import {
  returnMasterPassportToCell,
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
