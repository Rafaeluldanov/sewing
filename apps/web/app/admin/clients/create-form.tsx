'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { Plus, XCircle } from 'lucide-react';
import { createClientAction } from './actions';
import {
  initialCreateClientState,
  type CreateClientState,
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
      {pending ? 'Создаём…' : 'Создать'}
    </button>
  );
}

/**
 * Форма создания клиента (`/admin/clients/new`).
 *
 * Минимально достаточный набор полей: имя (обязательное), телефон,
 * email, комментарий. После успеха server action редиректит на
 * карточку нового клиента — типовой UX для admin-create-форм.
 */
export function CreateClientForm() {
  const [state, formAction] = useFormState<CreateClientState, FormData>(
    createClientAction,
    initialCreateClientState,
  );

  return (
    <form action={formAction} className="admin-form">
      <div className="admin-form-grid">
        <div className="admin-field">
          <label htmlFor="client-name">Название</label>
          <input
            id="client-name"
            name="name"
            type="text"
            required
            maxLength={200}
            placeholder="Например: ИП Петров"
          />
        </div>
        <div className="admin-field">
          <label htmlFor="client-phone">Телефон</label>
          <input
            id="client-phone"
            name="phone"
            type="text"
            maxLength={64}
            placeholder="+7 ..."
          />
        </div>
        <div className="admin-field">
          <label htmlFor="client-email">Email</label>
          <input
            id="client-email"
            name="email"
            type="email"
            maxLength={200}
            placeholder="example@company.ru"
          />
        </div>
      </div>
      <div className="admin-field">
        <label htmlFor="client-comment">Комментарий</label>
        <textarea
          id="client-comment"
          name="comment"
          maxLength={2000}
          rows={3}
          placeholder="Любые управленческие пометки"
        />
      </div>

      {state.error && (
        <div className="error-box" role="alert">
          <XCircle size={16} strokeWidth={1.6} aria-hidden /> {state.error}
        </div>
      )}

      <div className="admin-actions-row">
        <SubmitButton />
      </div>
    </form>
  );
}
