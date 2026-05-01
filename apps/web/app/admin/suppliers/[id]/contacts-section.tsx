'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { CheckCircle, Plus, Save, Trash2, XCircle } from 'lucide-react';
import type { SupplierContactDto } from '@sewing/shared/suppliers';
import {
  createSupplierContactAction,
  deleteSupplierContactAction,
  updateSupplierContactAction,
} from '../actions';
import {
  initialSupplierContactFormState,
  type SupplierContactFormState,
} from '../form-state';

/**
 * Блок контактов поставщика. Каждый контакт редактируется отдельной
 * формой (inline), новый создаётся формой ниже списка.
 *
 * Удаление физическое (см. ТЗ §5: contact можно удалять физически —
 * он не упоминается в `WorkshopNeed`). Backend всё равно остаётся
 * единственным источником правды (form action ходит туда).
 */
export function ContactsSection({
  supplierId,
  contacts,
}: {
  supplierId: string;
  contacts: SupplierContactDto[];
}) {
  return (
    <div className="admin-stack">
      <ul
        className="admin-summary-list"
        style={{ display: 'grid', gap: 8, padding: 0, margin: 0 }}
      >
        {contacts.length === 0 && (
          <li className="admin-muted" style={{ padding: '8px 0' }}>
            Контактов пока нет — добавьте первого менеджера ниже.
          </li>
        )}
        {contacts.map((c) => (
          <li
            key={c.id}
            style={{
              borderTop: '1px solid rgba(0,0,0,0.06)',
              paddingTop: 12,
            }}
          >
            <ContactEditForm supplierId={supplierId} contact={c} />
          </li>
        ))}
      </ul>

      <div
        style={{
          borderTop: '1px solid rgba(0,0,0,0.08)',
          paddingTop: 12,
          marginTop: 8,
        }}
      >
        <h4 style={{ fontSize: '0.85rem', margin: '0 0 8px' }}>
          Добавить контакт
        </h4>
        <ContactCreateForm supplierId={supplierId} />
      </div>
    </div>
  );
}

function CreateButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending}
    >
      <Plus size={14} strokeWidth={1.6} aria-hidden />
      {pending ? 'Создаём…' : 'Добавить'}
    </button>
  );
}

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="admin-btn" disabled={pending}>
      <Save size={14} strokeWidth={1.6} aria-hidden />
      {pending ? 'Сохраняем…' : 'Сохранить'}
    </button>
  );
}

function DeleteButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--ghost"
      disabled={pending}
      title="Удалить контакт"
    >
      <Trash2 size={14} strokeWidth={1.6} aria-hidden />
      {pending ? 'Удаляем…' : 'Удалить'}
    </button>
  );
}

function ContactCreateForm({ supplierId }: { supplierId: string }) {
  const [state, formAction] = useFormState<SupplierContactFormState, FormData>(
    createSupplierContactAction.bind(null, supplierId),
    initialSupplierContactFormState,
  );
  return (
    <form action={formAction} className="admin-form">
      <div className="admin-form-grid">
        <div className="admin-field">
          <label htmlFor={`contact-new-name-${supplierId}`}>Имя</label>
          <input
            id={`contact-new-name-${supplierId}`}
            name="name"
            type="text"
            required
            maxLength={200}
            placeholder="Менеджер"
          />
        </div>
        <div className="admin-field">
          <label htmlFor={`contact-new-position-${supplierId}`}>
            Должность
          </label>
          <input
            id={`contact-new-position-${supplierId}`}
            name="position"
            type="text"
            maxLength={200}
          />
        </div>
        <div className="admin-field">
          <label htmlFor={`contact-new-phone-${supplierId}`}>Телефон</label>
          <input
            id={`contact-new-phone-${supplierId}`}
            name="phone"
            type="text"
            maxLength={64}
          />
        </div>
        <div className="admin-field">
          <label htmlFor={`contact-new-email-${supplierId}`}>Email</label>
          <input
            id={`contact-new-email-${supplierId}`}
            name="email"
            type="email"
            maxLength={200}
          />
        </div>
        <div className="admin-field">
          <label htmlFor={`contact-new-messenger-${supplierId}`}>
            Мессенджер
          </label>
          <input
            id={`contact-new-messenger-${supplierId}`}
            name="messenger"
            type="text"
            maxLength={200}
            placeholder="Telegram / WhatsApp / ..."
          />
        </div>
      </div>
      <label className="admin-field admin-field--inline">
        <input type="checkbox" name="isPrimary" />
        <span>Основной контакт</span>
      </label>
      <div className="admin-field">
        <label htmlFor={`contact-new-comment-${supplierId}`}>Комментарий</label>
        <textarea
          id={`contact-new-comment-${supplierId}`}
          name="comment"
          rows={2}
          maxLength={2000}
        />
      </div>
      {state.error && (
        <div className="error-box" role="alert">
          <XCircle size={14} strokeWidth={1.6} aria-hidden /> {state.error}
        </div>
      )}
      {state.ok && state.successMessage && (
        <div className="success-box" role="status">
          <CheckCircle size={14} strokeWidth={1.6} aria-hidden />{' '}
          {state.successMessage}
        </div>
      )}
      <div className="admin-actions-row">
        <CreateButton />
      </div>
    </form>
  );
}

function ContactEditForm({
  supplierId,
  contact,
}: {
  supplierId: string;
  contact: SupplierContactDto;
}) {
  const [updateState, updateAction] = useFormState<
    SupplierContactFormState,
    FormData
  >(
    updateSupplierContactAction.bind(null, supplierId, contact.id),
    initialSupplierContactFormState,
  );
  const [deleteState, deleteAction] = useFormState<
    SupplierContactFormState,
    FormData
  >(
    deleteSupplierContactAction.bind(null, supplierId, contact.id),
    initialSupplierContactFormState,
  );

  return (
    <div>
      <form action={updateAction} className="admin-form">
        <div className="admin-form-grid">
          <div className="admin-field">
            <label htmlFor={`contact-name-${contact.id}`}>Имя</label>
            <input
              id={`contact-name-${contact.id}`}
              name="name"
              type="text"
              required
              maxLength={200}
              defaultValue={contact.name}
            />
          </div>
          <div className="admin-field">
            <label htmlFor={`contact-position-${contact.id}`}>Должность</label>
            <input
              id={`contact-position-${contact.id}`}
              name="position"
              type="text"
              maxLength={200}
              defaultValue={contact.position ?? ''}
            />
          </div>
          <div className="admin-field">
            <label htmlFor={`contact-phone-${contact.id}`}>Телефон</label>
            <input
              id={`contact-phone-${contact.id}`}
              name="phone"
              type="text"
              maxLength={64}
              defaultValue={contact.phone ?? ''}
            />
          </div>
          <div className="admin-field">
            <label htmlFor={`contact-email-${contact.id}`}>Email</label>
            <input
              id={`contact-email-${contact.id}`}
              name="email"
              type="email"
              maxLength={200}
              defaultValue={contact.email ?? ''}
            />
          </div>
          <div className="admin-field">
            <label htmlFor={`contact-messenger-${contact.id}`}>
              Мессенджер
            </label>
            <input
              id={`contact-messenger-${contact.id}`}
              name="messenger"
              type="text"
              maxLength={200}
              defaultValue={contact.messenger ?? ''}
            />
          </div>
        </div>
        <label className="admin-field admin-field--inline">
          <input
            type="checkbox"
            name="isPrimary"
            defaultChecked={contact.isPrimary}
          />
          <span>Основной контакт</span>
        </label>
        <div className="admin-field">
          <label htmlFor={`contact-comment-${contact.id}`}>Комментарий</label>
          <textarea
            id={`contact-comment-${contact.id}`}
            name="comment"
            rows={2}
            maxLength={2000}
            defaultValue={contact.comment ?? ''}
          />
        </div>
        {updateState.error && (
          <div className="error-box" role="alert">
            <XCircle size={14} strokeWidth={1.6} aria-hidden />{' '}
            {updateState.error}
          </div>
        )}
        {updateState.ok && updateState.successMessage && (
          <div className="success-box" role="status">
            <CheckCircle size={14} strokeWidth={1.6} aria-hidden />{' '}
            {updateState.successMessage}
          </div>
        )}
        <div className="admin-actions-row">
          <SaveButton />
        </div>
      </form>

      <form action={deleteAction} style={{ marginTop: 6 }}>
        {deleteState.error && (
          <div className="error-box" role="alert" style={{ marginBottom: 6 }}>
            <XCircle size={14} strokeWidth={1.6} aria-hidden />{' '}
            {deleteState.error}
          </div>
        )}
        <DeleteButton />
      </form>
    </div>
  );
}
