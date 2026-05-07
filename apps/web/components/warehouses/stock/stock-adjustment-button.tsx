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
 *
 * Кнопка ОДНА для пользователя, но под капотом обслуживает оба
 * контура — материалы (`POST /api/stock/adjustments`) и готовую
 * продукцию (`POST /api/finished-goods/adjustments`). Diff делается
 * в самом диалоге по `kind` выбранного остатка.
 */

import { useState } from 'react';
import { Pencil } from 'lucide-react';
import { StockAdjustmentDialog } from './stock-adjustment-dialog';
import type { StockBalanceListItem } from '@/lib/stock-api';
import type { FinishedGoodsBalanceListItem } from '@/lib/finished-goods-api';

interface Props {
  materialBalances: StockBalanceListItem[];
  finishedGoodsBalances: FinishedGoodsBalanceListItem[];
}

export function StockAdjustmentButton({
  materialBalances,
  finishedGoodsBalances,
}: Props) {
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
        <div id="stock-adjustment-dialog" style={{ marginTop: 12 }}>
          <StockAdjustmentDialog
            materialBalances={materialBalances}
            finishedGoodsBalances={finishedGoodsBalances}
            onClose={() => setOpen(false)}
          />
        </div>
      )}
    </>
  );
}
