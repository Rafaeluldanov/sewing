'use client';

/**
 * Кнопка «Провести приёмку» (`DRAFT → POSTED`). На backend здесь же
 * проверяется лимит переприёмки, пересчитываются статусы PO/
 * потребности и пишутся складские движения.
 */

import { useFormState, useFormStatus } from 'react-dom';
import { ClipboardCheck } from 'lucide-react';
import { postPurchaseReceiptAction } from '../actions';
import { initialPostPurchaseReceiptState } from '../form-state';

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending}
      title="Провести черновик: количество отразится на складе, статусы заказа поставщику и потребности пересчитаются."
    >
      <ClipboardCheck size={16} strokeWidth={1.6} aria-hidden />
      {pending ? 'Проводим…' : 'Провести приёмку'}
    </button>
  );
}

export function PostPurchaseReceiptForm({ id }: { id: string }) {
  const [state, action] = useFormState(
    postPurchaseReceiptAction.bind(null, id),
    initialPostPurchaseReceiptState,
  );
  return (
    <form action={action} className="admin-stack">
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
