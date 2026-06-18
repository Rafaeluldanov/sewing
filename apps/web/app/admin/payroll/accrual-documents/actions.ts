'use server';

/**
 * Server actions модуля «PayrollAccrualDocument» (PHASE 3 STEP 6.3).
 *
 * RBAC — на backend (`@Roles('SHOP_MANAGER', 'ADMIN')`). Frontend
 * дополнительно скрывает раздел через `app/admin/layout.tsx`.
 */

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  CancelPayrollAccrualDocumentSchema,
  CreatePayrollAccrualDocumentSchema,
  UpdatePayrollAccrualDocumentLineSchema,
} from '@sewing/shared/payroll-accrual-documents';
import { ApiRequestError, errorText } from '@/lib/api';
import {
  cancelPayrollAccrualDocument,
  createPayrollAccrualDocument,
  payPayrollAccrualDocument,
  recomputePayrollAccrualDocument,
  updatePayrollAccrualDocumentLine,
} from '@/lib/payroll-accrual-documents-api';

export interface AccrualDocumentActionState {
  ok?: boolean;
  error?: string;
  errorRequestId?: string;
}

const LIST_PATH = '/admin/payroll/accrual-documents';
const PAYROLL_PATH = '/admin/payroll';

function detailPath(id: string): string {
  return `/admin/payroll/accrual-documents/${id}`;
}

function explainApiError(e: unknown): { error: string; requestId?: string } {
  if (e instanceof ApiRequestError) {
    return {
      error: errorText(e),
      requestId: e.requestId,
    };
  }
  return { error: 'Не удалось выполнить запрос' };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createPayrollAccrualDocumentAction(
  _prev: AccrualDocumentActionState,
  form: FormData,
): Promise<AccrualDocumentActionState> {
  const raw = {
    accrualDate: String(form.get('accrualDate') ?? '').trim(),
    employeeId: String(form.get('employeeId') ?? '').trim() || null,
    managerComment:
      form.get('managerComment') !== null
        ? String(form.get('managerComment') ?? '').trim() || null
        : undefined,
  };
  const parsed = CreatePayrollAccrualDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Невалидные данные' };
  }
  let id: string;
  try {
    const doc = await createPayrollAccrualDocument(parsed.data);
    id = doc.id;
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
  revalidatePath(LIST_PATH);
  revalidatePath(PAYROLL_PATH);
  redirect(detailPath(id));
}

// ---------------------------------------------------------------------------
// Recompute (DRAFT only)
// ---------------------------------------------------------------------------

export async function recomputePayrollAccrualDocumentAction(
  id: string,
  _prev: AccrualDocumentActionState,
  _form: FormData,
): Promise<AccrualDocumentActionState> {
  try {
    await recomputePayrollAccrualDocument(id);
    revalidatePath(PAYROLL_PATH);
    revalidatePath(LIST_PATH);
    revalidatePath(detailPath(id));
    return { ok: true };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}

// ---------------------------------------------------------------------------
// Update line (DRAFT only)
// ---------------------------------------------------------------------------

export async function updatePayrollAccrualDocumentLineAction(
  documentId: string,
  lineId: string,
  _prev: AccrualDocumentActionState,
  form: FormData,
): Promise<AccrualDocumentActionState> {
  const manualAdjustRaw = String(form.get('manualAdjustRub') ?? '').trim();
  const raw = {
    manualAdjustRub:
      manualAdjustRaw !== '' ? Number(manualAdjustRaw) : undefined,
    manualComment:
      form.get('manualComment') !== null
        ? String(form.get('manualComment') ?? '').trim() || null
        : undefined,
  };
  const parsed = UpdatePayrollAccrualDocumentLineSchema.safeParse(raw);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Невалидные данные' };
  }
  try {
    await updatePayrollAccrualDocumentLine(documentId, lineId, parsed.data);
    revalidatePath(PAYROLL_PATH);
    revalidatePath(LIST_PATH);
    revalidatePath(detailPath(documentId));
    return { ok: true };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}

// ---------------------------------------------------------------------------
// Pay (DRAFT → PAID)
// ---------------------------------------------------------------------------

export async function payPayrollAccrualDocumentAction(
  id: string,
  _prev: AccrualDocumentActionState,
  _form: FormData,
): Promise<AccrualDocumentActionState> {
  try {
    await payPayrollAccrualDocument(id);
    revalidatePath(PAYROLL_PATH);
    revalidatePath(LIST_PATH);
    revalidatePath(detailPath(id));
    return { ok: true };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}

// ---------------------------------------------------------------------------
// Cancel (DRAFT → CANCELLED)
// ---------------------------------------------------------------------------

export async function cancelPayrollAccrualDocumentAction(
  id: string,
  _prev: AccrualDocumentActionState,
  form: FormData,
): Promise<AccrualDocumentActionState> {
  const raw = {
    reason:
      form.get('reason') !== null
        ? String(form.get('reason') ?? '').trim() || null
        : undefined,
  };
  const parsed = CancelPayrollAccrualDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Невалидные данные' };
  }
  try {
    await cancelPayrollAccrualDocument(id, parsed.data);
    revalidatePath(PAYROLL_PATH);
    revalidatePath(LIST_PATH);
    revalidatePath(detailPath(id));
    return { ok: true };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}
