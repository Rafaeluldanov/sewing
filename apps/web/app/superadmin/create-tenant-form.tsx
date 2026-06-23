'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { createTenantAction } from './actions';
import { initialCreateTenantState } from './form-state';

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending}
    >
      {pending ? 'Провижиним… (до минуты)' : 'Создать тенанта'}
    </button>
  );
}

export function CreateTenantForm() {
  const [state, formAction] = useFormState(
    createTenantAction,
    initialCreateTenantState,
  );
  return (
    <form action={formAction} className="admin-form admin-stack">
      <div className="admin-grid-2">
        <label className="admin-field">
          <span>slug (поддомен)</span>
          <input name="slug" placeholder="acme" required pattern="[a-z0-9-]+" />
        </label>
        <label className="admin-field">
          <span>Название</span>
          <input name="name" placeholder="ООО Акме" required />
        </label>
        <label className="admin-field">
          <span>Имя БД</span>
          <input name="dbName" placeholder="tenant_acme" required pattern="[A-Za-z0-9_]+" />
        </label>
        <label className="admin-field">
          <span>Домен (host)</span>
          <input name="host" placeholder="acme.dev.teeon.ru" required />
        </label>
        <label className="admin-field">
          <span>Логин админа</span>
          <input name="adminLogin" placeholder="admin" defaultValue="admin" />
        </label>
        <label className="admin-field">
          <span>Пароль админа</span>
          <input name="adminPassword" type="password" required minLength={6} />
        </label>
        <label className="admin-field">
          <span>ФИО админа</span>
          <input name="adminName" placeholder="Администратор" />
        </label>
      </div>

      {state.error && (
        <div className="error-box" role="alert">
          {state.error}
        </div>
      )}
      {state.successMessage && (
        <div className="admin-banner admin-banner--success" role="status">
          {state.successMessage}
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

      <SubmitButton />
    </form>
  );
}
