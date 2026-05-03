'use client';

/**
 * `CancelMaterialIssueButton` — inline-действие «Отменить» для строки
 * DRAFT-документа расхода в таблице `MaterialIssuesTable`.
 *
 * По UX повторяет существующий `RevokeMaterialArrivalButton`:
 *   - свёрнутое состояние — маленькая ghost-кнопка «Отменить»;
 *   - развёрнутое — inline-форма с опциональной причиной отмены
 *     (`reason`, max 2000 символов; backend принимает без reason
 *     тоже — для MVP этого достаточно).
 *   - После успеха родительский RSC перечитает список через
 *     `revalidatePath` — DRAFT-строка исчезнет, CANCELLED-строка
 *     появится без действий.
 */
import { useFormState, useFormStatus } from 'react-dom';
import { Undo2, XCircle } from 'lucide-react';
import { useState } from 'react';
import {
  cancelMaterialIssueAction,
  initialMaterialIssueFormState,
} from '@/app/admin/orders/[id]/material-issues-actions';

interface Props {
  orderId: string;
  id: string;
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
      {pending ? 'Отменяем…' : 'Отменить документ'}
    </button>
  );
}

export function CancelMaterialIssueButton({ orderId, id }: Props) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useFormState(
    cancelMaterialIssueAction.bind(null, orderId, id),
    initialMaterialIssueFormState,
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
        Отменить
      </button>
    );
  }

  return (
    <form
      action={formAction}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        minWidth: 220,
      }}
    >
      <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span style={{ fontSize: '0.75rem', fontWeight: 500 }}>
          Причина отмены (опционально)
        </span>
        <textarea
          name="reason"
          rows={2}
          maxLength={2000}
          placeholder="Например: «создано по ошибке»"
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
