'use client';

/**
 * Inline-кнопка «Отменить отметку» для одной строки
 * `OrderMaterialArrivalOverride` (этап «Ручная отметка поступления
 * материала», см. `apps/api/src/modules/order-material-arrivals/*`).
 *
 * UX:
 *   - Сжатое состояние — маленькая кнопка-ссылка «Отменить отметку».
 *   - Развёрнутое — мини-форма с обязательной причиной (`reason`).
 *     Без причины кнопка submit заблокирована (Zod на сервере тоже
 *     требует `min(2)` — двойная защита).
 *   - После успеха — родительский RSC перерисуется через
 *     `revalidatePath` и эта кнопка исчезнет (override уйдёт из
 *     `manualArrivalOverrides`).
 */

import { useFormState, useFormStatus } from 'react-dom';
import { Undo2, XCircle } from 'lucide-react';
import { useState } from 'react';
import { revokeOrderMaterialArrivalOverrideAction } from '@/app/admin/orders/[id]/material-arrivals-actions';
import { initialOrderMaterialArrivalsFormState } from '@/app/admin/orders/[id]/material-arrivals-form-state';

interface Props {
  orderId: string;
  overrideId: string;
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--danger"
      disabled={pending}
      style={{ fontSize: '0.78rem', padding: '4px 8px' }}
    >
      {pending ? 'Отменяем…' : 'Отменить отметку'}
    </button>
  );
}

export function RevokeMaterialArrivalButton({ orderId, overrideId }: Props) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useFormState(
    revokeOrderMaterialArrivalOverrideAction.bind(null, orderId, overrideId),
    initialOrderMaterialArrivalsFormState,
  );

  if (!open) {
    return (
      <button
        type="button"
        className="admin-btn admin-btn--ghost"
        onClick={() => setOpen(true)}
        style={{ fontSize: '0.78rem', padding: '4px 8px' }}
      >
        <Undo2 size={12} strokeWidth={1.6} aria-hidden />
        Отменить отметку
      </button>
    );
  }

  return (
    <form
      action={formAction}
      style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
    >
      <label
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 3,
        }}
      >
        <span style={{ fontSize: '0.75rem', fontWeight: 500 }}>
          Причина отмены <span style={{ color: '#dc2626' }}>*</span>
        </span>
        <textarea
          name="reason"
          required
          minLength={2}
          rows={2}
          placeholder="Например: «нажали по ошибке»"
          style={{
            fontSize: '0.78rem',
            padding: '4px 6px',
            border: '1px solid var(--admin-border, #d4d4d8)',
            borderRadius: 4,
            fontFamily: 'inherit',
          }}
        />
        {state.fieldErrors?.reason && (
          <span style={{ fontSize: '0.7rem', color: '#dc2626' }}>
            {state.fieldErrors.reason}
          </span>
        )}
      </label>
      <div style={{ display: 'flex', gap: 4 }}>
        <SubmitButton />
        <button
          type="button"
          className="admin-btn admin-btn--ghost"
          onClick={() => setOpen(false)}
          style={{ fontSize: '0.78rem', padding: '4px 8px' }}
        >
          Закрыть
        </button>
      </div>
      {state.error && (
        <div className="error-box" role="alert">
          <XCircle size={12} strokeWidth={1.6} aria-hidden /> {state.error}
        </div>
      )}
    </form>
  );
}
