'use server';

/**
 * Server actions кабинета раскройщика (`apps/web/app/cutter/`).
 *
 * Бизнес-валидация и RBAC — на backend (`CuttingTasksController` +
 * `AuthGuard`). Здесь только: обернуть сетевую ошибку в стабильный
 * `{ ok, error }` и ревалидировать страницы кабинета после действия.
 */

import { revalidatePath } from 'next/cache';
import { ApiRequestError } from '@/lib/api';
import {
  completeCuttingTask,
  saveCuttingTaskProgress,
  startCuttingTask,
} from '@/lib/cutting-tasks-api';
import {
  cancelRecut,
  completeRecut,
  searchRecutOrders,
  startRecut,
} from '@/lib/recut-api';
import type { SaveCuttingTaskProgressDto } from '@sewing/shared/cutting-tasks';
import type {
  RecutOrderSearchItemDto,
  RecutSessionDto,
} from '@sewing/shared/recut';

export interface CutterActionResult {
  ok: boolean;
  error?: string;
}

function explainError(e: unknown, fallback: string): string {
  if (e instanceof ApiRequestError) return e.message || fallback;
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}

export async function startCuttingTaskAction(
  taskId: string,
): Promise<CutterActionResult> {
  if (!taskId || typeof taskId !== 'string') {
    return { ok: false, error: 'Неверный id задачи' };
  }
  try {
    await startCuttingTask(taskId);
    revalidatePath('/cutter');
    revalidatePath(`/cutter/${taskId}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: explainError(e, 'Не удалось принять задание') };
  }
}

export async function saveCuttingProgressAction(
  taskId: string,
  payload: SaveCuttingTaskProgressDto,
): Promise<CutterActionResult> {
  if (!taskId || typeof taskId !== 'string') {
    return { ok: false, error: 'Неверный id задачи' };
  }
  try {
    await saveCuttingTaskProgress(taskId, payload);
    revalidatePath(`/cutter/${taskId}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: explainError(e, 'Не удалось сохранить раскрой') };
  }
}

export async function completeCuttingTaskAction(
  taskId: string,
  payload: SaveCuttingTaskProgressDto,
): Promise<CutterActionResult> {
  if (!taskId || typeof taskId !== 'string') {
    return { ok: false, error: 'Неверный id задачи' };
  }
  try {
    await completeCuttingTask(taskId, payload);
    revalidatePath('/cutter');
    revalidatePath(`/cutter/${taskId}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: explainError(e, 'Не удалось завершить раскрой') };
  }
}

// ---------------------------------------------------------------------------
// Подкрой (`RecutSession`) — см. `apps/web/app/cutter/recut-panel.tsx`
// ---------------------------------------------------------------------------

export type RecutActionResult =
  | { ok: true; session: RecutSessionDto | null }
  | { ok: false; error: string };

/** Поиск заказа по номеру для запуска подкроя (вызывается из клиента). */
export async function searchRecutOrdersAction(
  q: string,
): Promise<RecutOrderSearchItemDto[]> {
  const term = (q ?? '').trim();
  if (term.length === 0) return [];
  try {
    return await searchRecutOrders(term);
  } catch {
    // Поиск — вспомогательный: сетевой сбой не должен ронять экран,
    // отдаём пустой список (пользователь повторит ввод).
    return [];
  }
}

/** «Начать подкрой» по выбранному заказу. */
export async function startRecutAction(
  orderId: string,
): Promise<RecutActionResult> {
  if (!orderId || typeof orderId !== 'string') {
    return { ok: false, error: 'Не выбран заказ' };
  }
  try {
    const session = await startRecut(orderId);
    revalidatePath('/cutter');
    return { ok: true, session };
  } catch (e) {
    return { ok: false, error: explainError(e, 'Не удалось начать подкрой') };
  }
}

/** «Завершить подкрой». */
export async function completeRecutAction(
  id: string,
): Promise<RecutActionResult> {
  if (!id || typeof id !== 'string') {
    return { ok: false, error: 'Неверный id подкроя' };
  }
  try {
    const session = await completeRecut(id);
    revalidatePath('/cutter');
    return { ok: true, session };
  } catch (e) {
    return { ok: false, error: explainError(e, 'Не удалось завершить подкрой') };
  }
}

/** «Отменить подкрой» (без оплаты). */
export async function cancelRecutAction(
  id: string,
): Promise<RecutActionResult> {
  if (!id || typeof id !== 'string') {
    return { ok: false, error: 'Неверный id подкроя' };
  }
  try {
    const session = await cancelRecut(id);
    revalidatePath('/cutter');
    return { ok: true, session };
  } catch (e) {
    return { ok: false, error: explainError(e, 'Не удалось отменить подкрой') };
  }
}
