/**
 * Серверные обёртки над `/api/payroll/schedule` — расписание начисления
 * зарплаты: дни месяца, правило отсечки и предпросмотр «войдёт /
 * отложено».
 *
 * Все функции рассчитаны на RSC / server actions.
 */

import type {
  PayrollAccrualPreviewDto,
  PayrollAccrualScheduleDto,
  UpdatePayrollAccrualScheduleDto,
} from '@sewing/shared/payroll-schedule';
import { apiFetch } from './api';

export function getPayrollSchedule(): Promise<PayrollAccrualScheduleDto> {
  return apiFetch<PayrollAccrualScheduleDto>('/payroll/schedule');
}

/**
 * Расписание — вспомогательная настройка: на экранах, где оно лишь
 * подсказка (ведомость, форма документа), его отсутствие не должно
 * ронять страницу целиком.
 */
export async function getPayrollScheduleSafe(): Promise<PayrollAccrualScheduleDto | null> {
  try {
    return await getPayrollSchedule();
  } catch {
    return null;
  }
}

export function updatePayrollSchedule(
  body: UpdatePayrollAccrualScheduleDto,
): Promise<PayrollAccrualScheduleDto> {
  return apiFetch<PayrollAccrualScheduleDto>('/payroll/schedule', {
    method: 'PUT',
    body,
  });
}

export function getPayrollAccrualPreview(
  accrualDate?: string,
): Promise<PayrollAccrualPreviewDto> {
  return apiFetch<PayrollAccrualPreviewDto>('/payroll/schedule/preview', {
    searchParams: { accrualDate },
  });
}

export async function getPayrollAccrualPreviewSafe(
  accrualDate?: string,
): Promise<PayrollAccrualPreviewDto | null> {
  try {
    return await getPayrollAccrualPreview(accrualDate);
  } catch {
    return null;
  }
}

/**
 * Ленивый триггер автосоздания черновика — дёргается экраном зарплаты
 * при заходе. Ошибку глотаем: не создали черновик автоматически —
 * менеджер сформирует руками, ронять ведомость из-за этого нельзя.
 */
export async function runDuePayrollAccrual(): Promise<string | null> {
  try {
    const res = await apiFetch<{ documentId: string | null }>(
      '/payroll/schedule/run-due',
      { method: 'POST' },
    );
    return res.documentId;
  } catch {
    return null;
  }
}
