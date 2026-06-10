'use server';

/**
 * Server actions блока «Поставщики» (Этап 5).
 *
 * RBAC — на backend (`@Roles('ADMIN', 'SHOP_MANAGER')` в
 * `SuppliersController`). Frontend дополнительно прячет навигацию
 * через `NEXT_PUBLIC_FEATURE_SUPPLIERS=1`.
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  CreateSupplierCatalogItemSchema,
  CreateSupplierContactSchema,
  CreateSupplierSchema,
  UpdateSupplierCatalogItemSchema,
  UpdateSupplierContactSchema,
  UpdateSupplierSchema,
  type CreateSupplierCatalogItemDto,
  type CreateSupplierContactDto,
  type CreateSupplierDto,
  type UpdateSupplierCatalogItemDto,
  type UpdateSupplierContactDto,
  type UpdateSupplierDto,
} from '@sewing/shared/suppliers';
import { ApiRequestError, errorText } from '@/lib/api';
import {
  archiveSupplierCatalogItem,
  createSupplier,
  createSupplierCatalogItem,
  createSupplierContact,
  deleteSupplierContact,
  updateSupplier,
  updateSupplierCatalogItem,
  updateSupplierContact,
} from '@/lib/suppliers-api';
import type {
  CreateSupplierState,
  SupplierCatalogItemFormState,
  SupplierContactFormState,
  UpdateSupplierState,
} from './form-state';

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
// Suppliers
// ---------------------------------------------------------------------------

function buildCreateSupplierDto(form: FormData): CreateSupplierDto {
  return {
    name: String(form.get('name') ?? '').trim(),
    phone: form.get('phone') === null ? undefined : String(form.get('phone') ?? ''),
    website:
      form.get('website') === null ? undefined : String(form.get('website') ?? ''),
    address:
      form.get('address') === null ? undefined : String(form.get('address') ?? ''),
    comment:
      form.get('comment') === null ? undefined : String(form.get('comment') ?? ''),
  };
}

function buildUpdateSupplierDto(form: FormData): UpdateSupplierDto {
  const dto: UpdateSupplierDto = {};
  if (form.get('name') !== null) {
    dto.name = String(form.get('name') ?? '').trim();
  }
  if (form.get('phone') !== null) dto.phone = String(form.get('phone') ?? '');
  if (form.get('website') !== null) dto.website = String(form.get('website') ?? '');
  if (form.get('address') !== null) dto.address = String(form.get('address') ?? '');
  if (form.get('comment') !== null) dto.comment = String(form.get('comment') ?? '');
  if (form.get('status') !== null) {
    dto.status = String(form.get('status') ?? '').trim() as
      | 'ACTIVE'
      | 'INACTIVE';
  }
  return dto;
}

export async function createSupplierAction(
  _prev: CreateSupplierState,
  form: FormData,
): Promise<CreateSupplierState> {
  const parsed = CreateSupplierSchema.safeParse(buildCreateSupplierDto(form));
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
    };
  }
  let createdId: string | null = null;
  try {
    const created = await createSupplier(parsed.data);
    createdId = created.id;
    revalidatePath('/admin/suppliers');
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
  if (createdId) redirect(`/admin/suppliers/${createdId}`);
  return { ok: true };
}

export async function updateSupplierAction(
  supplierId: string,
  _prev: UpdateSupplierState,
  form: FormData,
): Promise<UpdateSupplierState> {
  const parsed = UpdateSupplierSchema.safeParse(buildUpdateSupplierDto(form));
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
    };
  }
  try {
    await updateSupplier(supplierId, parsed.data);
    revalidatePath('/admin/suppliers');
    revalidatePath(`/admin/suppliers/${supplierId}`);
    return { ok: true, successMessage: 'Сохранено.' };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

function buildCreateContactDto(form: FormData): CreateSupplierContactDto {
  return {
    name: String(form.get('name') ?? '').trim(),
    position:
      form.get('position') === null ? undefined : String(form.get('position') ?? ''),
    phone: form.get('phone') === null ? undefined : String(form.get('phone') ?? ''),
    email: form.get('email') === null ? undefined : String(form.get('email') ?? ''),
    messenger:
      form.get('messenger') === null
        ? undefined
        : String(form.get('messenger') ?? ''),
    isPrimary: form.get('isPrimary') === 'on',
    comment:
      form.get('comment') === null ? undefined : String(form.get('comment') ?? ''),
  };
}

function buildUpdateContactDto(form: FormData): UpdateSupplierContactDto {
  const dto: UpdateSupplierContactDto = {};
  if (form.get('name') !== null) dto.name = String(form.get('name') ?? '').trim();
  if (form.get('position') !== null) {
    dto.position = String(form.get('position') ?? '');
  }
  if (form.get('phone') !== null) dto.phone = String(form.get('phone') ?? '');
  if (form.get('email') !== null) dto.email = String(form.get('email') ?? '');
  if (form.get('messenger') !== null) {
    dto.messenger = String(form.get('messenger') ?? '');
  }
  // isPrimary всегда передаём (флаг чекбокса либо `on`, либо вообще нет
  // в FormData) — иначе нельзя «снять» галочку.
  dto.isPrimary = form.get('isPrimary') === 'on';
  if (form.get('comment') !== null) dto.comment = String(form.get('comment') ?? '');
  return dto;
}

export async function createSupplierContactAction(
  supplierId: string,
  _prev: SupplierContactFormState,
  form: FormData,
): Promise<SupplierContactFormState> {
  const parsed = CreateSupplierContactSchema.safeParse(
    buildCreateContactDto(form),
  );
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
    };
  }
  try {
    await createSupplierContact(supplierId, parsed.data);
    revalidatePath(`/admin/suppliers/${supplierId}`);
    return { ok: true, successMessage: 'Контакт добавлен.' };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}

export async function updateSupplierContactAction(
  supplierId: string,
  contactId: string,
  _prev: SupplierContactFormState,
  form: FormData,
): Promise<SupplierContactFormState> {
  const parsed = UpdateSupplierContactSchema.safeParse(
    buildUpdateContactDto(form),
  );
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
    };
  }
  try {
    await updateSupplierContact(supplierId, contactId, parsed.data);
    revalidatePath(`/admin/suppliers/${supplierId}`);
    return { ok: true, successMessage: 'Сохранено.' };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}

export async function deleteSupplierContactAction(
  supplierId: string,
  contactId: string,
  _prev: SupplierContactFormState,
  _form: FormData,
): Promise<SupplierContactFormState> {
  try {
    await deleteSupplierContact(supplierId, contactId);
    revalidatePath(`/admin/suppliers/${supplierId}`);
    return { ok: true, successMessage: 'Контакт удалён.' };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}

// ---------------------------------------------------------------------------
// Catalog items
// ---------------------------------------------------------------------------

function buildCreateCatalogItemDto(
  form: FormData,
): CreateSupplierCatalogItemDto {
  return {
    name: String(form.get('name') ?? '').trim(),
    supplierArticle:
      form.get('supplierArticle') === null
        ? undefined
        : String(form.get('supplierArticle') ?? ''),
    category:
      form.get('category') === null
        ? undefined
        : String(form.get('category') ?? ''),
    fabricType:
      form.get('fabricType') === null
        ? undefined
        : String(form.get('fabricType') ?? ''),
    densityGsm:
      form.get('densityGsm') === null
        ? undefined
        : (() => {
            const v = String(form.get('densityGsm') ?? '').trim();
            return v === '' ? null : (v as unknown as number);
          })(),
    colorText:
      form.get('colorText') === null
        ? undefined
        : String(form.get('colorText') ?? ''),
    unit: String(form.get('unit') ?? '').trim(),
    lastPrice:
      form.get('lastPrice') === null
        ? undefined
        : (() => {
            const v = String(form.get('lastPrice') ?? '').trim();
            return v === '' ? null : v;
          })(),
    currency:
      form.get('currency') === null
        ? undefined
        : String(form.get('currency') ?? ''),
    minOrderQty:
      form.get('minOrderQty') === null
        ? undefined
        : (() => {
            const v = String(form.get('minOrderQty') ?? '').trim();
            return v === '' ? null : v;
          })(),
    deliveryDays:
      form.get('deliveryDays') === null
        ? undefined
        : (() => {
            const v = String(form.get('deliveryDays') ?? '').trim();
            return v === '' ? null : (v as unknown as number);
          })(),
    comment:
      form.get('comment') === null
        ? undefined
        : String(form.get('comment') ?? ''),
  };
}

function buildUpdateCatalogItemDto(
  form: FormData,
): UpdateSupplierCatalogItemDto {
  const dto: UpdateSupplierCatalogItemDto = {};
  if (form.get('name') !== null) dto.name = String(form.get('name') ?? '').trim();
  if (form.get('supplierArticle') !== null) {
    dto.supplierArticle = String(form.get('supplierArticle') ?? '');
  }
  if (form.get('category') !== null) {
    dto.category = String(form.get('category') ?? '');
  }
  if (form.get('fabricType') !== null) {
    dto.fabricType = String(form.get('fabricType') ?? '');
  }
  if (form.get('densityGsm') !== null) {
    const v = String(form.get('densityGsm') ?? '').trim();
    dto.densityGsm = v === '' ? null : (v as unknown as number);
  }
  if (form.get('colorText') !== null) {
    dto.colorText = String(form.get('colorText') ?? '');
  }
  if (form.get('unit') !== null) dto.unit = String(form.get('unit') ?? '').trim();
  if (form.get('lastPrice') !== null) {
    const v = String(form.get('lastPrice') ?? '').trim();
    dto.lastPrice = v === '' ? null : v;
  }
  if (form.get('currency') !== null) {
    dto.currency = String(form.get('currency') ?? '');
  }
  if (form.get('minOrderQty') !== null) {
    const v = String(form.get('minOrderQty') ?? '').trim();
    dto.minOrderQty = v === '' ? null : v;
  }
  if (form.get('deliveryDays') !== null) {
    const v = String(form.get('deliveryDays') ?? '').trim();
    dto.deliveryDays = v === '' ? null : (v as unknown as number);
  }
  if (form.get('comment') !== null) {
    dto.comment = String(form.get('comment') ?? '');
  }
  if (form.get('status') !== null) {
    dto.status = String(form.get('status') ?? '').trim() as
      | 'ACTIVE'
      | 'INACTIVE';
  }
  return dto;
}

export async function createSupplierCatalogItemAction(
  supplierId: string,
  _prev: SupplierCatalogItemFormState,
  form: FormData,
): Promise<SupplierCatalogItemFormState> {
  const parsed = CreateSupplierCatalogItemSchema.safeParse(
    buildCreateCatalogItemDto(form),
  );
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
    };
  }
  try {
    await createSupplierCatalogItem(supplierId, parsed.data);
    revalidatePath(`/admin/suppliers/${supplierId}`);
    return { ok: true, successMessage: 'Позиция добавлена.' };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}

export async function updateSupplierCatalogItemAction(
  supplierId: string,
  itemId: string,
  _prev: SupplierCatalogItemFormState,
  form: FormData,
): Promise<SupplierCatalogItemFormState> {
  const parsed = UpdateSupplierCatalogItemSchema.safeParse(
    buildUpdateCatalogItemDto(form),
  );
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
    };
  }
  try {
    await updateSupplierCatalogItem(supplierId, itemId, parsed.data);
    revalidatePath(`/admin/suppliers/${supplierId}`);
    return { ok: true, successMessage: 'Сохранено.' };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}

export async function archiveSupplierCatalogItemAction(
  supplierId: string,
  itemId: string,
  _prev: SupplierCatalogItemFormState,
  _form: FormData,
): Promise<SupplierCatalogItemFormState> {
  try {
    await archiveSupplierCatalogItem(supplierId, itemId);
    revalidatePath(`/admin/suppliers/${supplierId}`);
    return { ok: true, successMessage: 'Архивировано.' };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}
