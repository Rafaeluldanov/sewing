'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { AlertCircle, Plus } from 'lucide-react';
import { createWarehouseAction } from './actions';
import {
  initialCreateWarehouseState,
  type CreateWarehouseState,
} from './form-state';

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending}
    >
      <Plus size={16} strokeWidth={1.6} aria-hidden />
      {pending ? 'Создаём…' : 'Создать склад'}
    </button>
  );
}

/**
 * Форма создания склада на `/admin/warehouses/new` (Admin UI 2.6).
 *
 * Backend / DTO не меняем. Минимум — название; код опционален и
 * попадает в QR-этикетку ячеек. Длинные пояснения убраны: важные
 * подсказки оставлены короткими.
 */
export function CreateWarehouseForm() {
  const [state, formAction] = useFormState<CreateWarehouseState, FormData>(
    createWarehouseAction,
    initialCreateWarehouseState,
  );

  return (
    <form action={formAction} className="admin-form">
      <div className="admin-form-grid">
        <div className="admin-field">
          <label htmlFor="warehouse-name">Название</label>
          <input
            id="warehouse-name"
            name="name"
            type="text"
            maxLength={120}
            placeholder="Основной склад"
            required
            autoComplete="off"
          />
        </div>

        <div className="admin-field">
          <label htmlFor="warehouse-code">Код (опционально)</label>
          <input
            id="warehouse-code"
            name="code"
            type="text"
            maxLength={32}
            placeholder="MAIN"
            autoComplete="off"
          />
        </div>
      </div>

      <div className="admin-actions-row">
        <SubmitButton />
      </div>

      {state.error && (
        <div className="error-box" role="alert">
          <div className="error-box__msg">
            <AlertCircle size={14} strokeWidth={1.6} aria-hidden /> {state.error}
          </div>
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
