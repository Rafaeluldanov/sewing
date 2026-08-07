'use client';

import { useState, type FormEvent } from 'react';
import type { SupplierDetailDto } from '@sewing/shared/suppliers';
import { AdminModal } from '../admin-modal';
import { RefModalForm } from './ref-modal-form';
import { createSupplierInlineAction } from './actions';

/**
 * «＋ Добавить поставщика» из select-а формы. Реквизиты (ИНН, банк) в
 * модалку сознательно не тащим — они доводятся в карточке поставщика;
 * заявке на оплату без реквизитов backend и так не даст ходу.
 */
export function CreateSupplierModal({
  zIndex,
  onCancel,
  onCreated,
}: {
  zIndex?: number;
  onCancel: () => void;
  onCreated: (dto: SupplierDetailDto) => void;
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
    const result = await createSupplierInlineAction({
      name,
      phone: phone.trim() ? phone : undefined,
      comment: comment.trim() ? comment : undefined,
    });
    setSubmitting(false);
    if (!result.ok || !result.dto) {
      setError(result.error ?? 'Не удалось создать поставщика');
      return;
    }
    onCreated(result.dto);
  }

  return (
    <AdminModal
      title="Новый поставщик"
      subtitle="Реквизиты для оплат дозаполняются в карточке поставщика."
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
          <label htmlFor="ref-supplier-name">Название</label>
          <input
            id="ref-supplier-name"
            type="text"
            required
            autoFocus
            maxLength={200}
            placeholder="Например: ООО «Ткани Юга»"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="admin-field">
          <label htmlFor="ref-supplier-phone">Телефон</label>
          <input
            id="ref-supplier-phone"
            type="text"
            maxLength={64}
            placeholder="+7 ..."
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </div>
        <div className="admin-field">
          <label htmlFor="ref-supplier-comment">Комментарий</label>
          <textarea
            id="ref-supplier-comment"
            maxLength={2000}
            rows={2}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
        </div>
      </RefModalForm>
    </AdminModal>
  );
}
