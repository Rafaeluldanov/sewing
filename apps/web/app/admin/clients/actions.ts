'use server';

/**
 * Server actions блока «Клиенты».
 *
 * RBAC — на backend (`@Roles('SHOP_MANAGER', 'ADMIN')`). Frontend
 * дополнительно скрывает раздел через `app/admin/layout.tsx`.
 *
 * ВАЖНО: файл с `'use server'` может экспортировать только async-
 * функции, типы и initial state живут в `./form-state.ts`.
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  CreateClientSchema,
  UpdateClientSchema,
  type CreateClientDto,
  type UpdateClientDto,
} from '@sewing/shared/clients';
import { ApiRequestError } from '@/lib/api';
import { createClient, updateClient } from '@/lib/clients-api';
import type {
  CreateClientState,
  UpdateClientState,
} from './form-state';

function explainApiError(e: unknown): { error: string; requestId?: string } {
  if (e instanceof ApiRequestError) {
    return {
      error: `${e.message}${e.code ? ` (${e.code})` : ''}`,
      requestId: e.requestId,
    };
  }
  return { error: 'Не удалось выполнить запрос' };
}

function buildCreateDto(form: FormData): CreateClientDto {
  return {
    name: String(form.get('name') ?? '').trim(),
    phone: form.get('phone') === null ? undefined : String(form.get('phone') ?? ''),
    email: form.get('email') === null ? undefined : String(form.get('email') ?? ''),
    comment:
      form.get('comment') === null ? undefined : String(form.get('comment') ?? ''),
  };
}

function buildUpdateDto(form: FormData): UpdateClientDto {
  // Семантика идентична `buildUpdateDto` для заказов: поле есть в форме
  // → передаём (даже пустую строку, которая через preprocess превратится
  // в `null`); поля нет → undefined → backend не трогает.
  const dto: UpdateClientDto = {};
  if (form.get('name') !== null) {
    dto.name = String(form.get('name') ?? '').trim();
  }
  if (form.get('phone') !== null) dto.phone = String(form.get('phone') ?? '');
  if (form.get('email') !== null) dto.email = String(form.get('email') ?? '');
  if (form.get('comment') !== null) {
    dto.comment = String(form.get('comment') ?? '');
  }
  if (form.get('isActive') !== null) {
    dto.isActive = form.get('isActive') === 'on';
  }
  return dto;
}

export async function createClientAction(
  _prev: CreateClientState,
  form: FormData,
): Promise<CreateClientState> {
  const parsed = CreateClientSchema.safeParse(buildCreateDto(form));
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
    };
  }
  let createdId: string | null = null;
  try {
    const created = await createClient(parsed.data);
    createdId = created.id;
    revalidatePath('/admin/clients');
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
  if (createdId) {
    redirect(`/admin/clients/${createdId}`);
  }
  return { ok: true };
}

export async function updateClientAction(
  clientId: string,
  _prev: UpdateClientState,
  form: FormData,
): Promise<UpdateClientState> {
  const parsed = UpdateClientSchema.safeParse(buildUpdateDto(form));
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
    };
  }
  try {
    await updateClient(clientId, parsed.data);
    revalidatePath('/admin/clients');
    revalidatePath(`/admin/clients/${clientId}`);
    return { ok: true, successMessage: 'Сохранено.' };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}
