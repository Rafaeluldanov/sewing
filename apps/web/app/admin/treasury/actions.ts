'use server';

/**
 * Server actions раздела «Казначейство» (Фаза 0 — журнал ДС).
 *
 * RBAC — на backend (`@Roles('ADMIN','SHOP_MANAGER')` в
 * `TreasuryController`). Sidebar дополнительно гейтит пункт флагом
 * `NEXT_PUBLIC_FEATURE_TREASURY`.
 */

import { revalidatePath } from 'next/cache';
import {
  CreateCashAccountSchema,
  UpdateCashAccountSchema,
  CreateCashFlowItemSchema,
  UpdateCashFlowItemSchema,
  CreateCashFlowEntrySchema,
  StornoCashFlowEntrySchema,
  CreateSupplierPaymentSchema,
  CancelSupplierPaymentSchema,
  UpdateTreasurySettingsSchema,
  type CreateCashAccountDto,
  type CreateCashFlowItemDto,
  type CreateCashFlowEntryDto,
  type CreateSupplierPaymentDto,
} from '@sewing/shared/treasury';
import { ApiRequestError, errorText } from '@/lib/api';
import {
  createCashAccount,
  updateCashAccount,
  createCashFlowItem,
  updateCashFlowItem,
  createCashFlowEntry,
  stornoCashFlowEntry,
  createSupplierPayment,
  approveSupplierPayment,
  paySupplierPayment,
  cancelSupplierPayment,
  updateTreasurySettings,
} from '@/lib/treasury-api';
import type { TreasuryFormState } from './form-state';

function explainApiError(e: unknown): { error: string; requestId?: string } {
  if (e instanceof ApiRequestError) {
    return { error: errorText(e), requestId: e.requestId };
  }
  return { error: 'Не удалось выполнить запрос' };
}

function str(form: FormData, key: string): string {
  return String(form.get(key) ?? '').trim();
}

function optStr(form: FormData, key: string): string | undefined {
  const v = form.get(key);
  if (v === null) return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
}

// ---------------------------------------------------------------------------
// Проводки журнала
// ---------------------------------------------------------------------------

export async function createCashFlowEntryAction(
  _prev: TreasuryFormState,
  form: FormData,
): Promise<TreasuryFormState> {
  const dto: CreateCashFlowEntryDto = {
    accountId: str(form, 'accountId'),
    itemId: str(form, 'itemId'),
    direction: str(form, 'direction') as CreateCashFlowEntryDto['direction'],
    amount: str(form, 'amount'),
    source: (optStr(form, 'source') ??
      'OTHER') as CreateCashFlowEntryDto['source'],
    sourceId: optStr(form, 'sourceId') ?? null,
    postedAt: optStr(form, 'postedAt'),
    note: optStr(form, 'note') ?? null,
  };
  const parsed = CreateCashFlowEntrySchema.safeParse(dto);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Невалидные данные' };
  }
  try {
    await createCashFlowEntry(parsed.data);
    revalidatePath('/admin/treasury');
    return { ok: true, successMessage: 'Проводка добавлена.' };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}

export async function stornoCashFlowEntryAction(
  entryId: string,
  _prev: TreasuryFormState,
  form: FormData,
): Promise<TreasuryFormState> {
  const parsed = StornoCashFlowEntrySchema.safeParse({
    note: optStr(form, 'note'),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Невалидные данные' };
  }
  try {
    await stornoCashFlowEntry(entryId, parsed.data);
    revalidatePath('/admin/treasury');
    return { ok: true, successMessage: 'Проводка сторнирована.' };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}

// ---------------------------------------------------------------------------
// Счета
// ---------------------------------------------------------------------------

export async function createCashAccountAction(
  _prev: TreasuryFormState,
  form: FormData,
): Promise<TreasuryFormState> {
  const dto: CreateCashAccountDto = {
    kind: str(form, 'kind') as CreateCashAccountDto['kind'],
    name: str(form, 'name'),
    currency: optStr(form, 'currency') ?? 'RUB',
    comment: optStr(form, 'comment') ?? null,
  };
  const parsed = CreateCashAccountSchema.safeParse(dto);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Невалидные данные' };
  }
  try {
    await createCashAccount(parsed.data);
    revalidatePath('/admin/treasury/accounts');
    revalidatePath('/admin/treasury');
    return { ok: true, successMessage: 'Счёт создан.' };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}

export async function toggleCashAccountActiveAction(
  accountId: string,
  isActive: boolean,
  _prev: TreasuryFormState,
  _form: FormData,
): Promise<TreasuryFormState> {
  const parsed = UpdateCashAccountSchema.safeParse({ isActive });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Невалидные данные' };
  }
  try {
    await updateCashAccount(accountId, parsed.data);
    revalidatePath('/admin/treasury/accounts');
    revalidatePath('/admin/treasury');
    return {
      ok: true,
      successMessage: isActive ? 'Счёт активирован.' : 'Счёт скрыт.',
    };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}

// ---------------------------------------------------------------------------
// Статьи ДДС
// ---------------------------------------------------------------------------

export async function createCashFlowItemAction(
  _prev: TreasuryFormState,
  form: FormData,
): Promise<TreasuryFormState> {
  const dirRaw = optStr(form, 'direction');
  const dto: CreateCashFlowItemDto = {
    name: str(form, 'name'),
    code: optStr(form, 'code') ?? null,
    direction: (dirRaw ?? null) as CreateCashFlowItemDto['direction'],
    isOverhead: form.get('isOverhead') === 'on',
    comment: optStr(form, 'comment') ?? null,
  };
  const parsed = CreateCashFlowItemSchema.safeParse(dto);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Невалидные данные' };
  }
  try {
    await createCashFlowItem(parsed.data);
    revalidatePath('/admin/treasury/items');
    revalidatePath('/admin/treasury');
    return { ok: true, successMessage: 'Статья создана.' };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}

export async function toggleCashFlowItemActiveAction(
  itemId: string,
  isActive: boolean,
  _prev: TreasuryFormState,
  _form: FormData,
): Promise<TreasuryFormState> {
  const parsed = UpdateCashFlowItemSchema.safeParse({ isActive });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Невалидные данные' };
  }
  try {
    await updateCashFlowItem(itemId, parsed.data);
    revalidatePath('/admin/treasury/items');
    revalidatePath('/admin/treasury');
    return {
      ok: true,
      successMessage: isActive ? 'Статья активирована.' : 'Статья скрыта.',
    };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}

// ---------------------------------------------------------------------------
// Оплаты поставщикам (Фаза 1)
// ---------------------------------------------------------------------------

export async function createSupplierPaymentAction(
  _prev: TreasuryFormState,
  form: FormData,
): Promise<TreasuryFormState> {
  const dto: CreateSupplierPaymentDto = {
    supplierId: str(form, 'supplierId'),
    purchaseOrderId: optStr(form, 'purchaseOrderId') ?? null,
    accountId: str(form, 'accountId'),
    itemId: str(form, 'itemId'),
    amount: str(form, 'amount'),
    comment: optStr(form, 'comment') ?? null,
  };
  const parsed = CreateSupplierPaymentSchema.safeParse(dto);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Невалидные данные' };
  }
  try {
    await createSupplierPayment(parsed.data);
    revalidatePath('/admin/treasury/payments');
    revalidatePath('/admin/treasury');
    return { ok: true, successMessage: 'Заявка на расход создана.' };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}

export async function approveSupplierPaymentAction(
  paymentId: string,
  _prev: TreasuryFormState,
  _form: FormData,
): Promise<TreasuryFormState> {
  try {
    await approveSupplierPayment(paymentId);
    revalidatePath('/admin/treasury/payments');
    return { ok: true, successMessage: 'Заявка согласована.' };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}

export async function paySupplierPaymentAction(
  paymentId: string,
  _prev: TreasuryFormState,
  _form: FormData,
): Promise<TreasuryFormState> {
  try {
    await paySupplierPayment(paymentId);
    revalidatePath('/admin/treasury/payments');
    revalidatePath('/admin/treasury');
    return { ok: true, successMessage: 'Оплата проведена.' };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}

export async function cancelSupplierPaymentAction(
  paymentId: string,
  _prev: TreasuryFormState,
  form: FormData,
): Promise<TreasuryFormState> {
  const parsed = CancelSupplierPaymentSchema.safeParse({
    reason: optStr(form, 'reason'),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Невалидные данные' };
  }
  try {
    await cancelSupplierPayment(paymentId, parsed.data);
    revalidatePath('/admin/treasury/payments');
    return { ok: true, successMessage: 'Заявка отменена.' };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}

// ---------------------------------------------------------------------------
// Настройки модуля (Фаза 1)
// ---------------------------------------------------------------------------

export async function updateTreasurySettingsAction(
  _prev: TreasuryFormState,
  form: FormData,
): Promise<TreasuryFormState> {
  const parsed = UpdateTreasurySettingsSchema.safeParse({
    salaryAccountId: optStr(form, 'salaryAccountId') ?? null,
    salaryItemId: optStr(form, 'salaryItemId') ?? null,
    supplierAccountId: optStr(form, 'supplierAccountId') ?? null,
    supplierItemId: optStr(form, 'supplierItemId') ?? null,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Невалидные данные' };
  }
  try {
    await updateTreasurySettings(parsed.data);
    revalidatePath('/admin/treasury/settings');
    return { ok: true, successMessage: 'Настройки сохранены.' };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}
