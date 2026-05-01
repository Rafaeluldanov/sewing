'use client';

import { useMemo, useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import {
  OPERATION_CATEGORIES,
  PRICING_MODES,
  type PricingMode,
} from '@sewing/shared/operations';
import type { EquipmentSummaryDto } from '@sewing/shared/equipment';
import { Icon } from '@/components/icon';
import { createOperationAction } from './actions';
import {
  initialCreateOperationState,
  type CreateOperationState,
} from './form-state';

interface CreateOperationFormProps {
  /**
   * Список оборудования для опционального чек-листа «привязать сразу
   * к оборудованию». Если пустой — чек-лист не отрисовывается, форма
   * остаётся минимальной (так бывает на свежей инсталляции, где
   * оборудование ещё не заведено).
   */
  equipment: readonly EquipmentSummaryDto[];
}

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

const PRICING_HINT: Record<PricingMode, string> = {
  FIXED:
    'Единая ставка за единицу. Подходит для раскроя, киперки, распошива.',
  BY_SIZE:
    'Ставки по размерам можно будет заполнить на карточке операции сразу после создания.',
  SALARY_ONLY:
    'Сдельная ставка не задаётся — начисление по сделке создаваться не будет, оплата идёт через salaryBase.',
};

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      <Icon name="plus" size={16} />
      {pending ? 'Создаём…' : 'Создать операцию'}
    </button>
  );
}

/**
 * Форма создания операции на `/admin/operations/new` (см. ADR-0020,
 * `docs/screens.md §10c`).
 *
 * Раньше форма жила прямо в списке `/admin/operations` и была плоской
 * (одна горизонтальная строка из inline-полей). Теперь это отдельный
 * экран с аккуратным `detail-form`-layout'ом: метаданные операции
 * отделены от блока «Тариф», подсказка под `pricingMode` всегда видна.
 *
 * Обязательные поля: `code`, `name`, `category`, `pricingMode`. Если
 * `pricingMode = FIXED` — показываем поле «Ставка»; для `BY_SIZE`
 * ставки заполняются на карточке (одной транзакцией через PATCH);
 * для `SALARY_ONLY` ставка не нужна вообще. Это и есть UX-инвариант
 * блока — менеджер не вводит лишнее. Backend-контракт
 * (`POST /api/operations`) и server action `createOperationAction`
 * не менялись: после успешного создания action редиректит на
 * `/admin/operations/[id]`, чтобы менеджер мог сразу донастроить
 * ставки `BY_SIZE` или `isActive`.
 */
export function CreateOperationForm({ equipment }: CreateOperationFormProps) {
  const [state, formAction] = useFormState<CreateOperationState, FormData>(
    createOperationAction,
    initialCreateOperationState,
  );
  const [pricingMode, setPricingMode] = useState<PricingMode>('FIXED');
  // Локальный state чек-листа оборудования: form-data всё равно
  // соберёт `getAll('equipmentIds')`, но контролируемые чекбоксы
  // дают визуальный счётчик «выбрано N» и подсветку строк.
  const [checkedEquipment, setCheckedEquipment] = useState<
    Record<string, boolean>
  >({});
  const checkedCount = useMemo(
    () => Object.values(checkedEquipment).filter(Boolean).length,
    [checkedEquipment],
  );

  return (
    <form action={formAction} className="detail-form">
      <div className="detail-form__grid">
        <div className="detail-form__field">
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
          <span className="detail-form__hint">
            UPPER_SNAKE_CASE. Это управленческий ID — pipeline и сиды
            завязаны на него, потом не меняется.
          </span>
        </div>

        <div className="detail-form__field">
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
          <span className="detail-form__hint">
            Видно швеям и менеджерам в списках и карточках.
          </span>
        </div>

        <div className="detail-form__field">
          <label htmlFor="op-category">Категория</label>
          <select id="op-category" name="category" defaultValue="SEWING">
            {OPERATION_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c] ?? c}
              </option>
            ))}
          </select>
          <span className="detail-form__hint">
            Группирует операции по этапу производства.
          </span>
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
          <span className="detail-form__hint">{PRICING_HINT[pricingMode]}</span>
        </div>

        {pricingMode === 'FIXED' && (
          <div className="detail-form__field">
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
            <span className="detail-form__hint">
              Целое или десятичное число; точка или запятая разделителем.
            </span>
          </div>
        )}
      </div>

      {pricingMode === 'BY_SIZE' && (
        <div className="alert-row alert-row--info" role="status">
          <span className="alert-row__icon">
            <Icon name="info" />
          </span>
          <span className="alert-row__msg">
            Таблица «размер ↔ ставка» появится на карточке операции
            сразу после создания — заполнять её на старте необязательно.
          </span>
        </div>
      )}

      {pricingMode === 'SALARY_ONLY' && (
        <div className="alert-row alert-row--info" role="status">
          <span className="alert-row__icon">
            <Icon name="info" />
          </span>
          <span className="alert-row__msg">
            Окладная операция: сдельная ставка не используется.
            Начисление по сделке создаваться не будет — оплата идёт
            через `salaryBase` сотрудника.
          </span>
        </div>
      )}

      <fieldset className="detail-form__field" style={{ minWidth: 0 }}>
        <legend
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            fontWeight: 600,
          }}
        >
          <Icon name="equipment" size={16} />
          Привязать к оборудованию
          {checkedCount > 0 && (
            <span className="detail-form__hint" style={{ fontWeight: 400 }}>
              · выбрано: <strong>{checkedCount}</strong>
            </span>
          )}
        </legend>
        <div className="alert-row alert-row--warn" role="status">
          <span className="alert-row__icon">
            <Icon name="warning" />
          </span>
          <span className="alert-row__msg">
            Без привязки к оборудованию операция не появится в выборе
            на /work после сканирования QR станка. Привязку всегда
            можно изменить в карточке станка
            (<code>/admin/equipment/[id]</code>).
          </span>
        </div>
        {equipment.length === 0 ? (
          <p className="detail-form__hint" style={{ marginTop: '0.5rem' }}>
            Активного оборудования пока нет. Заведите станок в
            <code>/admin/equipment</code> и вернитесь сюда, либо отметьте
            операцию на карточке станка позже.
          </p>
        ) : (
          <ul className="option-list" style={{ marginTop: '0.5rem' }}>
            {equipment.map((eq) => {
              const isChecked = !!checkedEquipment[eq.id];
              return (
                <li
                  key={eq.id}
                  className={`option-list__row ${isChecked ? 'is-active' : ''}`}
                >
                  <label>
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
                    />
                    <span className="option-list__row-name">
                      {eq.displayNumber && (
                        <span style={{ color: 'var(--color-fg-muted)' }}>
                          №{eq.displayNumber}{' '}
                        </span>
                      )}
                      {eq.name}
                    </span>
                    <span className="option-list__row-meta">
                      <code>{eq.code}</code> · уже {eq.allowedOperationsCount}{' '}
                      операций
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </fieldset>

      <div className="detail-form__actions">
        <SubmitButton />
      </div>

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
            {state.partialOperationId && (
              <>
                {' '}
                <a href={`/admin/operations/${state.partialOperationId}`}>
                  Открыть карточку операции →
                </a>
              </>
            )}
          </span>
        </div>
      )}
    </form>
  );
}
