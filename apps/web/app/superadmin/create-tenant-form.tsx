'use client';

import { useState } from 'react';
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

/** Имя БД из поддомена: `tenant_<slug>`, дефисы → подчёркивания (slug
 *  допускает `-`, а имя БД Postgres — только `[A-Za-z0-9_]`). */
function deriveDbName(slug: string): string {
  const s = slug.trim();
  return s ? `tenant_${s.replace(/-/g, '_')}` : '';
}

/** Host из поддомена: `<slug>.<baseDomain>`. */
function deriveHost(slug: string, baseDomain: string): string {
  const s = slug.trim();
  return s ? `${s}.${baseDomain}` : '';
}

export function CreateTenantForm({ baseDomain }: { baseDomain: string }) {
  const [state, formAction] = useFormState(
    createTenantAction,
    initialCreateTenantState,
  );

  // slug — источник истины: dbName и host по умолчанию выводятся из него, но
  // остаются редактируемыми. Как только оператор правит поле руками (флаг
  // *Edited), авто-подстановка для этого поля прекращается — чтобы ввод
  // поддомена не затирал кастомный домен/имя БД. Очистка поля снова включает
  // авто-подстановку.
  const [slug, setSlug] = useState('');
  const [dbName, setDbName] = useState('');
  const [host, setHost] = useState('');
  const [dbNameEdited, setDbNameEdited] = useState(false);
  const [hostEdited, setHostEdited] = useState(false);

  function onSlugChange(value: string) {
    setSlug(value);
    if (!dbNameEdited) setDbName(deriveDbName(value));
    if (!hostEdited) setHost(deriveHost(value, baseDomain));
  }

  return (
    <form action={formAction} className="admin-form admin-stack">
      <div className="admin-grid-2">
        <label className="admin-field">
          <span>slug (поддомен)</span>
          <input
            name="slug"
            placeholder="acme"
            required
            pattern="[a-z0-9-]+"
            value={slug}
            onChange={(e) => onSlugChange(e.target.value)}
          />
        </label>
        <label className="admin-field">
          <span>Название</span>
          <input name="name" placeholder="ООО Акме" required />
        </label>
        <label className="admin-field">
          <span>Имя БД</span>
          <input
            name="dbName"
            placeholder="tenant_acme"
            required
            pattern="[A-Za-z0-9_]+"
            value={dbName}
            onChange={(e) => {
              const v = e.target.value;
              setDbName(v);
              setDbNameEdited(v.trim() !== '');
            }}
          />
        </label>
        <label className="admin-field">
          <span>Домен (host)</span>
          <input
            name="host"
            placeholder={`acme.${baseDomain}`}
            required
            value={host}
            onChange={(e) => {
              const v = e.target.value;
              setHost(v);
              setHostEdited(v.trim() !== '');
            }}
          />
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
