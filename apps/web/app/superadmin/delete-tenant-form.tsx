'use client';

import { useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import { deleteTenantAction } from './actions';
import { initialDeleteTenantState } from './form-state';

function DeleteButton({ armed }: { armed: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--danger"
      disabled={!armed || pending}
    >
      {pending ? 'Удаляю… (backup → DROP)' : 'Удалить тенанта навсегда'}
    </button>
  );
}

/**
 * Форма НЕОБРАТИМОГО удаления тенанта (danger-zone). Кнопка «армится» только
 * когда оператор ввёл точный slug — защита от случайного клика (как удаление
 * репозитория на GitHub). Бэкенд повторяет проверку (defense-in-depth).
 * Рендерится только для SUSPENDED-тенанта (условие — на стороне страницы).
 */
export function DeleteTenantForm({
  tenantId,
  slug,
}: {
  tenantId: string;
  slug: string;
}) {
  const [state, formAction] = useFormState(
    deleteTenantAction.bind(null, tenantId),
    initialDeleteTenantState,
  );
  const [confirm, setConfirm] = useState('');
  const armed = confirm.trim() === slug;

  return (
    <form action={formAction} className="admin-form admin-stack">
      <label className="admin-field">
        <span>
          Введите <code>{slug}</code> для подтверждения
        </span>
        <input
          name="confirmSlug"
          placeholder={slug}
          autoComplete="off"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </label>
      <DeleteButton armed={armed} />
      {state.error && (
        <div className="error-box" role="alert">
          {state.error}
        </div>
      )}
      {state.log && (
        <pre
          style={{
            maxHeight: 220,
            overflow: 'auto',
            background: '#0b1020',
            color: '#cdd6f4',
            padding: 12,
            borderRadius: 8,
            fontSize: 12,
            whiteSpace: 'pre-wrap',
          }}
        >
          {state.log}
        </pre>
      )}
    </form>
  );
}
