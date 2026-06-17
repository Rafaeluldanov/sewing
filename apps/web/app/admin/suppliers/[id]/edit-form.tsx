'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { CheckCircle, Save, XCircle } from 'lucide-react';
import {
  SUPPLIER_STATUSES,
  SUPPLIER_STATUS_LABELS,
  type SupplierDetailDto,
} from '@sewing/shared/suppliers';
import { updateSupplierAction } from '../actions';
import {
  initialUpdateSupplierState,
  type UpdateSupplierState,
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
 * Форма редактирования карточки поставщика. Удаление out-of-scope:
 * чтобы «убрать» поставщика, менеджер выбирает статус `Неактивен`
 * (UI сразу прячет поставщика из селектов в `WorkshopNeed`).
 */
export function EditSupplierForm({
  supplier,
}: {
  supplier: SupplierDetailDto;
}) {
  const [state, formAction] = useFormState<UpdateSupplierState, FormData>(
    updateSupplierAction.bind(null, supplier.id),
    initialUpdateSupplierState,
  );

  return (
    <form action={formAction} className="admin-form">
      <div className="admin-form-grid">
        <div className="admin-field">
          <label htmlFor="supplier-edit-name">Название</label>
          <input
            id="supplier-edit-name"
            name="name"
            type="text"
            required
            maxLength={200}
            defaultValue={supplier.name}
          />
        </div>
        <div className="admin-field">
          <label htmlFor="supplier-edit-status">Статус</label>
          <select
            id="supplier-edit-status"
            name="status"
            defaultValue={supplier.status}
          >
            {SUPPLIER_STATUSES.map((s) => (
              <option key={s} value={s}>
                {SUPPLIER_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <div className="admin-field">
          <label htmlFor="supplier-edit-phone">Телефон</label>
          <input
            id="supplier-edit-phone"
            name="phone"
            type="text"
            maxLength={64}
            defaultValue={supplier.phone ?? ''}
          />
        </div>
        <div className="admin-field">
          <label htmlFor="supplier-edit-website">Сайт</label>
          <input
            id="supplier-edit-website"
            name="website"
            type="text"
            maxLength={300}
            defaultValue={supplier.website ?? ''}
          />
        </div>
      </div>
      <div className="admin-field">
        <label htmlFor="supplier-edit-address">Адрес</label>
        <input
          id="supplier-edit-address"
          name="address"
          type="text"
          maxLength={500}
          defaultValue={supplier.address ?? ''}
        />
      </div>
      <div className="admin-field">
        <label htmlFor="supplier-edit-comment">Комментарий</label>
        <textarea
          id="supplier-edit-comment"
          name="comment"
          maxLength={2000}
          rows={3}
          defaultValue={supplier.comment ?? ''}
        />
      </div>

      <fieldset
        style={{
          border: '1px solid #e2e8f0',
          borderRadius: 8,
          padding: '12px 14px',
          margin: 0,
        }}
      >
        <legend style={{ fontSize: '0.85rem', fontWeight: 600, padding: '0 6px' }}>
          Реквизиты для оплаты
        </legend>
        <p className="admin-muted" style={{ marginTop: 0, fontSize: '0.82rem' }}>
          Используются при создании заявки на оплату по заказу поставщику —
          подставляются автоматически (в заявке их можно отредактировать).
        </p>
        <div className="admin-form-grid">
          <div className="admin-field">
            <label htmlFor="supplier-edit-legalName">Юр. название</label>
            <input
              id="supplier-edit-legalName"
              name="legalName"
              type="text"
              maxLength={300}
              defaultValue={supplier.legalName ?? ''}
              placeholder='ООО «…»'
            />
          </div>
          <div className="admin-field">
            <label htmlFor="supplier-edit-inn">ИНН</label>
            <input
              id="supplier-edit-inn"
              name="inn"
              type="text"
              maxLength={32}
              defaultValue={supplier.inn ?? ''}
            />
          </div>
          <div className="admin-field">
            <label htmlFor="supplier-edit-kpp">КПП</label>
            <input
              id="supplier-edit-kpp"
              name="kpp"
              type="text"
              maxLength={32}
              defaultValue={supplier.kpp ?? ''}
            />
          </div>
          <div className="admin-field">
            <label htmlFor="supplier-edit-bankName">Банк</label>
            <input
              id="supplier-edit-bankName"
              name="bankName"
              type="text"
              maxLength={300}
              defaultValue={supplier.bankName ?? ''}
            />
          </div>
          <div className="admin-field">
            <label htmlFor="supplier-edit-bankAccount">Расчётный счёт</label>
            <input
              id="supplier-edit-bankAccount"
              name="bankAccount"
              type="text"
              maxLength={64}
              defaultValue={supplier.bankAccount ?? ''}
            />
          </div>
          <div className="admin-field">
            <label htmlFor="supplier-edit-bankBik">БИК</label>
            <input
              id="supplier-edit-bankBik"
              name="bankBik"
              type="text"
              maxLength={32}
              defaultValue={supplier.bankBik ?? ''}
            />
          </div>
          <div className="admin-field">
            <label htmlFor="supplier-edit-bankCorrAccount">Корр. счёт</label>
            <input
              id="supplier-edit-bankCorrAccount"
              name="bankCorrAccount"
              type="text"
              maxLength={64}
              defaultValue={supplier.bankCorrAccount ?? ''}
            />
          </div>
        </div>
      </fieldset>

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
