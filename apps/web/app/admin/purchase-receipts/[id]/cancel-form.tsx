'use client';

/**
 * Кнопка / форма «Отменить приёмку» на карточке `PurchaseReceipt`.
 *
 * Простая inline-форма: поле «причина» (опционально) + красная
 * кнопка. Backend идемпотентен — повторная отмена не считается
 * ошибкой (вернёт `POSTED → CANCELLED → CANCELLED`).
 */

import { useFormState, useFormStatus } from 'react-dom';
import { XCircle } from 'lucide-react';
import { cancelPurchaseReceiptAction } from '../actions';
import { initialCancelPurchaseReceiptState } from '../form-state';

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn"
      disabled={pending}
      title="Отменить документ приёмки. Строки станут CANCELLED, статусы PO/потребности пересчитаются обратно."
    >
      <XCircle size={16} strokeWidth={1.6} aria-hidden />
      {pending ? 'Отменяем…' : 'Отменить приёмку'}
    </button>
  );
}

export function CancelPurchaseReceiptForm({ id }: { id: string }) {
  const [state, action] = useFormState(
    cancelPurchaseReceiptAction.bind(null, id),
    initialCancelPurchaseReceiptState,
  );
  return (
    <form action={action} className="admin-stack">
      <div className="admin-field">
        <label htmlFor={`cancelReason-${id}`}>Причина (опционально)</label>
        <input
          id={`cancelReason-${id}`}
          name="reason"
          type="text"
          maxLength={500}
          placeholder="Например: «прислали не ту партию»"
        />
      </div>
      <div className="admin-actions-row">
        <SubmitButton />
      </div>
      {state.error && (
        <div className="error-box" role="alert">
          {state.error}
          {state.errorRequestId ? ` [${state.errorRequestId}]` : ''}
        </div>
      )}
      {state.successMessage && (
        <div className="success-box" role="status">
          {state.successMessage}
        </div>
      )}
    </form>
  );
}
