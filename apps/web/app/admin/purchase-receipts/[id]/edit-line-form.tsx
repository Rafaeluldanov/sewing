'use client';

/**
 * Inline-форма правки одной строки приёмки (`PATCH
 * /api/purchase-receipts/:id/lines/:lineId`).
 *
 * Состав полей зависит от статуса документа:
 *   - `DRAFT`  (`editableStock = true`)  — можно менять количество и
 *     ячейку + все метаданные;
 *   - `POSTED` (`editableStock = false`) — только нескладские
 *     метаданные (количество/ячейка уже отражены на складе).
 *
 * Завёрнута в `<details>`, чтобы не раздувать карточку: по умолчанию
 * свёрнута, разворачивается по клику на строку.
 */

import { useFormState, useFormStatus } from 'react-dom';
import { Save } from 'lucide-react';
import type { PurchaseReceiptLineDto } from '@sewing/shared/purchase-receipts';
import { updatePurchaseReceiptLineAction } from '../actions';
import { initialUpdatePurchaseReceiptLineState } from '../form-state';
import { CreatableSelect } from '@/components/admin/ref-create/creatable-select';

interface CellOption {
  id: string;
  code: string;
  warehouseName: string | null;
}

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="admin-btn" disabled={pending}>
      <Save size={16} strokeWidth={1.6} aria-hidden />
      {pending ? 'Сохраняем…' : 'Сохранить строку'}
    </button>
  );
}

export function EditPurchaseReceiptLineForm({
  receiptId,
  line,
  editableStock,
  cells,
}: {
  receiptId: string;
  line: PurchaseReceiptLineDto;
  editableStock: boolean;
  cells: CellOption[];
}) {
  const [state, action] = useFormState(
    updatePurchaseReceiptLineAction.bind(null, receiptId, line.id),
    initialUpdatePurchaseReceiptLineState,
  );

  return (
    <details
      className="admin-card"
      style={{ padding: 12, display: 'block', boxShadow: 'none' }}
    >
      <summary style={{ cursor: 'pointer' }}>
        <strong>{line.itemNameSnapshot}</strong>{' '}
        <span className="admin-muted" style={{ fontSize: '0.85rem' }}>
          — {line.receivedQty} {line.unit}
          {line.cellCode ? ` · ${line.cellCode}` : ''}
        </span>
      </summary>

      <form action={action} className="admin-stack" style={{ marginTop: 12 }}>
        <div className="admin-form-grid">
          {editableStock && (
            <>
              <div className="admin-field">
                <label htmlFor={`pr-qty-${line.id}`}>
                  Принято ({line.unit})
                </label>
                <input
                  id={`pr-qty-${line.id}`}
                  name="receivedQty"
                  type="text"
                  inputMode="decimal"
                  defaultValue={line.receivedQty}
                  autoComplete="off"
                />
              </div>
              <div className="admin-field">
                <label htmlFor={`pr-cell-${line.id}`}>Ячейка</label>
                <CreatableSelect
                  entity="warehouseCell"
                  id={`pr-cell-${line.id}`}
                  name="cellId"
                  defaultValue={line.cellId ?? ''}
                  existingValues={cells.map((c) => c.id)}
                >
                  <option value="">Не указана</option>
                  {cells.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.code}
                      {c.warehouseName ? ` · ${c.warehouseName}` : ''}
                    </option>
                  ))}
                </CreatableSelect>
              </div>
            </>
          )}
          <div className="admin-field">
            <label htmlFor={`pr-batch-${line.id}`}>Партия</label>
            <input
              id={`pr-batch-${line.id}`}
              name="batchNumber"
              type="text"
              maxLength={200}
              defaultValue={line.batchNumber ?? ''}
            />
          </div>
          <div className="admin-field">
            <label htmlFor={`pr-roll-${line.id}`}>Рулон</label>
            <input
              id={`pr-roll-${line.id}`}
              name="rollNumber"
              type="text"
              maxLength={200}
              defaultValue={line.rollNumber ?? ''}
            />
          </div>
          <div className="admin-field">
            <label htmlFor={`pr-shade-${line.id}`}>Оттенок</label>
            <input
              id={`pr-shade-${line.id}`}
              name="shade"
              type="text"
              maxLength={200}
              defaultValue={line.shade ?? ''}
            />
          </div>
          <div className="admin-field">
            <label htmlFor={`pr-width-${line.id}`}>Ширина (см)</label>
            <input
              id={`pr-width-${line.id}`}
              name="actualWidthCm"
              type="number"
              min={0}
              step={1}
              defaultValue={line.actualWidthCm ?? ''}
            />
          </div>
          <div className="admin-field">
            <label htmlFor={`pr-density-${line.id}`}>Плотность (г/м²)</label>
            <input
              id={`pr-density-${line.id}`}
              name="actualDensityGsm"
              type="number"
              min={0}
              step={1}
              defaultValue={line.actualDensityGsm ?? ''}
            />
          </div>
          <div className="admin-field" style={{ gridColumn: '1 / -1' }}>
            <label htmlFor={`pr-loc-${line.id}`}>Доп. место хранения</label>
            <input
              id={`pr-loc-${line.id}`}
              name="locationNote"
              type="text"
              maxLength={200}
              defaultValue={line.locationNote ?? ''}
            />
          </div>
          <div className="admin-field" style={{ gridColumn: '1 / -1' }}>
            <label htmlFor={`pr-comment-${line.id}`}>Комментарий</label>
            <input
              id={`pr-comment-${line.id}`}
              name="comment"
              type="text"
              maxLength={1000}
              defaultValue={line.comment ?? ''}
            />
          </div>
        </div>

        {state.error && (
          <div className="error-box" role="alert">
            {state.error}
            {state.errorRequestId ? ` [${state.errorRequestId}]` : ''}
          </div>
        )}
        {state.successMessage && (
          <div className="success-box" role="status">
            {state.successMessage}
          </div>
        )}

        <div className="admin-actions-row">
          <SaveButton />
        </div>
      </form>
    </details>
  );
}
