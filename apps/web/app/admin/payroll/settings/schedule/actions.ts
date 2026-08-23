'use server';

/**
 * Server actions экрана «Правила начисления».
 *
 * RBAC — на backend (`@Roles('SHOP_MANAGER', 'ADMIN')`); админка
 * дополнительно скрывает раздел через `app/admin/layout.tsx`.
 */

import { revalidatePath } from 'next/cache';
import { UpdatePayrollAccrualScheduleSchema } from '@sewing/shared/payroll-schedule';
import { ApiRequestError, errorText } from '@/lib/api';
import { updatePayrollSchedule } from '@/lib/payroll-schedule-api';

export interface PayrollScheduleActionState {
  ok?: boolean;
  error?: string;
  errorRequestId?: string;
}

export async function savePayrollScheduleAction(
  _prev: PayrollScheduleActionState,
  form: FormData,
): Promise<PayrollScheduleActionState> {
  // Дни приходят строкой чипов («5, 15, 25»): такой ввод переживает и
  // копипасту из переписки, и добавление дня с телефона, в отличие от
  // мультиселекта на 31 пункт.
  const days = String(form.get('daysOfMonth') ?? '')
    .split(/[^\d]+/)
    .filter(Boolean)
    .map(Number)
    .filter((n) => n >= 1 && n <= 31);

  const parsed = UpdatePayrollAccrualScheduleSchema.safeParse({
    daysOfMonth: days,
    cutoffBasis: String(form.get('cutoffBasis') ?? 'ORDER_COMPLETED'),
    appliesToSewing: form.get('appliesToSewing') === 'on',
    appliesToCutting: form.get('appliesToCutting') === 'on',
    autoCreateDraft: form.get('autoCreateDraft') === 'on',
    runAtLocalTime: String(form.get('runAtLocalTime') ?? '03:00').trim(),
  });
  if (!parsed.success) {
    return { error: parsed.error.errors[0]?.message ?? 'Проверьте поля формы' };
  }

  try {
    await updatePayrollSchedule(parsed.data);
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return { error: errorText(e), errorRequestId: e.requestId };
    }
    return { error: 'Не удалось сохранить правила начисления' };
  }

  revalidatePath('/admin/payroll/settings/schedule');
  revalidatePath('/admin/payroll');
  revalidatePath('/admin/payroll/accrual-documents/new');
  return { ok: true };
}
