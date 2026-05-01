'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ApiRequestError } from '@/lib/api';
import {
  createPrinter,
  createPrintJob,
  deletePrinter,
  generatePairingCode,
  updatePrinter,
} from '@/lib/printers-api';
import {
  PRINTER_TYPES,
  type PrinterType,
} from '@sewing/shared/printers';
import type {
  ActionState,
  CreatePrinterState,
  UpdatePrinterState,
} from './form-state';

function asString(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

function asPrinterType(form: FormData, key: string): PrinterType {
  const v = asString(form, key) as PrinterType;
  return (PRINTER_TYPES as readonly string[]).includes(v) ? v : 'DEFAULT';
}

export async function createPrinterAction(
  _prev: CreatePrinterState,
  form: FormData,
): Promise<CreatePrinterState> {
  const name = asString(form, 'name');
  const type = asPrinterType(form, 'type');
  const equipmentIdRaw = asString(form, 'equipmentId');
  const equipmentId = equipmentIdRaw.length > 0 ? equipmentIdRaw : null;

  if (!name) return { error: 'Имя принтера обязательно' };

  let createdId: string | null = null;
  try {
    const created = await createPrinter({ name, type, equipmentId });
    createdId = created.id;
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return {
        error: `${e.message}${e.code ? ` (${e.code})` : ''}`,
        errorRequestId: e.requestId,
      };
    }
    return { error: 'Не удалось создать принтер' };
  }
  revalidatePath('/admin/printers');
  if (createdId) redirect(`/admin/printers/${createdId}`);
  return { ok: true };
}

export async function updatePrinterAction(
  printerId: string,
  _prev: UpdatePrinterState,
  form: FormData,
): Promise<UpdatePrinterState> {
  const name = asString(form, 'name');
  const type = asPrinterType(form, 'type');
  const equipmentIdRaw = asString(form, 'equipmentId');
  const equipmentId = equipmentIdRaw.length > 0 ? equipmentIdRaw : null;
  const isActive = form.get('isActive') === 'on';

  try {
    await updatePrinter(printerId, {
      name: name || undefined,
      type,
      equipmentId,
      isActive,
    });
    revalidatePath('/admin/printers');
    revalidatePath(`/admin/printers/${printerId}`);
    return { ok: true };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return {
        error: `${e.message}${e.code ? ` (${e.code})` : ''}`,
        errorRequestId: e.requestId,
      };
    }
    return { error: 'Не удалось сохранить принтер' };
  }
}

/**
 * Сохранить выбор физического Windows-принтера для логического
 * принтера (см. `docs/domain.md §17b «Физический Windows-принтер»`).
 *
 * Если в форме передан пустой `selectedWindowsPrinter` — снимаем
 * выбор (передаём `null` в API). Backend валидирует, что значение
 * присутствует в `availableWindowsPrinters`, иначе вернёт
 * `WINDOWS_PRINTER_NOT_FOUND_FOR_AGENT`.
 */
export async function selectWindowsPrinterAction(
  printerId: string,
  _prev: UpdatePrinterState,
  form: FormData,
): Promise<UpdatePrinterState> {
  const raw = asString(form, 'selectedWindowsPrinter');
  const selectedWindowsPrinter = raw.length > 0 ? raw : null;

  try {
    await updatePrinter(printerId, { selectedWindowsPrinter });
    revalidatePath('/admin/printers');
    revalidatePath(`/admin/printers/${printerId}`);
    return { ok: true };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return {
        error: `${e.message}${e.code ? ` (${e.code})` : ''}`,
        errorRequestId: e.requestId,
      };
    }
    return { error: 'Не удалось сохранить выбор Windows-принтера' };
  }
}

export async function generatePairingCodeAction(
  printerId: string,
  _prev: ActionState,
  _form: FormData,
): Promise<ActionState> {
  try {
    await generatePairingCode(printerId);
    revalidatePath('/admin/printers');
    revalidatePath(`/admin/printers/${printerId}`);
    return { ok: true };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return {
        error: `${e.message}${e.code ? ` (${e.code})` : ''}`,
        errorRequestId: e.requestId,
      };
    }
    return { error: 'Не удалось сгенерировать код' };
  }
}

export async function testPrintAction(
  printerId: string,
  _prev: ActionState,
  _form: FormData,
): Promise<ActionState> {
  try {
    await createPrintJob({ printerId, sourceType: 'TEST' });
    revalidatePath(`/admin/printers/${printerId}`);
    return { ok: true };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return {
        error: `${e.message}${e.code ? ` (${e.code})` : ''}`,
        errorRequestId: e.requestId,
      };
    }
    return { error: 'Не удалось создать тестовое задание' };
  }
}

export async function deletePrinterAction(
  printerId: string,
  _prev: ActionState,
  _form: FormData,
): Promise<ActionState> {
  try {
    await deletePrinter(printerId);
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return {
        error: `${e.message}${e.code ? ` (${e.code})` : ''}`,
        errorRequestId: e.requestId,
      };
    }
    return { error: 'Не удалось удалить принтер' };
  }
  revalidatePath('/admin/printers');
  redirect('/admin/printers');
}
