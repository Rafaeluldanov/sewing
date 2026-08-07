'use client';

import { useState, type FormEvent } from 'react';
import type { ClientDto } from '@sewing/shared/clients';
import { AdminModal } from '../admin-modal';
import { RefModalForm } from './ref-modal-form';
import { createClientInlineAction } from './actions';

/**
 * Минимальная модалка «＋ Добавить клиента» из select-а формы.
 * Только имя + контакты; остальное доводится в карточке /admin/clients.
 */
export function CreateClientModal({
  zIndex,
  onCancel,
  onCreated,
}: {
  zIndex?: number;
  onCancel: () => void;
  onCreated: (dto: ClientDto) => void;
}) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const result = await createClientInlineAction({
      name,
      phone: phone.trim() ? phone : undefined,
      comment: comment.trim() ? comment : undefined,
    });
    setSubmitting(false);
    if (!result.ok || !result.dto) {
      setError(result.error ?? 'Не удалось создать клиента');
      return;
    }
    onCreated(result.dto);
  }

  return (
    <AdminModal
      title="Новый клиент"
      subtitle="Реквизиты и прочие поля можно дозаполнить в карточке клиента."
      onClose={onCancel}
      zIndex={zIndex}
      closeDisabled={submitting}
    >
      <RefModalForm
        onSubmit={onSubmit}
        onCancel={onCancel}
        submitting={submitting}
        error={error}
      >
        <div className="admin-field">
          <label htmlFor="ref-client-name">Название</label>
          <input
            id="ref-client-name"
            type="text"
            required
            autoFocus
            maxLength={200}
            placeholder="Например: ИП Петров"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="admin-field">
          <label htmlFor="ref-client-phone">Телефон</label>
          <input
            id="ref-client-phone"
            type="text"
            maxLength={64}
            placeholder="+7 ..."
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </div>
        <div className="admin-field">
          <label htmlFor="ref-client-comment">Комментарий</label>
          <textarea
            id="ref-client-comment"
            maxLength={2000}
            rows={2}
            placeholder="Любые управленческие пометки"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
        </div>
      </RefModalForm>
    </AdminModal>
  );
}
