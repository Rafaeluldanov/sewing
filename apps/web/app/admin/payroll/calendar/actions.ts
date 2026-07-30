'use server';

import { revalidatePath } from 'next/cache';
import { ApiRequestError, errorText } from '@/lib/api';
import {
  deletePayrollCalendarMonth,
  upsertPayrollCalendarMonth,
} from '@/lib/payroll-calendar-api';
import { MONTH_LABELS } from '@sewing/shared/payroll-calendar';
import type { PayrollCalendarState } from './form-state';

/**
 * Server actions производственного календаря
 * (`/admin/payroll/calendar`, см. `docs/api.md §31a`).
 *
 * RBAC — на backend (`@Roles('SHOP_MANAGER', 'ADMIN')`).
 *
 * ВАЖНО: файл с `'use server'` может экспортировать только
 * async-функции — тип состояния и его initial-значение живут в
 * `./form-state.ts`.
 */

/**
 * Сохранить нормы года ЦЕЛИКОМ: форма шлёт все 12 месяцев одной
 * пачкой, потому что менеджер заполняет календарь раз в год, а не по
 * месяцу. Пустая пара «дни + часы» = месяц не ведётся: строку либо
 * не создаём, либо удаляем существующую.
 *
 * Ошибки собираем по месяцам и возвращаем одним сообщением, а не
 * падаем на первой: иначе менеджер, опечатавшийся в феврале, узнавал
 * бы об августе только со второй попытки.
 */
export async function savePayrollCalendarYearAction(
  _prev: PayrollCalendarState,
  form: FormData,
): Promise<PayrollCalendarState> {
  const year = Number(String(form.get('year') ?? '').trim());
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return { error: 'Некорректный год' };
  }

  const problems: string[] = [];
  let saved = 0;
  let cleared = 0;

  for (let month = 1; month <= 12; month += 1) {
    const daysRaw = String(form.get(`normDays-${month}`) ?? '').trim();
    const hoursRaw = String(form.get(`normHours-${month}`) ?? '').trim();
    const comment = String(form.get(`comment-${month}`) ?? '').trim();
    const label = MONTH_LABELS[month - 1];

    if (daysRaw === '' && hoursRaw === '') {
      // Месяц не ведётся. Удаляем строку, если она была; если не
      // было — DELETE вернёт 404, и это не ошибка ввода.
      try {
        await deletePayrollCalendarMonth(year, month);
        cleared += 1;
      } catch (e) {
        if (!(e instanceof ApiRequestError && e.statusCode === 404)) {
          problems.push(`${label}: ${e instanceof ApiRequestError ? errorText(e) : 'не удалось очистить'}`);
        }
      }
      continue;
    }

    const normDays = Number(daysRaw.replace(',', '.'));
    const normHours = Number(hoursRaw.replace(',', '.'));
    if (!Number.isInteger(normDays) || normDays < 0 || normDays > 31) {
      problems.push(`${label}: норма дней — целое число 0…31`);
      continue;
    }
    if (!Number.isFinite(normHours) || normHours <= 0) {
      problems.push(`${label}: норма часов должна быть больше нуля`);
      continue;
    }

    try {
      await upsertPayrollCalendarMonth({
        year,
        month,
        normDays,
        normHours: Math.round(normHours * 100) / 100,
        comment: comment === '' ? null : comment,
      });
      saved += 1;
    } catch (e) {
      if (e instanceof ApiRequestError) {
        problems.push(`${label}: ${errorText(e)}`);
      } else {
        problems.push(`${label}: не удалось сохранить`);
      }
    }
  }

  revalidatePath('/admin/payroll/calendar');

  if (problems.length > 0) {
    return { error: problems.join('; ') };
  }
  return {
    ok: true,
    successMessage: `Сохранено месяцев: ${saved}${
      cleared > 0 ? `, очищено: ${cleared}` : ''
    }`,
  };
}
