'use client';

import { useEffect, useState, type FormEvent } from 'react';
import {
  WAREHOUSE_LINE_MAX_COUNT,
  type WarehouseSummaryDto,
} from '@sewing/shared/warehouses';
import { AdminModal } from '../admin-modal';
import { RefModalForm } from './ref-modal-form';
import {
  createWarehouseCellsInlineAction,
  loadWarehousesForCellsAction,
} from './actions';
import type { CreatedWarehouseCells, RefCreateContext } from './types';

/**
 * «＋ Добавить ячейки» из select-а ячейки. Ячейки создаются только
 * линией (`POST /warehouses/:id/lines`) — заводим линию с N ячейками,
 * хост автоматически выбирает первую.
 *
 * Если хост уже знает склад (`context.lockWarehouse`) — селект склада
 * скрыт; иначе список складов подгружается при открытии.
 */
export function CreateWarehouseCellsModal({
  context,
  zIndex,
  onCancel,
  onCreated,
}: {
  context?: RefCreateContext;
  zIndex?: number;
  onCancel: () => void;
  onCreated: (dto: CreatedWarehouseCells) => void;
}) {
  const locked = Boolean(context?.lockWarehouse && context.warehouseId);
  const [warehouseId, setWarehouseId] = useState(context?.warehouseId ?? '');
  const [warehouses, setWarehouses] = useState<WarehouseSummaryDto[] | null>(
    null,
  );
  const [code, setCode] = useState('');
  const [count, setCount] = useState('1');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (locked) return;
    let cancelled = false;
    loadWarehousesForCellsAction().then((result) => {
      if (cancelled) return;
      if (!result.ok || !result.dto) {
        setError(result.error ?? 'Не удалось загрузить список складов');
        return;
      }
      setWarehouses(result.dto);
    });
    return () => {
      cancelled = true;
    };
  }, [locked]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const result = await createWarehouseCellsInlineAction(warehouseId, {
      code,
      count: Number(count),
    });
    setSubmitting(false);
    if (!result.ok || !result.dto) {
      setError(result.error ?? 'Не удалось создать ячейки');
      return;
    }
    const warehouseName = locked
      ? (context?.warehouseName ?? null)
      : (warehouses?.find((w) => w.id === warehouseId)?.name ?? null);
    onCreated({ ...result.dto, warehouseId, warehouseName });
  }

  return (
    <AdminModal
      title="Новые ячейки"
      subtitle="Ячейки создаются линией: код + количество. Печать QR — в карточке склада."
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
        {locked ? (
          <div className="admin-field">
            <label>Склад</label>
            <input
              type="text"
              value={context?.warehouseName ?? 'Выбранный склад'}
              disabled
            />
          </div>
        ) : (
          <div className="admin-field">
            <label htmlFor="ref-cells-warehouse">Склад</label>
            <select
              id="ref-cells-warehouse"
              required
              value={warehouseId}
              onChange={(e) => setWarehouseId(e.target.value)}
            >
              <option value="">
                {warehouses === null ? 'Загрузка…' : '— выберите склад —'}
              </option>
              {(warehouses ?? []).map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="admin-field">
          <label htmlFor="ref-cells-code">Код линии</label>
          <input
            id="ref-cells-code"
            type="text"
            required
            autoFocus
            maxLength={32}
            placeholder="Например: A1"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </div>
        <div className="admin-field">
          <label htmlFor="ref-cells-count">Количество ячеек</label>
          <input
            id="ref-cells-count"
            type="number"
            required
            min={1}
            max={WAREHOUSE_LINE_MAX_COUNT}
            step={1}
            value={count}
            onChange={(e) => setCount(e.target.value)}
          />
        </div>
      </RefModalForm>
    </AdminModal>
  );
}
