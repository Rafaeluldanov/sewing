'use client';

/**
 * `StockAdjustmentButton` — кнопка «Корректировка» вверху вкладки
 * «Остатки» в `/admin/warehouses?tab=balances`. Отвечает за
 * `open / close`-переключение `StockAdjustmentDialog`.
 *
 * UI-решение владельца проекта (см. ТЗ):
 *   - размещаем именно над таблицей остатков, в существующем разделе;
 *   - НЕ создаём новую страницу `/admin/stock-adjustments`;
 *   - НЕ добавляем пункт в sidebar;
 *   - dialog inline (без модала) — тот же паттерн, что у
 *     `CreateMaterialIssueDialog`.
 */

import { useState } from 'react';
import { Pencil } from 'lucide-react';
import { StockAdjustmentDialog } from './stock-adjustment-dialog';
import type { StockBalanceListItem } from '@/lib/stock-api';

interface Props {
  balances: StockBalanceListItem[];
}

export function StockAdjustmentButton({ balances }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="admin-btn"
        onClick={() => setOpen(true)}
        aria-expanded={open}
        aria-controls="stock-adjustment-dialog"
        disabled={open}
      >
        <Pencil size={16} strokeWidth={1.6} aria-hidden />
        Корректировка
      </button>
      {open && (
        <div
          id="stock-adjustment-dialog"
          style={{ marginTop: 12 }}
        >
          <StockAdjustmentDialog
            balances={balances}
            onClose={() => setOpen(false)}
          />
        </div>
      )}
    </>
  );
}
