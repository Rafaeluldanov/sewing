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
import type { SaveCuttingTaskProgressDto } from '@sewing/shared/cutting-tasks';

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
