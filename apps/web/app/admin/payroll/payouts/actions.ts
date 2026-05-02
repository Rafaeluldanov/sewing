'use server';

/**
 * Server actions модуля «PayrollPayout» (PHASE 3 STEP 4).
 *
 * RBAC — на backend (`@Roles('SHOP_MANAGER', 'ADMIN')`). Frontend
 * дополнительно скрывает раздел через `app/admin/layout.tsx`.
 *
 * ACK (действие «подтверждение сотрудником») намеренно НЕ включён —
 * это действие сотрудника (PHASE 3 STEP 5).
 */

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  CancelPayrollPayoutSchema,
  CreatePayrollPayoutSchema,
} from '@sewing/shared/payroll-payouts';
import { ApiRequestError } from '@/lib/api';
import {
  cancelPayrollPayout,
  createPayrollPayout,
  issuePayrollPayout,
  recomputePayrollPayout,
} from '@/lib/payroll-payouts-api';
import type { PayrollPayoutActionState } from './form-state';

export type { PayrollPayoutActionState };

const LIST_PATH = '/admin/payroll/payouts';

function detailPath(id: string): string {
  return `/admin/payroll/payouts/${id}`;
}

function explainApiError(e: unknown): { error: string; requestId?: string } {
  if (e instanceof ApiRequestError) {
    return {
      error: `${e.message}${e.code ? ` (${e.code})` : ''}`,
      requestId: e.requestId,
    };
  }
  return { error: 'Не удалось выполнить запрос' };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createPayrollPayoutAction(
  _prev: PayrollPayoutActionState,
  form: FormData,
): Promise<PayrollPayoutActionState> {
  const raw = {
    employeeId: String(form.get('employeeId') ?? '').trim(),
    periodFrom: String(form.get('periodFrom') ?? '').trim(),
    periodTo: String(form.get('periodTo') ?? '').trim(),
    managerComment:
      form.get('managerComment') !== null
        ? String(form.get('managerComment') ?? '').trim() || null
        : undefined,
  };
  const parsed = CreatePayrollPayoutSchema.safeParse(raw);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Невалидные данные' };
  }
  let id: string;
  try {
    const payout = await createPayrollPayout(parsed.data);
    id = payout.id;
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
  revalidatePath(LIST_PATH);
  redirect(detailPath(id));
}

// ---------------------------------------------------------------------------
// Recompute (DRAFT only)
// ---------------------------------------------------------------------------

export async function recomputePayrollPayoutAction(
  id: string,
  _prev: PayrollPayoutActionState,
  _form: FormData,
): Promise<PayrollPayoutActionState> {
  try {
    await recomputePayrollPayout(id, {});
    revalidatePath(LIST_PATH);
    revalidatePath(detailPath(id));
    return { ok: true };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}

// ---------------------------------------------------------------------------
// Issue (DRAFT → ISSUED)
// ---------------------------------------------------------------------------

export async function issuePayrollPayoutAction(
  id: string,
  _prev: PayrollPayoutActionState,
  _form: FormData,
): Promise<PayrollPayoutActionState> {
  try {
    await issuePayrollPayout(id);
    revalidatePath(LIST_PATH);
    revalidatePath(detailPath(id));
    return { ok: true };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}

// ---------------------------------------------------------------------------
// Cancel (DRAFT → CANCELLED, ISSUED → CANCELLED)
// ---------------------------------------------------------------------------

export async function cancelPayrollPayoutAction(
  id: string,
  _prev: PayrollPayoutActionState,
  form: FormData,
): Promise<PayrollPayoutActionState> {
  const raw = {
    reason:
      form.get('reason') !== null
        ? String(form.get('reason') ?? '').trim() || null
        : undefined,
  };
  const parsed = CancelPayrollPayoutSchema.safeParse(raw);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Невалидные данные' };
  }
  try {
    await cancelPayrollPayout(id, parsed.data);
    revalidatePath(LIST_PATH);
    revalidatePath(detailPath(id));
    return { ok: true };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}
