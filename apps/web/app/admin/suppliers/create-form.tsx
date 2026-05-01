'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { Plus, XCircle } from 'lucide-react';
import { createSupplierAction } from './actions';
import {
  initialCreateSupplierState,
  type CreateSupplierState,
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
 * Форма создания поставщика (`/admin/suppliers/new`).
 *
 * Минимально достаточный набор: имя (обязательное) + телефон / сайт /
 * адрес / комментарий. После успеха server action редиректит на
 * карточку нового поставщика — типовой UX для admin-create-форм.
 */
export function CreateSupplierForm() {
  const [state, formAction] = useFormState<CreateSupplierState, FormData>(
    createSupplierAction,
    initialCreateSupplierState,
  );

  return (
    <form action={formAction} className="admin-form">
      <div className="admin-form-grid">
        <div className="admin-field">
          <label htmlFor="supplier-name">Название</label>
          <input
            id="supplier-name"
            name="name"
            type="text"
            required
            maxLength={200}
            placeholder="Например: ООО «Текстиль-Юг»"
          />
        </div>
        <div className="admin-field">
          <label htmlFor="supplier-phone">Телефон</label>
          <input
            id="supplier-phone"
            name="phone"
            type="text"
            maxLength={64}
            placeholder="+7 ..."
          />
        </div>
        <div className="admin-field">
          <label htmlFor="supplier-website">Сайт</label>
          <input
            id="supplier-website"
            name="website"
            type="text"
            maxLength={300}
            placeholder="https://..."
          />
        </div>
      </div>
      <div className="admin-field">
        <label htmlFor="supplier-address">Адрес</label>
        <input
          id="supplier-address"
          name="address"
          type="text"
          maxLength={500}
          placeholder="Город, улица, офис"
        />
      </div>
      <div className="admin-field">
        <label htmlFor="supplier-comment">Комментарий</label>
        <textarea
          id="supplier-comment"
          name="comment"
          maxLength={2000}
          rows={3}
          placeholder="Произвольные пометки"
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
