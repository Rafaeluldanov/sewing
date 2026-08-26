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
  PayrollCutoffBasis,
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

/**
 * Несохранённое правило для предпросмотра: экран настроек считает
 * суммы по переключателю до нажатия «Сохранить». Не передано — сервер
 * берёт правило из настройки.
 */
export interface PayrollPreviewRuleOverride {
  cutoffBasis?: PayrollCutoffBasis;
  appliesToSewing?: boolean;
  appliesToCutting?: boolean;
}

/** Флаги уходят как `0`/`1`: пустая строка на бэке значила бы «не передано». */
function flag(v: boolean | undefined): string | undefined {
  return v === undefined ? undefined : v ? '1' : '0';
}

export function getPayrollAccrualPreview(
  accrualDate?: string,
  rule?: PayrollPreviewRuleOverride,
): Promise<PayrollAccrualPreviewDto> {
  return apiFetch<PayrollAccrualPreviewDto>('/payroll/schedule/preview', {
    searchParams: {
      accrualDate,
      cutoffBasis: rule?.cutoffBasis,
      appliesToSewing: flag(rule?.appliesToSewing),
      appliesToCutting: flag(rule?.appliesToCutting),
    },
  });
}

export async function getPayrollAccrualPreviewSafe(
  accrualDate?: string,
  rule?: PayrollPreviewRuleOverride,
): Promise<PayrollAccrualPreviewDto | null> {
  try {
    return await getPayrollAccrualPreview(accrualDate, rule);
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
