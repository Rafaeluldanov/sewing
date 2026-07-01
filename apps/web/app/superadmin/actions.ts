'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  AddDomainSchema,
  CreateTenantSchema,
  DeleteTenantSchema,
  SetModuleSchema,
  SetStatusSchema,
} from '@sewing/shared/superadmin';
import { ApiRequestError, errorText } from '@/lib/api';
import {
  addTenantDomain,
  createTenant,
  deleteTenant,
  removeTenantDomain,
  setTenantModule,
  setTenantStatus,
} from '@/lib/superadmin-api';
import type {
  AddDomainState,
  CreateTenantState,
  DeleteTenantState,
} from './form-state';

function revalidateTenant(id: string): void {
  revalidatePath('/superadmin');
  revalidatePath(`/superadmin/${id}`);
}

/** Тумблер модуля тенанта (plain server-action form). */
export async function setModuleAction(formData: FormData): Promise<void> {
  const id = String(formData.get('tenantId') ?? '');
  const parsed = SetModuleSchema.safeParse({
    moduleKey: String(formData.get('moduleKey') ?? ''),
    enabled: formData.get('enabled') === 'true',
  });
  if (!id || !parsed.success) return;
  try {
    await setTenantModule(id, parsed.data);
  } catch {
    /* ошибки тумблера не критичны — состояние перечитается ревалидацией */
  }
  revalidateTenant(id);
}

/** Suspend / activate тенанта. */
export async function setStatusAction(formData: FormData): Promise<void> {
  const id = String(formData.get('tenantId') ?? '');
  const parsed = SetStatusSchema.safeParse({
    status: String(formData.get('status') ?? ''),
  });
  if (!id || !parsed.success) return;
  try {
    await setTenantStatus(id, parsed.data);
  } catch {
    /* перечитается ревалидацией */
  }
  revalidateTenant(id);
}

/** Удалить домен тенанта. */
export async function removeDomainAction(formData: FormData): Promise<void> {
  const id = String(formData.get('tenantId') ?? '');
  const domainId = String(formData.get('domainId') ?? '');
  if (!id || !domainId) return;
  try {
    await removeTenantDomain(id, domainId);
  } catch {
    /* перечитается ревалидацией */
  }
  revalidateTenant(id);
}

/** Добавить домен (client useFormState — показываем ошибку дубля). */
export async function addDomainAction(
  tenantId: string,
  _prev: AddDomainState,
  formData: FormData,
): Promise<AddDomainState> {
  const parsed = AddDomainSchema.safeParse({
    host: String(formData.get('host') ?? ''),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Некорректный домен' };
  }
  try {
    await addTenantDomain(tenantId, parsed.data);
    revalidateTenant(tenantId);
    return { ok: true };
  } catch (e) {
    return {
      error: e instanceof ApiRequestError ? errorText(e) : 'Не удалось добавить домен',
    };
  }
}

/**
 * НЕОБРАТИМОЕ удаление тенанта (client useFormState — показываем ошибку/лог).
 * bind по tenantId. При успехе — redirect на список (карточка исчезла).
 */
export async function deleteTenantAction(
  tenantId: string,
  _prev: DeleteTenantState,
  formData: FormData,
): Promise<DeleteTenantState> {
  const parsed = DeleteTenantSchema.safeParse({
    confirmSlug: String(formData.get('confirmSlug') ?? ''),
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? 'Введите slug для подтверждения',
    };
  }
  let result;
  try {
    result = await deleteTenant(tenantId, parsed.data);
  } catch (e) {
    return {
      error: e instanceof ApiRequestError ? errorText(e) : 'Не удалось удалить тенанта',
    };
  }
  if (!result.ok) {
    return { error: `Удаление не завершено для «${result.slug}».`, log: result.log };
  }
  revalidatePath('/superadmin');
  redirect('/superadmin');
}

/** Провижининг нового тенанта (client useFormState — показываем лог). */
export async function createTenantAction(
  _prev: CreateTenantState,
  formData: FormData,
): Promise<CreateTenantState> {
  const parsed = CreateTenantSchema.safeParse({
    slug: String(formData.get('slug') ?? ''),
    name: String(formData.get('name') ?? ''),
    dbName: String(formData.get('dbName') ?? ''),
    host: String(formData.get('host') ?? ''),
    adminLogin: String(formData.get('adminLogin') ?? '') || 'admin',
    adminPassword: String(formData.get('adminPassword') ?? ''),
    adminName: String(formData.get('adminName') ?? '') || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Проверьте поля формы' };
  }
  try {
    const res = await createTenant(parsed.data);
    revalidatePath('/superadmin');
    return res.ok
      ? { ok: true, successMessage: `Тенант «${res.slug}» создан.`, log: res.log }
      : { error: `Провижининг не удался для «${res.slug}».`, log: res.log };
  } catch (e) {
    return {
      error: e instanceof ApiRequestError ? errorText(e) : 'Не удалось создать тенанта',
    };
  }
}
