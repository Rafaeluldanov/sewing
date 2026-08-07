'use client';

import { useState, type FormEvent } from 'react';
import type { CompanyDivisionDto } from '@sewing/shared/company-divisions';
import { AdminModal } from '../admin-modal';
import { RefModalForm } from './ref-modal-form';
import { createCompanyDivisionInlineAction } from './actions';

/**
 * «＋ Добавить подразделение» из select-а формы. Код участвует в
 * нумерации заказов (`КОД-NNNNN`) — подсказываем это прямо в поле.
 */
export function CreateCompanyDivisionModal({
  zIndex,
  onCancel,
  onCreated,
}: {
  zIndex?: number;
  onCancel: () => void;
  onCreated: (dto: CompanyDivisionDto) => void;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const result = await createCompanyDivisionInlineAction({ code, name });
    setSubmitting(false);
    if (!result.ok || !result.dto) {
      setError(result.error ?? 'Не удалось создать подразделение');
      return;
    }
    onCreated(result.dto);
  }

  return (
    <AdminModal
      title="Новое подразделение"
      subtitle="Описание и настройки выдачи материалов — в «Настройках компании»."
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
          <label htmlFor="ref-division-code">Код</label>
          <input
            id="ref-division-code"
            type="text"
            required
            autoFocus
            maxLength={16}
            placeholder="Например: 01"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <p className="admin-field__hint admin-muted">
            Код попадает в номера заказов подразделения (КОД-NNNNN).
          </p>
        </div>
        <div className="admin-field">
          <label htmlFor="ref-division-name">Название</label>
          <input
            id="ref-division-name"
            type="text"
            required
            maxLength={160}
            placeholder="Например: Цех трикотажа"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
      </RefModalForm>
    </AdminModal>
  );
}
