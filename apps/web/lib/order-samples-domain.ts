/**
 * Domain-уровневые константы и типы для блока «Сигнальный образец».
 *
 * Вынесены из `apps/web/app/admin/orders/[id]/order-samples-actions.ts`:
 * Next.js App Router запрещает не-async exports из файла с `"use server"`
 * (runtime ошибка «A "use server" file can only export async functions,
 * found object»). Сюда собрано всё, что должно жить на client / RSC и в
 * server actions одновременно.
 *
 * Используется:
 *   - `apps/web/app/admin/orders/[id]/order-samples-actions.ts`
 *     (тип возврата actions);
 *   - `apps/web/components/orders/samples/order-samples-card.tsx`,
 *     `apps/web/components/orders/samples/start-order-sample-modal.tsx`
 *     (initial state для `useFormState`).
 */

export interface OrderSampleFormState {
  ok?: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
  successMessage?: string;
  createdId?: string;
}

export const initialOrderSampleFormState: OrderSampleFormState = {};
