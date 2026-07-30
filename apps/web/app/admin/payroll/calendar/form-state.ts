/**
 * Тип и initial state формы производственного календаря
 * (`/admin/payroll/calendar`).
 *
 * Вынесено из `./actions.ts`: файл с директивой `'use server'` может
 * экспортировать только async-функции, экспорт объекта оттуда роняет
 * страницу в рантайме (tsc/lint/build при этом молчат).
 */

export interface PayrollCalendarState {
  ok?: boolean;
  successMessage?: string;
  error?: string;
  errorRequestId?: string;
}

export const initialPayrollCalendarState: PayrollCalendarState = {};
