'use client';

import { useState, type FormEvent } from 'react';
import type { WarehouseDetailDto } from '@sewing/shared/warehouses';
import { AdminModal } from '../admin-modal';
import { RefModalForm } from './ref-modal-form';
import { createWarehouseInlineAction } from './actions';

/** «＋ Добавить склад» из select-а формы. Ячейки заводятся в карточке склада. */
export function CreateWarehouseModal({
  zIndex,
  onCancel,
  onCreated,
}: {
  zIndex?: number;
  onCancel: () => void;
  onCreated: (dto: WarehouseDetailDto) => void;
}) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const result = await createWarehouseInlineAction({
      name,
      code: code.trim() ? code : null,
    });
    setSubmitting(false);
    if (!result.ok || !result.dto) {
      setError(result.error ?? 'Не удалось создать склад');
      return;
    }
    onCreated(result.dto);
  }

  return (
    <AdminModal
      title="Новый склад"
      subtitle="Линии ячеек добавляются в карточке склада."
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
          <label htmlFor="ref-warehouse-name">Название</label>
          <input
            id="ref-warehouse-name"
            type="text"
            required
            autoFocus
            maxLength={120}
            placeholder="Например: Склад готовой продукции"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="admin-field">
          <label htmlFor="ref-warehouse-code">Код (необязательно)</label>
          <input
            id="ref-warehouse-code"
            type="text"
            maxLength={32}
            placeholder="Например: ГП"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </div>
      </RefModalForm>
    </AdminModal>
  );
}
