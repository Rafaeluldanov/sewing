'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { useState } from 'react';
import type { OperationLiteDto } from '@sewing/shared/shifts';
import { Icon } from '@/components/icon';
import { createEquipmentAction } from './actions';
import {
  initialCreateEquipmentState,
  type CreateEquipmentState,
} from './form-state';

interface Props {
  operations: readonly OperationLiteDto[];
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      <Icon name="plus" size={16} />
      {pending ? 'Создаём…' : 'Создать оборудование'}
    </button>
  );
}

/**
 * Форма создания оборудования на `/admin/equipment/new` (см. ADR-0017,
 * `docs/screens.md §10a`).
 *
 * Поля:
 *   - **Название оборудования** — обязательное.
 *   - **Номер оборудования** — опциональный ручной `displayNumber`
 *     (см. `docs/domain.md §5c`); пустая строка = `null` на backend.
 *   - **Код** — опциональный технический slug. Оставляем для тех,
 *     кто хочет управлять им сам (печать стикеров и т. п.); если
 *     пусто — backend сгенерирует код из имени.
 *   - **Операции** — чек-лист, тот же стиль, что и на detail-странице
 *     (`option-list`). Порядок выбора задаёт `sortOrder` для /work.
 *
 * После успешного создания action редиректит на карточку нового
 * оборудования (`/admin/equipment/[id]`), чтобы можно было сразу
 * напечатать QR-этикетку и/или подправить операции. Тот же паттерн
 * — у `CreateWarehouseForm`.
 */
export function CreateEquipmentForm({ operations }: Props) {
  const [state, formAction] = useFormState<CreateEquipmentState, FormData>(
    createEquipmentAction,
    initialCreateEquipmentState,
  );
  const [checked, setChecked] = useState<Record<string, boolean>>({});

  const sortedOperations = [...operations].sort(
    (a, b) => a.sortOrder - b.sortOrder,
  );
  const checkedCount = sortedOperations.filter((op) => checked[op.id]).length;

  return (
    <form action={formAction} className="admin-equipment-form">
      <div className="admin-equipment-form__meta" style={{ flexWrap: 'wrap' }}>
        <label htmlFor="eq-name" className="meta-line">
          Название оборудования
        </label>
        <input
          id="eq-name"
          name="name"
          type="text"
          maxLength={120}
          placeholder="например, Оверлок 03"
          required
          autoComplete="off"
          style={{ padding: '6px 10px', minWidth: 240 }}
        />
        <label htmlFor="eq-display-number" className="meta-line">
          Номер оборудования
        </label>
        <input
          id="eq-display-number"
          name="displayNumber"
          type="text"
          maxLength={16}
          placeholder="опционально, напр. 3"
          autoComplete="off"
          style={{ padding: '6px 10px', width: 140, fontWeight: 600 }}
        />
        <label htmlFor="eq-code" className="meta-line">
          Код
        </label>
        <input
          id="eq-code"
          name="code"
          type="text"
          maxLength={64}
          placeholder="опционально, напр. overlock-03"
          autoComplete="off"
          pattern="[a-z0-9][a-z0-9-]*"
          title="Латинские строчные буквы, цифры и дефис"
          style={{ padding: '6px 10px', width: 220 }}
        />
      </div>

      <div>
        <div
          className="meta-line"
          style={{ marginBottom: 8, display: 'flex', gap: '0.75rem' }}
        >
          <span>
            <strong>Операции</strong> — отметьте, какие будут доступны швее
            на этом станке. Можно оставить пустым и настроить позже.
          </span>
          <span>
            Выбрано: <strong>{checkedCount}</strong> из{' '}
            {sortedOperations.length}
          </span>
        </div>
        <ul className="option-list">
          {sortedOperations.map((op) => {
            const isChecked = !!checked[op.id];
            return (
              <li
                key={op.id}
                className={`option-list__row ${isChecked ? 'is-active' : ''}`}
              >
                <label>
                  <input
                    type="checkbox"
                    name="operationIds"
                    value={op.id}
                    checked={isChecked}
                    onChange={(e) =>
                      setChecked((prev) => ({
                        ...prev,
                        [op.id]: e.target.checked,
                      }))
                    }
                  />
                  <span className="option-list__row-name">{op.name}</span>
                  <span className="option-list__row-meta">
                    <code>{op.code}</code> · {op.category.toLowerCase()}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="detail-form__actions">
        <SubmitButton />
      </div>

      {state.error && (
        <div className="error-box" role="alert">
          <div className="error-box__msg">{state.error}</div>
          {state.errorRequestId && (
            <div className="error-box__rid">
              req: <code>{state.errorRequestId}</code>
            </div>
          )}
        </div>
      )}
    </form>
  );
}
