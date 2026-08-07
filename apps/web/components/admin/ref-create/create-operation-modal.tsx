'use client';

import { useState, type FormEvent } from 'react';
import {
  OPERATION_CATEGORIES,
  OPERATION_CATEGORY_LABELS,
  PRICING_MODES,
  type OperationCategory,
  type OperationDetailDto,
  type PricingMode,
} from '@sewing/shared/operations';
import { formatPricingMode } from '@/lib/admin-labels';
import { AdminModal } from '../admin-modal';
import { RefModalForm } from './ref-modal-form';
import { createOperationInlineAction } from './actions';

/**
 * «＋ Добавить операцию» из GroupedOperationSelect (формы оборудования).
 * Поразмерные ставки/нормы времени — в карточке /admin/operations.
 */
export function CreateOperationModal({
  zIndex,
  onCancel,
  onCreated,
}: {
  zIndex?: number;
  onCancel: () => void;
  onCreated: (dto: OperationDetailDto) => void;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [category, setCategory] = useState<OperationCategory>('SEWING');
  const [pricingMode, setPricingMode] = useState<PricingMode>('FIXED');
  const [fixedRate, setFixedRate] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const result = await createOperationInlineAction({
      code,
      name,
      category,
      pricingMode,
      ...(pricingMode === 'FIXED' ? { fixedRate } : {}),
    });
    setSubmitting(false);
    if (!result.ok || !result.dto) {
      setError(result.error ?? 'Не удалось создать операцию');
      return;
    }
    onCreated(result.dto);
  }

  return (
    <AdminModal
      title="Новая операция"
      subtitle="Поразмерные ставки и нормы времени — в карточке операции."
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
          <label htmlFor="ref-op-code">Код</label>
          <input
            id="ref-op-code"
            type="text"
            required
            autoFocus
            maxLength={64}
            placeholder="Например: SEW_HEM"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
          />
          <p className="admin-field__hint admin-muted">
            Латинские заглавные буквы, цифры и подчёркивание.
          </p>
        </div>
        <div className="admin-field">
          <label htmlFor="ref-op-name">Название</label>
          <input
            id="ref-op-name"
            type="text"
            required
            maxLength={200}
            placeholder="Например: Подгибка низа"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="admin-field">
          <label htmlFor="ref-op-category">Категория</label>
          <select
            id="ref-op-category"
            value={category}
            onChange={(e) => setCategory(e.target.value as OperationCategory)}
          >
            {OPERATION_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {OPERATION_CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </div>
        <div className="admin-field">
          <label htmlFor="ref-op-pricing">Тип тарифа</label>
          <select
            id="ref-op-pricing"
            value={pricingMode}
            onChange={(e) => setPricingMode(e.target.value as PricingMode)}
          >
            {PRICING_MODES.map((m) => (
              <option key={m} value={m}>
                {formatPricingMode(m)}
              </option>
            ))}
          </select>
        </div>
        {pricingMode === 'FIXED' && (
          <div className="admin-field">
            <label htmlFor="ref-op-rate">Ставка за единицу, ₽</label>
            <input
              id="ref-op-rate"
              type="text"
              inputMode="decimal"
              required
              placeholder="напр. 12.50"
              value={fixedRate}
              onChange={(e) => setFixedRate(e.target.value)}
            />
          </div>
        )}
      </RefModalForm>
    </AdminModal>
  );
}
