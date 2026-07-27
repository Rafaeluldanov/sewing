'use client';

/**
 * `CancelFinishedGoodsShipmentButton` — кнопка «Отменить» рядом с
 * POSTED-shipment в таблице истории отгрузок (см.
 * `apps/web/components/orders/finished-goods/finished-goods-shipments-table.tsx`).
 *
 * Раскрывает inline-форму с textarea «Причина отмены» (тот же
 * паттерн, что у `CreateFinishedGoodsShipmentButton` /
 * `CreateMaterialIssueButton`). Submit идёт через server action
 * `cancelFinishedGoodsShipmentAction` (POST
 * `/api/finished-goods/shipments/:id/cancel`).
 *
 * После успеха блок отгрузок и доступные остатки готовой продукции
 * перерисовываются через `revalidatePath('/admin/orders/[id]')` —
 * исходная отгрузка остаётся в таблице со статусом «Отменена».
 */
import { useEffect, useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import { Ban, CheckCircle, XCircle } from 'lucide-react';
import { cancelFinishedGoodsShipmentAction } from '@/app/admin/orders/[id]/finished-goods-shipments-actions';
import { initialFinishedGoodsShipmentFormState } from '@/app/admin/orders/[id]/finished-goods-shipments-form-state';

interface Props {
  orderId: string;
  shipmentId: string;
  shipmentNumber: string;
}

function SubmitButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--danger"
      disabled={pending || disabled}
    >
      <CheckCircle size={16} strokeWidth={1.6} aria-hidden />
      {pending ? 'Отменяем…' : 'Отменить отгрузку'}
    </button>
  );
}

export function CancelFinishedGoodsShipmentButton({
  orderId,
  shipmentId,
  shipmentNumber,
}: Props) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [state, formAction] = useFormState(
    cancelFinishedGoodsShipmentAction.bind(null, orderId, shipmentId),
    initialFinishedGoodsShipmentFormState,
  );

  useEffect(() => {
    if (state.ok) {
      setOpen(false);
      setReason('');
    }
  }, [state.ok]);

  if (!open) {
    return (
      <button
        type="button"
        className="admin-btn admin-btn--ghost"
        onClick={() => setOpen(true)}
        data-testid="cancel-finished-goods-shipment-button"
        data-shipment-id={shipmentId}
      >
        <Ban size={14} strokeWidth={1.6} aria-hidden />
        Отменить
      </button>
    );
  }

  return (
    <form
      action={formAction}
      data-testid="cancel-finished-goods-shipment-dialog"
      data-shipment-id={shipmentId}
      style={{
        marginTop: 8,
        padding: 12,
        border: '1px solid var(--admin-border, #e5e7eb)',
        borderRadius: 6,
        background: 'var(--admin-card-bg, #fff)',
      }}
    >
      <div style={{ marginBottom: 8, fontWeight: 600 }}>
        Отмена отгрузки {shipmentNumber}
      </div>
      <p
        className="admin-muted"
        style={{ fontSize: '0.85rem', marginTop: 0, marginBottom: 8 }}
      >
        Отмена вернёт всю отгруженную готовую продукцию на склад.
        Исходная отгрузка останется в истории со статусом
        «Отменена». Частичная отмена не поддерживается — если нужно
        отгрузить меньше, отмените эту отгрузку и создайте новую
        корректную.
      </p>

      <div className="admin-field" style={{ marginBottom: 8 }}>
        <label htmlFor={`fgShipmentCancelReason-${shipmentId}`}>
          Причина отмены
        </label>
        <textarea
          id={`fgShipmentCancelReason-${shipmentId}`}
          name="reason"
          rows={2}
          minLength={2}
          maxLength={500}
          required
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Например, ошибочно отгрузили — клиент уточнил состав"
          style={{ width: '100%' }}
        />
      </div>

      {state.error && (
        <div
          role="alert"
          style={{
            color: 'var(--admin-danger-fg, #b91c1c)',
            fontSize: '0.88rem',
            marginBottom: 8,
          }}
        >
          <XCircle size={14} strokeWidth={1.6} aria-hidden /> {state.error}
        </div>
      )}

      <div className="admin-actions-row">
        <SubmitButton disabled={reason.trim().length < 2} />
        <button
          type="button"
          className="admin-btn admin-btn--ghost"
          onClick={() => {
            setOpen(false);
            setReason('');
          }}
        >
          Закрыть
        </button>
      </div>
    </form>
  );
}
