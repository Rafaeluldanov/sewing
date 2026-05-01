'use client';

import { useMemo, useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import {
  OPERATION_CATEGORIES,
  PRICING_MODES,
  type OperationDetailDto,
  type PricingMode,
} from '@sewing/shared/operations';
import { Icon } from '@/components/icon';
import { updateOperationAction } from '../actions';
import {
  initialUpdateOperationState,
  type UpdateOperationState,
} from '../form-state';

const CATEGORY_LABEL: Record<string, string> = {
  CUTTING: 'Раскрой',
  SEWING: 'Пошив',
  QC: 'ОТК',
  IRONING: 'ВТО',
  PACKING: 'Упаковка',
};

const PRICING_LABEL: Record<PricingMode, string> = {
  FIXED: 'Фиксированная ставка',
  BY_SIZE: 'По размерам (для оверлока)',
  SALARY_ONLY: 'Окладная (без сдельной ставки)',
};

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      <Icon name="save" size={16} />
      {pending ? 'Сохраняем…' : 'Сохранить'}
    </button>
  );
}

interface Props {
  operation: OperationDetailDto;
}

/**
 * Форма редактирования операции на `/admin/operations/[id]`.
 *
 * Логика UX (см. `docs/screens.md §10c`):
 *
 *   - meta (`name`, `category`, `isActive`) — всегда видно;
 *   - переключатель `pricingMode` (FIXED | BY_SIZE | SALARY_ONLY)
 *     перерисовывает блок ставок:
 *       * FIXED       → одно поле «Ставка за единицу»;
 *       * BY_SIZE     → таблица «размер → ставка», заранее
 *         подставлена текущими значениями. Кнопка «Заполнить всем
 *         одну ставку» — bulk-helper для типового кейса оверлока.
 *       * SALARY_ONLY → явная пометка «сдельная ставка не используется»;
 *   - один Save шлёт всё в `PATCH /api/operations/:id`. Backend
 *     атомарно меняет `pricingMode`, `fixedRate` и таблицу
 *     `OperationRateBySize` в одной транзакции (см. ADR-0017).
 *
 * `code` менеджер не меняет — это управленческий ID, на который
 * завязаны pipeline и сиды (`prisma/seed.ts`). Если очень надо —
 * заводите новую операцию и деактивируете старую.
 */
export function OperationEditForm({ operation }: Props) {
  const [pricingMode, setPricingMode] = useState<PricingMode>(
    operation.pricingMode,
  );
  const [bulkValue, setBulkValue] = useState<string>('');
  const [rateInputs, setRateInputs] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const r of operation.ratesBySize) {
      initial[r.sizeId] = r.rate.toFixed(2);
    }
    return initial;
  });

  const update = updateOperationAction.bind(null, operation.id);
  const [state, formAction] = useFormState<UpdateOperationState, FormData>(
    update,
    initialUpdateOperationState,
  );

  const sizesById = useMemo(() => {
    const map = new Map<string, { code: string; sortOrder: number }>();
    for (const s of operation.sizes) {
      map.set(s.id, { code: s.code, sortOrder: s.sortOrder });
    }
    return map;
  }, [operation.sizes]);

  function setBulkAll() {
    if (bulkValue.trim().length === 0) return;
    const next: Record<string, string> = {};
    for (const s of operation.sizes) next[s.id] = bulkValue.trim();
    setRateInputs(next);
  }

  return (
    <form action={formAction} className="detail-form">
      <div className="detail-form__grid">
        <div className="detail-form__field">
          <span className="detail-form__label">Код (read-only)</span>
          <code
            style={{
              padding: '0.55rem 0.85rem',
              background: 'var(--color-bg-muted)',
              borderRadius: 'var(--radius-md)',
              fontSize: '0.95rem',
              alignSelf: 'flex-start',
            }}
          >
            {operation.code}
          </code>
        </div>

        <div className="detail-form__field">
          <label htmlFor="op-name">Название</label>
          <input
            id="op-name"
            name="name"
            type="text"
            maxLength={120}
            defaultValue={operation.name}
            required
            autoComplete="off"
          />
        </div>

        <div className="detail-form__field">
          <label htmlFor="op-category">Категория</label>
          <select
            id="op-category"
            name="category"
            defaultValue={operation.category}
          >
            {OPERATION_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c] ?? c}
              </option>
            ))}
          </select>
        </div>

        <div className="detail-form__field detail-form__field--inline">
          <input
            id="op-is-active"
            type="checkbox"
            name="isActive"
            defaultChecked={operation.isActive}
          />
          <label htmlFor="op-is-active">Активна</label>
        </div>
      </div>

      <div className="detail-form__grid">
        <div className="detail-form__field">
          <label htmlFor="op-pricing-mode">Тип тарифа</label>
          <select
            id="op-pricing-mode"
            name="pricingMode"
            value={pricingMode}
            onChange={(e) => setPricingMode(e.target.value as PricingMode)}
          >
            {PRICING_MODES.map((m) => (
              <option key={m} value={m}>
                {PRICING_LABEL[m]}
              </option>
            ))}
          </select>
        </div>

        {pricingMode === 'FIXED' && (
          <div className="detail-form__field">
            <label htmlFor="op-fixed-rate">Ставка за единицу, ₽</label>
            <input
              id="op-fixed-rate"
              name="fixedRate"
              type="text"
              inputMode="decimal"
              defaultValue={
                operation.fixedRate !== null
                  ? operation.fixedRate.toFixed(2)
                  : ''
              }
              placeholder="напр. 12.50"
              required
              autoComplete="off"
            />
          </div>
        )}
      </div>

      {pricingMode === 'BY_SIZE' && (
        <div
          className="section-card"
          style={{ background: 'var(--color-bg-soft)' }}
        >
          <div className="section-header" style={{ marginBottom: '0.5rem' }}>
            <h2>
              <Icon name="operations" />
              Ставки по размерам
            </h2>
            <span className="section-header__hint">
              Сейчас в БД: {operation.ratesBySize.length} из {sizesById.size}.
            </span>
          </div>
          <p className="detail-form__hint" style={{ marginTop: 0 }}>
            Заполните ставку для каждого размера. Пустые поля сохраняются как
            «нет ставки» — backend удалит соответствующую строку. На старте
            удобно использовать «Заполнить всем».
          </p>

          <div className="detail-form__row" style={{ marginBottom: '0.75rem' }}>
            <input
              type="text"
              inputMode="decimal"
              placeholder="напр. 15.00"
              value={bulkValue}
              onChange={(e) => setBulkValue(e.target.value)}
              style={{ width: 160 }}
            />
            <button
              type="button"
              className="btn"
              onClick={setBulkAll}
              disabled={bulkValue.trim().length === 0}
              title="Подставить эту ставку во все строки таблицы (можно править вручную дальше)"
            >
              <Icon name="plus" size={14} />
              Заполнить всем одну ставку
            </button>
          </div>

          {operation.sizes.length === 0 ? (
            <div className="empty-state">
              <span className="empty-state__icon">
                <Icon name="operations" />
              </span>
              <span className="empty-state__title">Нет размеров</span>
              <span className="empty-state__hint">
                В справочнике размеров нет строк — добавьте их, чтобы задать
                ставки.
              </span>
            </div>
          ) : (
            <div className="rate-table-grid">
              {operation.sizes.map((s) => (
                <label key={s.id} className="rate-cell">
                  <span className="rate-cell__size">{s.code}</span>
                  <input
                    name={`rate-${s.id}`}
                    type="text"
                    inputMode="decimal"
                    value={rateInputs[s.id] ?? ''}
                    onChange={(e) =>
                      setRateInputs((prev) => ({
                        ...prev,
                        [s.id]: e.target.value,
                      }))
                    }
                    placeholder="—"
                    className="rate-cell__input"
                  />
                </label>
              ))}
            </div>
          )}
        </div>
      )}

      {pricingMode === 'SALARY_ONLY' && (
        <div
          className="alert-row alert-row--info"
          style={{ marginTop: 0 }}
          role="status"
        >
          <span className="alert-row__icon">
            <Icon name="info" />
          </span>
          <span className="alert-row__msg">
            Окладная операция: сдельная ставка не используется. Начисление по
            сделке создаваться не будет — оплата идёт через `salaryBase`
            сотрудника.
          </span>
        </div>
      )}

      <div className="detail-form__actions">
        <SaveButton />
      </div>

      {state.successMessage && (
        <div className="detail-form__success" role="status">
          <Icon name="success" size={16} />
          <span>{state.successMessage}</span>
        </div>
      )}
      {state.error && (
        <div className="detail-form__error" role="alert">
          <Icon name="error" size={16} />
          <span>
            {state.error}
            {state.errorRequestId && (
              <span className="detail-form__error-rid">
                req: <code>{state.errorRequestId}</code>
              </span>
            )}
          </span>
        </div>
      )}
    </form>
  );
}
