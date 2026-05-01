'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { CheckCircle, Save, XCircle } from 'lucide-react';
import type { ClientDto } from '@sewing/shared/clients';
import { updateClientAction } from '../actions';
import {
  initialUpdateClientState,
  type UpdateClientState,
} from '../form-state';

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending}
    >
      <Save size={16} strokeWidth={1.6} aria-hidden />
      {pending ? 'Сохраняем…' : 'Сохранить'}
    </button>
  );
}

/**
 * Форма редактирования карточки клиента (`/admin/clients/[id]`).
 *
 * Удаление out-of-scope: чтобы «убрать» клиента, менеджер снимает
 * галочку «Активен» — backend выставляет `isActive=false`, и в
 * списке на `/admin/clients` карточка уезжает в таб «Архив».
 */
export function EditClientForm({ client }: { client: ClientDto }) {
  const [state, formAction] = useFormState<UpdateClientState, FormData>(
    updateClientAction.bind(null, client.id),
    initialUpdateClientState,
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
            defaultValue={client.name}
            maxLength={200}
          />
        </div>
        <div className="admin-field">
          <label htmlFor="client-phone">Телефон</label>
          <input
            id="client-phone"
            name="phone"
            type="text"
            defaultValue={client.phone ?? ''}
            maxLength={64}
          />
        </div>
        <div className="admin-field">
          <label htmlFor="client-email">Email</label>
          <input
            id="client-email"
            name="email"
            type="email"
            defaultValue={client.email ?? ''}
            maxLength={200}
          />
        </div>
      </div>
      <div className="admin-field">
        <label htmlFor="client-comment">Комментарий</label>
        <textarea
          id="client-comment"
          name="comment"
          defaultValue={client.comment ?? ''}
          maxLength={2000}
          rows={3}
        />
      </div>
      <label className="admin-field admin-field--inline">
        <input
          type="checkbox"
          name="isActive"
          defaultChecked={client.isActive}
        />
        <span>Активен</span>
      </label>

      {state.error && (
        <div className="error-box" role="alert">
          <XCircle size={16} strokeWidth={1.6} aria-hidden /> {state.error}
        </div>
      )}
      {state.ok && state.successMessage && (
        <div className="success-box" role="status">
          <CheckCircle size={16} strokeWidth={1.6} aria-hidden />{' '}
          {state.successMessage}
        </div>
      )}

      <div className="admin-actions-row">
        <SubmitButton />
      </div>
    </form>
  );
}
