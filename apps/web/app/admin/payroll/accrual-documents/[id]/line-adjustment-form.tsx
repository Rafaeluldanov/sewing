'use client';

/**
 * Клиентский компонент редактирования ручной корректировки строки
 * документа начисления (PHASE 3 STEP 6.3).
 *
 * Отображается только для документов со статусом DRAFT.
 * Принимает bound server action от родительского RSC.
 */

import { useFormState, useFormStatus } from 'react-dom';
import type { AccrualDocumentActionState } from '../actions';

type BoundLineAction = (
  prev: AccrualDocumentActionState,
  form: FormData,
) => Promise<AccrualDocumentActionState>;

const initial: AccrualDocumentActionState = {};

export function LineAdjustmentForm({
  lineId,
  initialAdjust,
  initialComment,
  updateAction,
}: {
  lineId: string;
  initialAdjust: number;
  initialComment: string | null;
  updateAction: BoundLineAction;
}) {
  const [state, formAction] = useFormState(updateAction, initial);

  return (
    <form
      action={formAction}
      style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end', flexWrap: 'wrap' }}
    >
      <input type="hidden" name="lineId" value={lineId} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
        <label
          htmlFor={`adj-${lineId}`}
          style={{ fontSize: '0.78rem', color: 'var(--admin-muted)' }}
        >
          Корректировка, ₽
        </label>
        <input
          id={`adj-${lineId}`}
          type="number"
          name="manualAdjustRub"
          step="0.01"
          defaultValue={initialAdjust}
          style={{ width: '120px' }}
        />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', flex: 1, minWidth: '160px' }}>
        <label
          htmlFor={`cmt-${lineId}`}
          style={{ fontSize: '0.78rem', color: 'var(--admin-muted)' }}
        >
          Комментарий
        </label>
        <input
          id={`cmt-${lineId}`}
          type="text"
          name="manualComment"
          defaultValue={initialComment ?? ''}
          placeholder="Необязательно"
        />
      </div>
      <SaveLineButton />
      {state.error && (
        <span
          className="error-box"
          role="alert"
          style={{ fontSize: '0.82rem', padding: '0.25rem 0.5rem' }}
        >
          {state.error}
        </span>
      )}
      {state.ok && (
        <span style={{ fontSize: '0.82rem', color: 'var(--admin-success, green)' }}>
          Сохранено
        </span>
      )}
    </form>
  );
}

function SaveLineButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="admin-btn admin-btn--sm" disabled={pending}>
      {pending ? '...' : 'Сохранить'}
    </button>
  );
}
