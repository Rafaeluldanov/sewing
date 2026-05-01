'use client';

import { useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import type { SalaryEntryDto } from '@sewing/shared/salary';
import {
  initialUpdateSalaryEntryState,
  updateSalaryEntryAction,
  type UpdateSalaryEntryState,
} from './actions';

/**
 * Inline-редактор окладной записи (см. `docs/screens.md §11a`).
 * Доступен только менеджеру — обычный сотрудник видит сумму read-only
 * (компонент в его UI просто не рендерится).
 *
 * UX:
 *   - две кнопки в строке: «Исправить» и (если запись уже исправлена)
 *     «Вернуть в авто»;
 *   - «Исправить» открывает форму с двумя полями: сумма и комментарий.
 *     После успешного PATCH компонент схлопывается обратно. Список
 *     обновляется через `revalidatePath('/earnings')` в action.
 *   - «Вернуть в авто» (`reset = true`) сразу шлёт PATCH без формы —
 *     это редкое действие, лишний шаг тут лишний.
 */
export function SalaryEntryEditor({ entry }: { entry: SalaryEntryDto }) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => setOpen(true)}
        >
          Исправить
        </button>
        {entry.editedManually && <ResetButton entryId={entry.id} />}
      </div>
    );
  }

  return <EditForm entry={entry} onClose={() => setOpen(false)} />;
}

function EditForm({
  entry,
  onClose,
}: {
  entry: SalaryEntryDto;
  onClose: () => void;
}) {
  const update = updateSalaryEntryAction.bind(null, entry.id);
  const [state, formAction] = useFormState<UpdateSalaryEntryState, FormData>(
    update,
    initialUpdateSalaryEntryState,
  );

  return (
    <form action={formAction} style={{ minWidth: 280 }}>
      <div className="form-row" style={{ gap: 6 }}>
        <input
          name="amount"
          type="text"
          inputMode="decimal"
          defaultValue={entry.amount.toFixed(2)}
          placeholder="Сумма, ₽"
          autoComplete="off"
          style={{ padding: '4px 8px', width: 110 }}
        />
        <input
          name="managerComment"
          type="text"
          defaultValue={entry.managerComment ?? ''}
          maxLength={500}
          placeholder="Комментарий"
          autoComplete="off"
          style={{ padding: '4px 8px', flex: 1 }}
        />
      </div>
      <div className="actions-row" style={{ marginTop: 6, gap: 6 }}>
        <SaveButton />
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Отмена
        </button>
      </div>
      {state.error && (
        <div
          className="error-box"
          role="alert"
          style={{ marginTop: 8, fontSize: '0.85em' }}
        >
          <div className="error-box__msg">{state.error}</div>
          {state.errorRequestId && (
            <div className="error-box__rid">
              req: <code>{state.errorRequestId}</code>
            </div>
          )}
        </div>
      )}
    </form>
  );
}

function ResetButton({ entryId }: { entryId: string }) {
  const action = updateSalaryEntryAction.bind(null, entryId);
  const [state, formAction] = useFormState<UpdateSalaryEntryState, FormData>(
    action,
    initialUpdateSalaryEntryState,
  );

  return (
    <form action={formAction} style={{ display: 'inline' }}>
      <input type="hidden" name="reset" value="1" />
      <ResetSubmit />
      {state.error && (
        <span
          className="meta-line"
          role="alert"
          style={{ marginLeft: 6, color: 'var(--danger, #b91c1c)' }}
        >
          {state.error}
        </span>
      )}
    </form>
  );
}

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      {pending ? 'Сохраняем…' : 'Сохранить'}
    </button>
  );
}

function ResetSubmit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="btn btn-ghost"
      disabled={pending}
      title="Сбросить ручную правку и вернуть автоматический расчёт по ставке"
    >
      {pending ? '…' : 'Вернуть в авто'}
    </button>
  );
}
