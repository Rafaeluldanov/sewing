'use client';

/**
 * Форма правки шапки PO (`/admin/purchase-orders/[id]`).
 *
 * Поля:
 *   - comment;
 *   - expectedDeliveryDate.
 *
 * Прямое управление статусом через PATCH сознательно НЕ выводим в
 * UI — для этого есть кнопки `Send`/`Confirm`/`Cancel`, которые
 * правильно проставляют timestamps и каскадят строки. Backend
 * соответствующее поле `status` всё равно валидирует через
 * `assertStatusTransition`, если кто-то пришлёт его руками.
 */

import { useFormState, useFormStatus } from 'react-dom';
import { CheckCircle, Save, XCircle } from 'lucide-react';
import type { PurchaseOrderDetailDto } from '@sewing/shared/purchase-orders';
import { updatePurchaseOrderAction } from '../actions';
import { initialUpdatePurchaseOrderState } from '../form-state';

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending}
    >
      <Save size={16} strokeWidth={1.6} aria-hidden />
      {pending ? 'Сохраняем…' : 'Сохранить'}
    </button>
  );
}

function isoToDateInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function EditPurchaseOrderForm({
  po,
}: {
  po: PurchaseOrderDetailDto;
}) {
  const [state, action] = useFormState(
    updatePurchaseOrderAction.bind(null, po.id),
    initialUpdatePurchaseOrderState,
  );

  return (
    <form action={action} className="admin-form">
      <div className="admin-form-grid">
        <div className="admin-field">
          <label htmlFor="po-eta">Ожидаемая дата</label>
          <input
            id="po-eta"
            name="expectedDeliveryDate"
            type="date"
            defaultValue={isoToDateInput(po.expectedDeliveryDate)}
          />
        </div>
        <div className="admin-field" style={{ gridColumn: 'span 2' }}>
          <label htmlFor="po-comment">Комментарий</label>
          <textarea
            id="po-comment"
            name="comment"
            rows={3}
            maxLength={2000}
            defaultValue={po.comment ?? ''}
          />
        </div>
      </div>

      {state.error && (
        <div className="error-box" role="alert">
          <XCircle size={16} strokeWidth={1.6} aria-hidden /> {state.error}
        </div>
      )}
      {state.ok && state.successMessage && (
        <div className="success-box" role="status">
          <CheckCircle size={16} strokeWidth={1.6} aria-hidden />{' '}
          {state.successMessage}
        </div>
      )}

      <div className="admin-actions-row">
        <SubmitButton />
      </div>
    </form>
  );
}
