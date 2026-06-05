'use client';

/**
 * Кнопки переходов статуса PO (`/send`, `/confirm`, `/cancel`).
 *
 * Кнопки гасятся в зависимости от текущего статуса:
 *   - DRAFT     → видны «Отправить», «Подтвердить», «Отменить»;
 *   - SENT      → видны «Подтвердить», «Отменить»;
 *   - CONFIRMED → видна «Отменить»;
 *   - CANCELLED → ничего нет.
 *
 * Каждое действие — отдельный `<form action={...}>` со своим
 * `useFormState`, чтобы UI мог показать частичный результат
 * (success/error) для конкретной кнопки без интерференции
 * остальных. Backend под капотом валидирует валидность перехода
 * через `PurchaseOrderInvalidStatusTransitionException`.
 */

import { useFormState, useFormStatus } from 'react-dom';
import { CheckCircle, RotateCcw, Send, XCircle } from 'lucide-react';
import type { PurchaseOrderDetailDto } from '@sewing/shared/purchase-orders';
import {
  cancelPurchaseOrderAction,
  confirmPurchaseOrderAction,
  reopenPurchaseOrderAction,
  sendPurchaseOrderAction,
} from '../actions';
import { initialPurchaseOrderActionState } from '../form-state';

function ActionButton({
  pendingLabel,
  label,
  className = 'admin-btn',
  icon,
}: {
  pendingLabel: string;
  label: string;
  className?: string;
  icon?: React.ReactNode;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending}>
      {icon}
      {pending ? pendingLabel : label}
    </button>
  );
}

export function PurchaseOrderActionsBar({
  po,
}: {
  po: PurchaseOrderDetailDto;
}) {
  const [sendState, sendAction] = useFormState(
    sendPurchaseOrderAction.bind(null, po.id),
    initialPurchaseOrderActionState,
  );
  const [confirmState, confirmAction] = useFormState(
    confirmPurchaseOrderAction.bind(null, po.id),
    initialPurchaseOrderActionState,
  );
  const [reopenState, reopenAction] = useFormState(
    reopenPurchaseOrderAction.bind(null, po.id),
    initialPurchaseOrderActionState,
  );
  const [cancelState, cancelAction] = useFormState(
    cancelPurchaseOrderAction.bind(null, po.id),
    initialPurchaseOrderActionState,
  );

  const canSend = po.status === 'DRAFT';
  const canConfirm = po.status === 'DRAFT' || po.status === 'SENT';
  // Откат «на шаг назад» доступен из SENT/CONFIRMED, пока по заказу
  // нет проведённых приёмок (backend это перепроверяет и отдаёт
  // PURCHASE_ORDER_HAS_RECEIPTS, если приёмки уже есть).
  const canReopen = po.status === 'SENT' || po.status === 'CONFIRMED';
  const reopenLabel =
    po.status === 'CONFIRMED' ? 'Снять подтверждение' : 'Вернуть в черновик';
  const canCancel = po.status !== 'CANCELLED';

  const messages = [
    sendState.successMessage,
    confirmState.successMessage,
    reopenState.successMessage,
    cancelState.successMessage,
  ].filter((m): m is string => !!m);
  const errors = [
    sendState.error,
    confirmState.error,
    reopenState.error,
    cancelState.error,
  ].filter((e): e is string => !!e);

  return (
    <>
      <div
        className="admin-actions-row"
        style={{ flexWrap: 'wrap', gap: 8 }}
      >
        {canSend && (
          <form action={sendAction} style={{ display: 'inline-flex' }}>
            <ActionButton
              label="Отправить поставщику"
              pendingLabel="Отправляем…"
              className="admin-btn admin-btn--primary"
              icon={<Send size={16} strokeWidth={1.6} aria-hidden />}
            />
          </form>
        )}
        {canConfirm && (
          <form action={confirmAction} style={{ display: 'inline-flex' }}>
            <ActionButton
              label="Подтвердить"
              pendingLabel="Подтверждаем…"
              className="admin-btn"
              icon={<CheckCircle size={16} strokeWidth={1.6} aria-hidden />}
            />
          </form>
        )}
        {canReopen && (
          <form action={reopenAction} style={{ display: 'inline-flex' }}>
            <ActionButton
              label={reopenLabel}
              pendingLabel="Откатываем…"
              className="admin-btn admin-btn--ghost"
              icon={<RotateCcw size={16} strokeWidth={1.6} aria-hidden />}
            />
          </form>
        )}
        {canCancel && (
          <form action={cancelAction} style={{ display: 'inline-flex' }}>
            <ActionButton
              label="Отменить"
              pendingLabel="Отменяем…"
              className="admin-btn"
              icon={<XCircle size={16} strokeWidth={1.6} aria-hidden />}
            />
          </form>
        )}
        {!canSend && !canConfirm && !canReopen && !canCancel && (
          <span className="admin-muted">Заказ закрыт.</span>
        )}
      </div>

      {errors.length > 0 && (
        <div className="error-box" role="alert" style={{ marginTop: 12 }}>
          {errors.join('; ')}
        </div>
      )}
      {messages.length > 0 && (
        <div className="success-box" role="status" style={{ marginTop: 12 }}>
          {messages.join('; ')}
        </div>
      )}
    </>
  );
}
