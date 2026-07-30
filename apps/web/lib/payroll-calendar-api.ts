/**
 * Серверные обёртки над `/api/payroll-calendar` — производственный
 * календарь (норма рабочих дней и часов на месяц, 29.07.2026).
 *
 * Норма нужна месячному окладу: через `оклад ÷ нормаЧасов` считается
 * ставка ₽/час, по которой месячнику начисляется доплата за подкрой и
 * разносится оклад на себестоимость. Контракт — `docs/api.md §31a`.
 *
 * Все функции рассчитаны на использование из RSC / server actions.
 */

import type {
  PayrollCalendarMonthDto,
  UpsertPayrollCalendarMonthDto,
} from '@sewing/shared/payroll-calendar';
import { apiFetch } from './api';

export function listPayrollCalendar(
  year?: number,
): Promise<PayrollCalendarMonthDto[]> {
  return apiFetch<PayrollCalendarMonthDto[]>('/payroll-calendar', {
    searchParams: { year },
  });
}

/**
 * Календарь — вспомогательный справочник, и его отсутствие не должно
 * ронять страницу целиком. Для экранов, где он лишь одна из секций,
 * отдаём пустой список вместо исключения.
 */
export async function listPayrollCalendarSafe(
  year?: number,
): Promise<PayrollCalendarMonthDto[]> {
  try {
    return await listPayrollCalendar(year);
  } catch {
    return [];
  }
}

export function upsertPayrollCalendarMonth(
  body: UpsertPayrollCalendarMonthDto,
): Promise<PayrollCalendarMonthDto> {
  return apiFetch<PayrollCalendarMonthDto>('/payroll-calendar', {
    method: 'PUT',
    body,
  });
}

export function deletePayrollCalendarMonth(
  year: number,
  month: number,
): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>(`/payroll-calendar/${year}/${month}`, {
    method: 'DELETE',
  });
}
