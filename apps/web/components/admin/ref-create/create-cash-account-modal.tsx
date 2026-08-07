'use client';

import { useState, type FormEvent } from 'react';
import {
  CASH_ACCOUNT_KINDS,
  CASH_ACCOUNT_KIND_LABELS,
  type CashAccountDto,
  type CashAccountKind,
} from '@sewing/shared/treasury';
import { AdminModal } from '../admin-modal';
import { RefModalForm } from './ref-modal-form';
import { createCashAccountInlineAction } from './actions';

/** «＋ Добавить счёт/кассу» из select-а формы казначейства. Валюта — RUB (MVP). */
export function CreateCashAccountModal({
  zIndex,
  onCancel,
  onCreated,
}: {
  zIndex?: number;
  onCancel: () => void;
  onCreated: (dto: CashAccountDto) => void;
}) {
  const [kind, setKind] = useState<CashAccountKind>('BANK');
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const result = await createCashAccountInlineAction({
      kind,
      name,
      currency: 'RUB',
    });
    setSubmitting(false);
    if (!result.ok || !result.dto) {
      setError(result.error ?? 'Не удалось создать счёт');
      return;
    }
    onCreated(result.dto);
  }

  return (
    <AdminModal
      title="Новый счёт"
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
          <label htmlFor="ref-account-kind">Тип</label>
          <select
            id="ref-account-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as CashAccountKind)}
          >
            {CASH_ACCOUNT_KINDS.map((k) => (
              <option key={k} value={k}>
                {CASH_ACCOUNT_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </div>
        <div className="admin-field">
          <label htmlFor="ref-account-name">Название</label>
          <input
            id="ref-account-name"
            type="text"
            required
            autoFocus
            maxLength={120}
            placeholder="Например: Расчётный счёт Сбер"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
      </RefModalForm>
    </AdminModal>
  );
}
