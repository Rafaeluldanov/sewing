'use client';

/**
 * `StockTransferButton` — кнопка «Переместить» вверху вкладки
 * «Остатки» в `/admin/warehouses?tab=balances`. Отвечает за
 * `open / close`-переключение `StockTransferDialog`.
 *
 * UI-решение владельца проекта (см. ТЗ):
 *   - размещаем именно над таблицей остатков, в существующем разделе;
 *   - НЕ создаём новую страницу `/admin/stock-transfer`;
 *   - НЕ добавляем пункт в sidebar;
 *   - dialog inline (без модала) — тот же паттерн, что у
 *     `StockAdjustmentDialog`.
 */

import { useState } from 'react';
import { ArrowRightLeft } from 'lucide-react';
import { StockTransferDialog } from './stock-transfer-dialog';
import type { StockBalanceListItem } from '@/lib/stock-api';
import type { WarehouseSummaryDto } from '@sewing/shared/warehouses';

interface Props {
  balances: StockBalanceListItem[];
  warehouses: WarehouseSummaryDto[];
}

export function StockTransferButton({ balances, warehouses }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="admin-btn"
        onClick={() => setOpen(true)}
        aria-expanded={open}
        aria-controls="stock-transfer-dialog"
        disabled={open}
      >
        <ArrowRightLeft size={16} strokeWidth={1.6} aria-hidden />
        Переместить
      </button>
      {open && (
        <div id="stock-transfer-dialog" style={{ marginTop: 12 }}>
          <StockTransferDialog
            balances={balances}
            warehouses={warehouses}
            onClose={() => setOpen(false)}
          />
        </div>
      )}
    </>
  );
}
