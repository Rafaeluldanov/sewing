'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { useMemo, useState } from 'react';
import type { EquipmentDetailDto } from '@sewing/shared/equipment';
import type { OperationLiteDto } from '@sewing/shared/shifts';
import { Icon } from '@/components/icon';
import {
  updateEquipmentDisplayNumberAction,
  updateEquipmentNameAction,
  updateEquipmentOperationsAction,
} from './actions';
import {
  initialUpdateDisplayNumberState,
  initialUpdateNameState,
  initialUpdateOperationsState,
  type UpdateDisplayNumberState,
  type UpdateNameState,
  type UpdateOperationsState,
} from './form-state';

interface Props {
  equipment: EquipmentDetailDto;
  operations: readonly OperationLiteDto[];
}

function SaveOperationsButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      <Icon name="save" size={16} />
      {pending ? 'Сохраняем…' : 'Сохранить набор операций'}
    </button>
  );
}

function SaveDisplayNumberButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      <Icon name="save" size={16} />
      {pending ? 'Сохраняем…' : 'Сохранить номер'}
    </button>
  );
}

function SaveNameButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      <Icon name="save" size={16} />
      {pending ? 'Сохраняем…' : 'Сохранить название'}
    </button>
  );
}

/**
 * Точечная форма переименования оборудования.
 *
 * Сознательно живёт отдельно от номера и чек-листа операций — у
 * каждой секции свой Save и своё success/error-состояние, чтобы
 * менеджер не путался, что именно он только что сохранил. Тот же
 * паттерн использует `EquipmentDisplayNumberForm`.
 *
 * Источник истины — backend `PATCH /api/equipment/:id`. Пустое
 * название отсекается и на клиенте, и на сервере (Zod-схема
 * `UpdateEquipmentSchema`).
 */
export function EquipmentNameForm({
  equipment,
}: {
  equipment: EquipmentDetailDto;
}) {
  const action = updateEquipmentNameAction.bind(null, equipment.id);
  const [state, formAction] = useFormState<UpdateNameState, FormData>(
    action,
    initialUpdateNameState,
  );

  return (
    <form action={formAction} className="detail-form">
      <div className="detail-form__grid">
        <div className="detail-form__field">
          <label htmlFor="equipment-name">Название оборудования</label>
          <input
            id="equipment-name"
            name="name"
            type="text"
            maxLength={120}
            defaultValue={equipment.name}
            placeholder="например, Оверлок 03"
            required
            autoComplete="off"
            style={{ fontWeight: 500 }}
          />
          <span className="detail-form__hint">
            Видно в списке оборудования, на печатной QR-этикетке и в
            форме старта смены на /work.
          </span>
        </div>
      </div>

      <div className="detail-form__actions">
        <SaveNameButton />
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
          </span>
        </div>
      )}
      {state.ok && (
        <div className="detail-form__success" role="status">
          <Icon name="success" size={16} />
          <span>Изменения сохранены.</span>
        </div>
      )}
    </form>
  );
}

/**
 * Точечная форма редактирования `displayNumber` оборудования.
 *
 * Сознательно живёт отдельно от чек-листа операций: это два разных
 * use-case-а (физическая маркировка vs конфигурация /work), у них
 * разные аудитории и разный темп изменений. Один общий save-button
 * только запутывал бы UX.
 *
 * Источник истины — backend `PATCH /api/equipment/:id`. Пустое поле
 * сохраняется как `null` (сброс номера) — backend Zod-схема делает то
 * же самое, см. `UpdateEquipmentSchema`.
 */
export function EquipmentDisplayNumberForm({
  equipment,
}: {
  equipment: EquipmentDetailDto;
}) {
  const action = updateEquipmentDisplayNumberAction.bind(null, equipment.id);
  const [state, formAction] = useFormState<UpdateDisplayNumberState, FormData>(
    action,
    initialUpdateDisplayNumberState,
  );

  return (
    <form action={formAction} className="detail-form">
      <div className="detail-form__grid">
        <div className="detail-form__field">
          <label htmlFor="displayNumber">Номер станка</label>
          <input
            id="displayNumber"
            name="displayNumber"
            type="text"
            maxLength={16}
            defaultValue={equipment.displayNumber ?? ''}
            placeholder="например, 1"
            autoComplete="off"
            style={{ fontWeight: 600 }}
          />
          <span className="detail-form__hint">
            Оставьте пустым, чтобы сбросить номер.
          </span>
        </div>
      </div>

      <div className="detail-form__actions">
        <SaveDisplayNumberButton />
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
          </span>
        </div>
      )}
      {state.ok && (
        <div className="detail-form__success" role="status">
          <Icon name="success" size={16} />
          <span>Номер сохранён.</span>
        </div>
      )}
    </form>
  );
}

/**
 * Чек-лист операций для конкретного оборудования.
 *
 * Источник истины — backend (`PATCH /api/equipment/:id/operations`).
 * Порядок операций в DOM = порядок sortOrder в БД (sortOrder
 * вычисляется индексом массива * 10, см. `EquipmentService.updateOperations`).
 *
 * Изначально предотмеченными показываются операции из
 * `equipment.allowedOperations` (только те, что `isActive=true`),
 * остальные операции из меты — неотмеченные. Все вместе образуют
 * чек-лист, в котором SHOP_MANAGER одной кнопкой переопределяет набор.
 */
export function EquipmentOperationsEditor({ equipment, operations }: Props) {
  const action = updateEquipmentOperationsAction.bind(null, equipment.id);
  const [state, formAction] = useFormState<UpdateOperationsState, FormData>(
    action,
    initialUpdateOperationsState,
  );

  const initiallyChecked = useMemo(
    () => new Set(equipment.allowedOperations.map((l) => l.operationId)),
    [equipment.allowedOperations],
  );
  const [checked, setChecked] = useState<Record<string, boolean>>(() => {
    const out: Record<string, boolean> = {};
    for (const op of operations) out[op.id] = initiallyChecked.has(op.id);
    return out;
  });

  const sortedOperations = useMemo(
    () => [...operations].sort((a, b) => a.sortOrder - b.sortOrder),
    [operations],
  );

  const checkedCount = sortedOperations.filter((op) => checked[op.id]).length;

  return (
    <form action={formAction} className="detail-form">
      <div className="detail-form__hint">
        <span>
          Включено: <strong>{checkedCount}</strong> из{' '}
          {sortedOperations.length}
        </span>
        {checkedCount === 0 && (
          <span style={{ marginLeft: '0.5rem', color: 'var(--color-warn-fg)' }}>
            <Icon name="warning" size={14} /> Без операций швея не сможет начать
            смену на этом станке.
          </span>
        )}
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
          </span>
        </div>
      )}
      {state.ok && (
        <div className="detail-form__success" role="status">
          <Icon name="success" size={16} />
          <span>
            Сохранено. /work подхватит изменения при следующем старте смены.
          </span>
        </div>
      )}

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
                <input type="hidden" name="operationOrder" value={op.id} />
                <span className="option-list__row-name">{op.name}</span>
                <span className="option-list__row-meta">
                  <code>{op.code}</code> · {op.category.toLowerCase()}
                </span>
              </label>
            </li>
          );
        })}
      </ul>

      <div className="detail-form__actions">
        <SaveOperationsButton />
      </div>
    </form>
  );
}
