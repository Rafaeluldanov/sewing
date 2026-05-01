'use client';

import { useMemo, useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import { Plus, XCircle } from 'lucide-react';
import {
  OPERATION_CATEGORIES,
  OPERATION_CATEGORY_LABELS,
  PRICING_MODES,
  TIME_NORM_MODES,
  TIME_NORM_MODE_LABELS,
  type PricingMode,
  type TimeNormMode,
} from '@sewing/shared/operations';
import type { EquipmentSummaryDto } from '@sewing/shared/equipment';
import { createOperationAction } from './actions';
import {
  initialCreateOperationState,
  type CreateOperationState,
} from './form-state';

interface CreateOperationFormProps {
  equipment: readonly EquipmentSummaryDto[];
}

const PRICING_LABEL: Record<PricingMode, string> = {
  FIXED: 'Фиксированная ставка',
  BY_SIZE: 'По размерам',
  SALARY_ONLY: 'Окладная',
};

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending}
    >
      <Plus size={16} strokeWidth={1.6} aria-hidden />
      {pending ? 'Создаём…' : 'Создать'}
    </button>
  );
}

/**
 * Форма создания операции (Admin UI 2.6).
 *
 * Backend / DTO не меняем. Поля те же, что были, но без длинных
 * технических подсказок и `Icon name=`. Чек-лист «Привязать к
 * оборудованию» — компактный, без code в каждой строке.
 */
export function CreateOperationForm({ equipment }: CreateOperationFormProps) {
  const [state, formAction] = useFormState<CreateOperationState, FormData>(
    createOperationAction,
    initialCreateOperationState,
  );
  const [pricingMode, setPricingMode] = useState<PricingMode>('FIXED');
  // Норма времени — отдельная ось от тарифа (см.
  // `docs/operation-time-norms-recon.md §10`). На форме создания
  // даём только режим FIXED + единая норма (опц.). Поразмерная
  // матрица BY_SIZE заполняется на карточке после создания.
  const [timeNormMode, setTimeNormMode] = useState<TimeNormMode>('FIXED');
  const [checkedEquipment, setCheckedEquipment] = useState<
    Record<string, boolean>
  >({});
  const checkedCount = useMemo(
    () => Object.values(checkedEquipment).filter(Boolean).length,
    [checkedEquipment],
  );

  return (
    <form action={formAction} className="admin-form">
      <div className="admin-form-grid">
        <div className="admin-field">
          <label htmlFor="op-code">Код</label>
          <input
            id="op-code"
            name="code"
            type="text"
            maxLength={64}
            placeholder="напр. SEW_OVERLOCK_3"
            required
            autoComplete="off"
            style={{ textTransform: 'uppercase' }}
          />
        </div>

        <div className="admin-field">
          <label htmlFor="op-name">Название</label>
          <input
            id="op-name"
            name="name"
            type="text"
            maxLength={120}
            placeholder="напр. Оверлок 3"
            required
            autoComplete="off"
          />
        </div>

        <div className="admin-field">
          <label htmlFor="op-category">Категория</label>
          <select id="op-category" name="category" defaultValue="SEWING">
            {OPERATION_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {OPERATION_CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="admin-form-grid">
        <div className="admin-field">
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
          <div className="admin-field">
            <label htmlFor="op-fixed-rate">Ставка за единицу, ₽</label>
            <input
              id="op-fixed-rate"
              name="fixedRate"
              type="text"
              inputMode="decimal"
              placeholder="напр. 12.50"
              required
              autoComplete="off"
            />
          </div>
        )}
      </div>

      <div className="admin-form-grid">
        <div className="admin-field">
          <label htmlFor="op-time-norm-mode">Норма времени · режим</label>
          <select
            id="op-time-norm-mode"
            name="timeNormMode"
            value={timeNormMode}
            onChange={(e) =>
              setTimeNormMode(e.target.value as TimeNormMode)
            }
          >
            {TIME_NORM_MODES.map((m) => (
              <option key={m} value={m}>
                {TIME_NORM_MODE_LABELS[m]}
              </option>
            ))}
          </select>
        </div>

        {timeNormMode === 'FIXED' ? (
          <>
            <div className="admin-field">
              <label htmlFor="op-time-norm-min">Минуты</label>
              <input
                id="op-time-norm-min"
                name="timeNormMin"
                type="number"
                min={0}
                step={1}
                inputMode="numeric"
                placeholder="0"
                autoComplete="off"
              />
            </div>
            <div className="admin-field">
              <label htmlFor="op-time-norm-sec">Секунды</label>
              <input
                id="op-time-norm-sec"
                name="timeNormSecPart"
                type="number"
                min={0}
                max={59}
                step={1}
                inputMode="numeric"
                placeholder="0"
                autoComplete="off"
              />
            </div>
          </>
        ) : (
          <div
            className="admin-field"
            style={{
              gridColumn: 'span 2',
              alignSelf: 'end',
              fontSize: '0.85rem',
            }}
          >
            <span className="admin-muted">
              Поразмерные нормы заполняются на карточке операции после
              создания.
            </span>
          </div>
        )}
      </div>

      {/*
        Плановая окладная стоимость — отдельная ось. Особенно полезно
        для pricingMode = SALARY_ONLY. На фактическую зарплату не
        влияет, см. `OrderOperationPlanService`.
      */}
      <div className="admin-form-grid">
        <div className="admin-field">
          <label htmlFor="op-salary-plan-rub">
            Плановая стоимость смены, ₽
          </label>
          <input
            id="op-salary-plan-rub"
            name="salaryPlanRubPerShift"
            type="text"
            inputMode="decimal"
            placeholder="напр. 3200"
            autoComplete="off"
          />
        </div>
        <div className="admin-field">
          <label htmlFor="op-salary-plan-hours">
            Длительность смены, ч
          </label>
          <input
            id="op-salary-plan-hours"
            name="salaryPlanShiftHours"
            type="number"
            min={0.25}
            step={0.25}
            max={48}
            inputMode="decimal"
            defaultValue="8"
            placeholder="8"
            autoComplete="off"
          />
        </div>
        <div
          className="admin-field"
          style={{
            gridColumn: 'span 2',
            alignSelf: 'end',
            fontSize: '0.85rem',
          }}
        >
          <span className="admin-muted">
            Только для плановой себестоимости окладных операций.
            Фактическая зарплата не меняется.
          </span>
        </div>
      </div>

      {equipment.length > 0 && (
        <fieldset className="admin-field" style={{ minWidth: 0 }}>
          <legend
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              fontWeight: 600,
              fontSize: '0.88rem',
            }}
          >
            Привязать к оборудованию
            {checkedCount > 0 && (
              <span className="admin-muted" style={{ fontWeight: 400 }}>
                · {checkedCount}
              </span>
            )}
          </legend>
          <ul
            className="admin-chip-list"
            style={{ marginTop: '0.4rem' }}
          >
            {equipment.map((eq) => {
              const isChecked = !!checkedEquipment[eq.id];
              return (
                <li key={eq.id}>
                  <label
                    className="admin-chip"
                    style={{
                      cursor: 'pointer',
                      ...(isChecked
                        ? {
                            background: 'var(--admin-primary-soft)',
                            color: 'var(--admin-primary-fg)',
                            borderColor: 'transparent',
                          }
                        : {}),
                    }}
                  >
                    <input
                      type="checkbox"
                      name="equipmentIds"
                      value={eq.id}
                      checked={isChecked}
                      onChange={(e) =>
                        setCheckedEquipment((prev) => ({
                          ...prev,
                          [eq.id]: e.target.checked,
                        }))
                      }
                      style={{ margin: 0 }}
                    />
                    <span>
                      {eq.displayNumber ? `№${eq.displayNumber} · ` : ''}
                      {eq.name}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </fieldset>
      )}

      <div className="admin-actions-row">
        <SubmitButton />
      </div>

      {state.error && (
        <div
          role="alert"
          style={{ color: 'var(--admin-danger-fg)', fontSize: '0.88rem' }}
        >
          <XCircle size={14} strokeWidth={1.6} aria-hidden /> {state.error}
          {state.errorRequestId && (
            <span className="admin-muted" style={{ marginLeft: 6 }}>
              req: <code>{state.errorRequestId}</code>
            </span>
          )}
          {state.partialOperationId && (
            <>
              {' '}
              <a href={`/admin/operations/${state.partialOperationId}`}>
                Открыть карточку операции →
              </a>
            </>
          )}
        </div>
      )}
    </form>
  );
}
