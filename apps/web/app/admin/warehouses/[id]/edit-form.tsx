'use client';

import { useTransition } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import type { CellDetailDto } from '@sewing/shared/passports';
import type { WarehouseDetailDto } from '@sewing/shared/warehouses';
import { Icon } from '@/components/icon';
import {
  assignCellToWarehouseAction,
  createWarehouseLineAction,
  detachCellFromWarehouseAction,
  updateWarehouseAction,
} from '../actions';
import {
  initialAssignCellState,
  initialCreateLineState,
  initialUpdateWarehouseState,
  type AssignCellState,
  type CreateLineState,
  type UpdateWarehouseState,
} from '../form-state';

function SaveButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      <Icon name="save" size={16} />
      {pending ? 'Сохраняем…' : label}
    </button>
  );
}

/**
 * Форма редактирования name/code/isActive склада.
 *
 * Источник истины — `PATCH /api/warehouses/:id`. Уникальность name и
 * code валидируется на backend (бизнес-ошибки `WAREHOUSE_NAME_TAKEN` /
 * `WAREHOUSE_CODE_TAKEN`), фронт лишь показывает текст ошибки.
 */
export function WarehouseEditForm({
  warehouse,
}: {
  warehouse: WarehouseDetailDto;
}) {
  const action = updateWarehouseAction.bind(null, warehouse.id);
  const [state, formAction] = useFormState<UpdateWarehouseState, FormData>(
    action,
    initialUpdateWarehouseState,
  );

  return (
    <form action={formAction} className="detail-form">
      <div className="detail-form__grid">
        <div className="detail-form__field">
          <label htmlFor="wh-name">Название</label>
          <input
            id="wh-name"
            name="name"
            type="text"
            maxLength={120}
            defaultValue={warehouse.name}
            required
            autoComplete="off"
          />
        </div>

        <div className="detail-form__field">
          <label htmlFor="wh-code">Код</label>
          <input
            id="wh-code"
            name="code"
            type="text"
            maxLength={32}
            defaultValue={warehouse.code ?? ''}
            autoComplete="off"
            placeholder="например, MAIN"
          />
        </div>

        <div className="detail-form__field detail-form__field--inline">
          <input
            id="wh-active"
            type="checkbox"
            name="isActive"
            defaultChecked={warehouse.isActive}
          />
          <label htmlFor="wh-active">Активен</label>
        </div>
      </div>

      <div className="detail-form__field">
        <label htmlFor="wh-label-template">
          Шаблон печатной формы наклейки (опционально)
        </label>
        <textarea
          id="wh-label-template"
          name="labelTemplate"
          rows={4}
          maxLength={4000}
          defaultValue={warehouse.labelTemplate ?? ''}
          autoComplete="off"
          placeholder='Например: {"size":"A6","logo":true} или произвольный шаблон'
          style={{
            fontFamily:
              'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            fontSize: '0.85rem',
          }}
        />
        <span className="detail-form__hint">
          Произвольный текст или JSON. Используется на печатных этикетках QR
          ячеек.
        </span>
      </div>

      <div className="detail-form__actions">
        <SaveButton label="Сохранить склад" />
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
          <span>Склад сохранён.</span>
        </div>
      )}
    </form>
  );
}

/**
 * Форма привязки ячейки к складу. Список `availableCells` приходит
 * с сервера (страница исключает уже привязанные к этому складу).
 *
 * Если ячейка уже привязана к другому складу, рядом со значением
 * select-а показываем имя того склада — менеджер должен видеть, что
 * привязка явно переедет.
 */
export function AssignCellForm({
  warehouseId,
  availableCells,
}: {
  warehouseId: string;
  availableCells: CellDetailDto[];
}) {
  const action = assignCellToWarehouseAction.bind(null, warehouseId);
  const [state, formAction] = useFormState<AssignCellState, FormData>(
    action,
    initialAssignCellState,
  );

  if (availableCells.length === 0) {
    return (
      <div className="empty-state">
        <span className="empty-state__icon">
          <Icon name="warehouses" />
        </span>
        <span className="empty-state__title">Все ячейки уже здесь</span>
        <span className="empty-state__hint">
          Все активные ячейки уже привязаны к этому складу. Создайте новые
          ячейки в seed/админке БД, либо отвяжите ячейку от другого склада.
        </span>
      </div>
    );
  }

  return (
    <form action={formAction} className="detail-form">
      <div className="detail-form__grid">
        <div className="detail-form__field" style={{ gridColumn: '1 / -1' }}>
          <label htmlFor="cell-select">Ячейка</label>
          <select
            id="cell-select"
            name="cellId"
            required
            defaultValue=""
          >
            <option value="" disabled>
              — выберите ячейку —
            </option>
            {availableCells.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code}
                {c.warehouse
                  ? ` — переедет из «${c.warehouse.name}»`
                  : ' — без склада'}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="detail-form__actions">
        <SaveButton label="Привязать" />
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
          <span>Ячейка привязана.</span>
        </div>
      )}
    </form>
  );
}

/**
 * Маленькая кнопка «Отвязать» рядом с ячейкой склада. Использует
 * `useTransition`, чтобы не блокировать UI пока идёт server action.
 * Сама ячейка остаётся существовать — отвязка лишь обнуляет
 * `Cell.warehouseId` (см. ADR-0019).
 */
export function DetachCellButton({
  warehouseId,
  cellId,
}: {
  warehouseId: string;
  cellId: string;
}) {
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      className="btn btn-danger"
      disabled={pending}
      onClick={() => {
        startTransition(async () => {
          await detachCellFromWarehouseAction(warehouseId, cellId);
        });
      }}
      title="Отвязать ячейку от склада (сама ячейка останется существовать)"
    >
      <Icon name="reset" size={14} />
      {pending ? 'Отвязываем…' : 'Отвязать'}
    </button>
  );
}

/**
 * Форма массового создания ячеек через линию.
 *
 * Менеджер вводит код линии (например, `A`) и количество (например, 20),
 * backend создаёт `WarehouseLine` и в той же транзакции — ячейки
 * `A1..A20`. После успеха показывается короткий summary, страница
 * сама ревалидируется action-ом и подгружает новые ячейки.
 *
 * Источник истины — `POST /api/warehouses/:id/lines`. Уникальность
 * `code` глобальная (см. ADR/миграция), коллизии с уже существующими
 * `Cell.code` тоже валидируются на backend (понятная бизнес-ошибка
 * `WAREHOUSE_LINE_CELL_CODE_TAKEN`).
 */
export function CreateLineForm({
  warehouseId,
}: {
  warehouseId: string;
}) {
  const action = createWarehouseLineAction.bind(null, warehouseId);
  const [state, formAction] = useFormState<CreateLineState, FormData>(
    action,
    initialCreateLineState,
  );

  return (
    <form action={formAction} className="detail-form">
      <div className="detail-form__grid">
        <div className="detail-form__field">
          <label htmlFor="line-code">Код линии</label>
          <input
            id="line-code"
            name="code"
            type="text"
            maxLength={32}
            required
            autoComplete="off"
            placeholder="например, A"
          />
        </div>
        <div className="detail-form__field">
          <label htmlFor="line-count">Кол-во ячеек</label>
          <input
            id="line-count"
            name="count"
            type="number"
            min={1}
            max={200}
            required
            defaultValue={20}
          />
        </div>
      </div>

      <div className="detail-form__actions">
        <SaveButton label="Создать линию" />
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
      {state.ok && state.successMessage && (
        <div className="detail-form__success" role="status">
          <Icon name="success" size={16} />
          <span>{state.successMessage}</span>
        </div>
      )}
    </form>
  );
}
