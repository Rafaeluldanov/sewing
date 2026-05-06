'use client';

import { useState, useTransition } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import {
  AlertCircle,
  Check,
  Save,
  Trash2,
  Unlink,
  Warehouse,
} from 'lucide-react';
import type { CellDetailDto } from '@sewing/shared/passports';
import type { WarehouseDetailDto } from '@sewing/shared/warehouses';
import { AdminEmptyState } from '@/components/admin';
import {
  assignCellToWarehouseAction,
  createWarehouseLineAction,
  deleteWarehouseLineAction,
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
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending}
    >
      <Save size={16} strokeWidth={1.6} aria-hidden />
      {pending ? 'Сохраняем…' : label}
    </button>
  );
}

function ErrorBox({
  error,
  errorRequestId,
}: {
  error?: string | null;
  errorRequestId?: string | null;
}) {
  if (!error) return null;
  return (
    <div className="error-box" role="alert">
      <div className="error-box__msg">
        <AlertCircle size={14} strokeWidth={1.6} aria-hidden /> {error}
      </div>
      {errorRequestId && (
        <div className="error-box__rid">
          req: <code>{errorRequestId}</code>
        </div>
      )}
    </div>
  );
}

function SuccessBox({ message }: { message: string }) {
  return (
    <div className="success-box" role="status">
      <Check size={14} strokeWidth={1.6} aria-hidden /> {message}
    </div>
  );
}

/**
 * Форма редактирования name/code/isActive склада (Admin UI 2.6).
 *
 * Backend не меняем — `PATCH /api/warehouses/:id`. Уникальность name и
 * code валидируется на backend (`WAREHOUSE_NAME_TAKEN` /
 * `WAREHOUSE_CODE_TAKEN`).
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
    <form action={formAction} className="admin-form">
      <div className="admin-form-grid">
        <div className="admin-field">
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

        <div className="admin-field">
          <label htmlFor="wh-code">Код</label>
          <input
            id="wh-code"
            name="code"
            type="text"
            maxLength={32}
            defaultValue={warehouse.code ?? ''}
            autoComplete="off"
            placeholder="MAIN"
          />
        </div>

        <div className="admin-field admin-field--inline">
          <input
            id="wh-active"
            type="checkbox"
            name="isActive"
            defaultChecked={warehouse.isActive}
          />
          <label htmlFor="wh-active">Активен</label>
        </div>
      </div>

      <div className="admin-field">
        <label htmlFor="wh-label-template">Шаблон этикетки QR (опц.)</label>
        <textarea
          id="wh-label-template"
          name="labelTemplate"
          rows={3}
          maxLength={4000}
          defaultValue={warehouse.labelTemplate ?? ''}
          autoComplete="off"
          placeholder='Например: {"size":"A6","logo":true}'
          style={{
            fontFamily:
              'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            fontSize: '0.85rem',
          }}
        />
      </div>

      <div className="admin-actions-row">
        <SaveButton label="Сохранить" />
      </div>

      <ErrorBox error={state.error} errorRequestId={state.errorRequestId} />
      {state.ok && <SuccessBox message="Склад сохранён." />}
    </form>
  );
}

/**
 * Форма привязки ячейки к складу. Список `availableCells` приходит
 * с сервера (страница исключает уже привязанные к этому складу).
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
      <AdminEmptyState
        icon={<Warehouse size={26} strokeWidth={1.6} aria-hidden />}
        title="Все ячейки уже здесь"
        hint="Создайте новые ячейки или отвяжите от другого склада."
      />
    );
  }

  return (
    <form action={formAction} className="admin-form">
      <div className="admin-field">
        <label htmlFor="cell-select">Ячейка</label>
        <select id="cell-select" name="cellId" required defaultValue="">
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

      <div className="admin-actions-row">
        <SaveButton label="Привязать" />
      </div>

      <ErrorBox error={state.error} errorRequestId={state.errorRequestId} />
      {state.ok && <SuccessBox message="Ячейка привязана." />}
    </form>
  );
}

/**
 * Маленькая кнопка «Отвязать» рядом с ячейкой склада. Отвязка лишь
 * обнуляет `Cell.warehouseId` (см. ADR-0019), сама ячейка остаётся.
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
      className="admin-btn admin-btn--ghost"
      disabled={pending}
      onClick={() => {
        startTransition(async () => {
          await detachCellFromWarehouseAction(warehouseId, cellId);
        });
      }}
      title="Отвязать ячейку (сама ячейка останется)"
    >
      <Unlink size={14} strokeWidth={1.6} aria-hidden />
      {pending ? 'Отвязываем…' : 'Отвязать'}
    </button>
  );
}

/**
 * Форма массового создания ячеек через линию (`POST
 * /api/warehouses/:id/lines`). Backend сам делает `WarehouseLine` +
 * `Cell`-серию (`A1..A20`). Уникальность `code` глобальная,
 * коллизии — `WAREHOUSE_LINE_CELL_CODE_TAKEN`.
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
    <form action={formAction} className="admin-form">
      <div className="admin-form-grid">
        <div className="admin-field">
          <label htmlFor="line-code">Код линии</label>
          <input
            id="line-code"
            name="code"
            type="text"
            maxLength={32}
            required
            autoComplete="off"
            placeholder="A"
          />
        </div>
        <div className="admin-field">
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

      <div className="admin-actions-row">
        <SaveButton label="Создать линию" />
      </div>

      <ErrorBox error={state.error} errorRequestId={state.errorRequestId} />
      {state.ok && state.successMessage && (
        <SuccessBox message={state.successMessage} />
      )}
    </form>
  );
}

/**
 * Кнопка-«корзина» в строке таблицы линий. Удаляет линию вместе с
 * её ячейками — backend заблокирует операцию (`WAREHOUSE_LINE_HAS_CONTENT`),
 * если в ячейках есть содержимое/паспорта/остатки. Перед запросом
 * показываем нативный `confirm` с кодами линии и количества ячеек,
 * чтобы менеджер не ткнул случайно.
 *
 * Ошибка отображается мини-боксом под кнопкой (`absolute`-tooltip
 * не делаем — ошибка важная, пусть будет inline в строке таблицы).
 */
export function DeleteLineButton({
  warehouseId,
  lineId,
  lineCode,
  cellsCount,
}: {
  warehouseId: string;
  lineId: string;
  lineCode: string;
  cellsCount: number;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleClick() {
    const ok = window.confirm(
      `Удалить линию «${lineCode}» и все ${cellsCount} ячеек?\n\n` +
        'Удаление возможно только если в ячейках нет содержимого, ' +
        'паспортов и остатков.',
    );
    if (!ok) return;
    setError(null);
    startTransition(async () => {
      const res = await deleteWarehouseLineAction(warehouseId, lineId);
      if (!res.ok && res.error) {
        setError(res.error);
      }
    });
  }

  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 4 }}>
      <button
        type="button"
        className="admin-btn admin-btn--ghost"
        disabled={pending}
        onClick={handleClick}
        title={`Удалить линию «${lineCode}»`}
      >
        <Trash2 size={14} strokeWidth={1.6} aria-hidden />
        {pending ? 'Удаляем…' : 'Удалить'}
      </button>
      {error && (
        <span
          className="admin-muted"
          role="alert"
          style={{ color: 'var(--admin-danger, #c0392b)', fontSize: '0.78rem' }}
        >
          {error}
        </span>
      )}
    </span>
  );
}
