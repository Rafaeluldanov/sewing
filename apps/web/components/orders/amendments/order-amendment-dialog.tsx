'use client';

/**
 * `OrderAmendmentDialog` — модальная оболочка «Изменить заказ в
 * производстве» (фича `FEATURE_ORDER_AMENDMENTS`). Одна точка входа с
 * вкладками:
 *   - «Количество» (ФАЗА 1) — правка планового тиража по размерам;
 *   - «Размерность» (ФАЗА 2) — добавить/убрать размер;
 *   - «Маршрут» (ФАЗА 3.1) — состав и порядок операций впереди фронта.
 *
 * Оболочка (overlay/шапка/переключатель вкладок/CSS) — здесь; логика
 * форм — в `QuantityAmendmentTab` / `SizeAmendmentTab` /
 * `RouteAmendmentTab`. Паттерн окна — как
 * `create-finished-goods-shipment-dialog`.
 *
 * Вкладке «Маршрут» нужен холст с цепочкой и палитрой операций, поэтому
 * на ней окно расширяется (`amend-window--wide`); остальные вкладки
 * остаются узкими.
 */

import { useState } from 'react';
import { SlidersHorizontal, X } from 'lucide-react';
import type {
  OperationAmendmentStateDto,
  QuantityAmendmentStateDto,
  SizeAmendmentStateDto,
} from '@sewing/shared';
import { ModalPortal } from '@/components/modal-portal';
import { QuantityAmendmentTab } from './quantity-amendment-tab';
import { SizeAmendmentTab } from './size-amendment-tab';
import { RouteAmendmentTab } from './route-amendment-tab';

interface Props {
  orderId: string;
  quantityState: QuantityAmendmentStateDto;
  sizeState: SizeAmendmentStateDto;
  operationState: OperationAmendmentStateDto;
  onClose: () => void;
}

type TabKey = 'qty' | 'sizes' | 'route';

export function OrderAmendmentDialog({
  orderId,
  quantityState,
  sizeState,
  operationState,
  onClose,
}: Props) {
  const [tab, setTab] = useState<TabKey>('qty');

  return (
    <ModalPortal>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Изменить заказ в производстве"
        className="amend-overlay"
        onClick={onClose}
      >
        <div
          className={`amend-window${tab === 'route' ? ' amend-window--wide' : ''}`}
          onClick={(e) => e.stopPropagation()}
        >
          <header className="amend-header">
            <h2>
              <SlidersHorizontal size={18} strokeWidth={1.7} aria-hidden />{' '}
              Изменить заказ в производстве
            </h2>
            <button
              type="button"
              className="amend-icon-btn"
              onClick={onClose}
              aria-label="Закрыть"
            >
              <X size={18} strokeWidth={1.7} aria-hidden />
            </button>
          </header>

          <div className="amend-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'qty'}
              className={`amend-tab${tab === 'qty' ? ' amend-tab--active' : ''}`}
              onClick={() => setTab('qty')}
            >
              Количество
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'sizes'}
              className={`amend-tab${tab === 'sizes' ? ' amend-tab--active' : ''}`}
              onClick={() => setTab('sizes')}
            >
              Размерность
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'route'}
              className={`amend-tab${tab === 'route' ? ' amend-tab--active' : ''}`}
              onClick={() => setTab('route')}
              data-testid="amend-tab-route"
            >
              Маршрут
            </button>
          </div>

          <div className="amend-body">
            {tab === 'qty' && (
              <QuantityAmendmentTab
                orderId={orderId}
                state={quantityState}
                onClose={onClose}
              />
            )}
            {tab === 'sizes' && (
              <SizeAmendmentTab
                orderId={orderId}
                state={sizeState}
                onClose={onClose}
              />
            )}
            {tab === 'route' && (
              <RouteAmendmentTab
                orderId={orderId}
                state={operationState}
                onClose={onClose}
              />
            )}
          </div>
        </div>
      </div>

      <style>{`
        .amend-overlay {
          position: fixed; inset: 0; z-index: 1000;
          background: rgba(15, 23, 42, 0.45);
          display: flex; align-items: flex-start; justify-content: center;
          padding: 4vh 16px; overflow-y: auto;
        }
        .amend-window {
          background: #fff; border-radius: 10px; width: 100%; max-width: 640px;
          box-shadow: 0 20px 50px rgba(15, 23, 42, 0.25);
          display: flex; flex-direction: column;
        }
        /* Вкладка «Маршрут»: цепочка + палитра операций рядом. */
        .amend-window--wide { max-width: 1040px; }
        .amend-header {
          display: flex; justify-content: space-between; align-items: center;
          padding: 14px 16px; border-bottom: 1px solid #e2e8f0;
        }
        .amend-header h2 { margin: 0; font-size: 1.05rem; color: #0f172a; }
        .amend-icon-btn {
          background: transparent; border: none; cursor: pointer;
          padding: 4px; border-radius: 4px; color: #475569;
        }
        .amend-icon-btn:hover { background: #f1f5f9; }
        .amend-tabs {
          display: flex; gap: 4px; padding: 8px 16px 0;
          border-bottom: 1px solid #e2e8f0;
        }
        .amend-tab {
          background: transparent; border: none; cursor: pointer;
          padding: 8px 12px; font-size: 0.92rem; color: #475569;
          border-bottom: 2px solid transparent; border-radius: 4px 4px 0 0;
        }
        .amend-tab:hover { background: #f8fafc; }
        .amend-tab--active { color: #0f172a; font-weight: 600; border-bottom-color: #ffd23f; }
        .amend-body { padding: 16px; }
        .amend-table { margin-bottom: 12px; }
        .amend-subhead { font-size: 0.9rem; font-weight: 600; color: #0f172a; margin-bottom: 6px; }
        .amend-summary { font-size: 0.9rem; color: #0f172a; margin-bottom: 8px; }
        .amend-hint--bad { color: #b91c1c; }
        .amend-foot { margin-left: auto; font-size: 0.82rem; max-width: 280px; text-align: right; }
        .amend-note {
          display: flex; gap: 6px; align-items: flex-start;
          font-size: 0.88rem; padding: 8px 10px; border-radius: 6px;
          margin-bottom: 10px;
        }
        .amend-note--info { background: #eff6ff; color: #1e40af; }
        .amend-note--warn { background: #fffbeb; color: #92400e; }
        .amend-note--ok { background: #ecfdf5; color: #065f46; }
        .amend-note--bad { background: #fef2f2; color: #b91c1c; }
      `}</style>
    </ModalPortal>
  );
}
