'use client';

import { useState, type FormEvent } from 'react';
import {
  CASH_FLOW_DIRECTIONS,
  CASH_FLOW_DIRECTION_LABELS,
  type CashFlowDirection,
  type CashFlowItemDto,
} from '@sewing/shared/treasury';
import { AdminModal } from '../admin-modal';
import { RefModalForm } from './ref-modal-form';
import { createCashFlowItemInlineAction } from './actions';

/** «＋ Добавить статью ДДС» из select-а формы казначейства. */
export function CreateCashFlowItemModal({
  zIndex,
  onCancel,
  onCreated,
}: {
  zIndex?: number;
  onCancel: () => void;
  onCreated: (dto: CashFlowItemDto) => void;
}) {
  const [name, setName] = useState('');
  const [direction, setDirection] = useState<'' | CashFlowDirection>('');
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const result = await createCashFlowItemInlineAction({
      name,
      direction: direction === '' ? null : direction,
      code: code.trim() ? code : null,
    });
    setSubmitting(false);
    if (!result.ok || !result.dto) {
      setError(result.error ?? 'Не удалось создать статью ДДС');
      return;
    }
    onCreated(result.dto);
  }

  return (
    <AdminModal
      title="Новая статья ДДС"
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
          <label htmlFor="ref-cfi-name">Название</label>
          <input
            id="ref-cfi-name"
            type="text"
            required
            autoFocus
            maxLength={160}
            placeholder="Например: Закупка фурнитуры"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="admin-field">
          <label htmlFor="ref-cfi-direction">Направление</label>
          <select
            id="ref-cfi-direction"
            value={direction}
            onChange={(e) =>
              setDirection(e.target.value as '' | CashFlowDirection)
            }
          >
            <option value="">— без направления —</option>
            {CASH_FLOW_DIRECTIONS.map((d) => (
              <option key={d} value={d}>
                {CASH_FLOW_DIRECTION_LABELS[d]}
              </option>
            ))}
          </select>
        </div>
        <div className="admin-field">
          <label htmlFor="ref-cfi-code">Код (необязательно)</label>
          <input
            id="ref-cfi-code"
            type="text"
            maxLength={40}
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </div>
      </RefModalForm>
    </AdminModal>
  );
}
