'use server';

/**
 * Server actions модуля «PayrollPayout» для сотрудника (PHASE 3 STEP 5).
 *
 * Единственное действие сотрудника — подтверждение получения выплаты (ACK).
 * Backend проверяет, что текущая сессия принадлежит сотруднику-получателю.
 * Никаких cancel / issue / recompute здесь нет — только ACK.
 */

import { revalidatePath } from 'next/cache';
import { ApiRequestError, errorText } from '@/lib/api';
import { acknowledgePayrollPayout } from '@/lib/payroll-payouts-api';

export interface AckPayoutState {
  ok?: boolean;
  error?: string;
}

const LIST_PATH = '/earnings/payouts';

function detailPath(id: string): string {
  return `/earnings/payouts/${id}`;
}

export async function acknowledgePayrollPayoutAction(
  id: string,
  _prev: AckPayoutState,
  _form: FormData,
): Promise<AckPayoutState> {
  try {
    await acknowledgePayrollPayout(id);
    revalidatePath(LIST_PATH);
    revalidatePath(detailPath(id));
    return { ok: true };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return {
        error: errorText(e),
      };
    }
    return { error: 'Не удалось подтвердить получение' };
  }
}
