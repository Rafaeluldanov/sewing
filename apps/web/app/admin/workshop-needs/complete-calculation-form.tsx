'use client';

/**
 * Кнопка «Завершить расчёт» для группы заказа в `/admin/workshop-needs`
 * grouped view.
 *
 * Этап «Себестоимость заказа» (см.
 * `apps/api/src/modules/orders/orders.service.ts::completeCalculation`,
 * `apps/api/src/modules/orders/orders.controller.ts`,
 * `apps/web/app/orders/actions.ts::completeOrderCalculationAction`).
 *
 * Если в строках заказа есть USD — показываем дополнительный
 * инпут «Курс USD/RUB», без него backend отдаст 422
 * `ORDER_CALCULATION_USD_RATE_REQUIRED`. Курс не подтягивается из
 * сети — закупщик вводит руками.
 *
 * SaaS-итерация «Карточка заказа в view=orders»:
 *   `variant="compact"` укладывает форму одной горизонтальной
 *   полосой в `.workshop-order-group-card__actions` (header
 *   карточки заказа), без большого блока на всю ширину карточки.
 *   Для совместимости значение по умолчанию — `default` (старый
 *   стек label/input + кнопки), его никто кроме этой страницы
 *   не использует, но контракт прежний.
 */

import { useFormState, useFormStatus } from 'react-dom';
import { CheckCircle2, XCircle, Receipt } from 'lucide-react';
import {
  completeOrderCalculationAction,
  type CompleteCalculationActionState,
} from '@/app/orders/actions';

const initialState: CompleteCalculationActionState = {};

export type CompleteCalculationFormVariant = 'default' | 'compact';

function SubmitButton({
  disabled,
  variant,
}: {
  disabled?: boolean;
  variant: CompleteCalculationFormVariant;
}) {
  const { pending } = useFormStatus();
  const className =
    variant === 'compact'
      ? 'admin-btn admin-btn--primary workshop-need-complete-form__submit workshop-need-complete-form__submit--compact'
      : 'admin-btn admin-btn--primary workshop-need-complete-form__submit';
  return (
    <button
      type="submit"
      className={className}
      disabled={pending || disabled}
    >
      <Receipt size={14} strokeWidth={1.6} aria-hidden />
      {pending ? 'Завершаем…' : 'Завершить расчёт'}
    </button>
  );
}

export function CompleteCalculationForm({
  orderId,
  hasUsdLines,
  disabled,
  variant = 'default',
}: {
  orderId: string;
  hasUsdLines: boolean;
  disabled?: boolean;
  variant?: CompleteCalculationFormVariant;
}) {
  const [state, action] = useFormState(
    completeOrderCalculationAction.bind(null, orderId),
    initialState,
  );

  const formClassName =
    variant === 'compact'
      ? 'workshop-need-complete-form workshop-need-complete-form--compact'
      : 'workshop-need-complete-form';

  return (
    <form action={action} className={formClassName}>
      {hasUsdLines && (
        <div className="workshop-need-complete-form__field">
          <label htmlFor={`usd-${orderId}`}>Курс USD/RUB</label>
          <input
            id={`usd-${orderId}`}
            name="usdRateRub"
            type="text"
            inputMode="decimal"
            placeholder="например 95.50"
            required
            disabled={disabled}
          />
        </div>
      )}
      <div className="workshop-need-complete-form__actions">
        <SubmitButton disabled={disabled} variant={variant} />
      </div>
      {state.error && (
        <div
          className="error-box workshop-need-complete-form__alert"
          role="alert"
        >
          <XCircle size={14} strokeWidth={1.6} aria-hidden />
          <span>{state.error}</span>
        </div>
      )}
      {state.ok && (
        <div
          className="success-box workshop-need-complete-form__alert"
          role="status"
        >
          <CheckCircle2 size={14} strokeWidth={1.6} aria-hidden />
          <span>Расчёт завершён.</span>
        </div>
      )}
    </form>
  );
}
