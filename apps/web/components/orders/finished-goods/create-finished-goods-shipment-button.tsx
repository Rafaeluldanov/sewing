'use client';

/**
 * `CreateFinishedGoodsShipmentButton` — кнопка «Создать отгрузку»,
 * которая открывает модальное окно `CreateFinishedGoodsShipmentDialog`.
 * Живёт в правом верхнем углу карточки «Производство по размерам»
 * (вкладка «Производство» карточки заказа). Раньше кнопка раскрывала
 * inline-форму внутри отдельного блока «Отгрузка готовой продукции» —
 * блок убран, форма переехала в overlay-модалку.
 */
import { useState } from 'react';
import { Truck } from 'lucide-react';
import type { FinishedGoodsBalanceListItem } from '@/lib/finished-goods-api';
import { CreateFinishedGoodsShipmentDialog } from './create-finished-goods-shipment-dialog';

interface Props {
  orderId: string;
  balances: FinishedGoodsBalanceListItem[];
}

export function CreateFinishedGoodsShipmentButton({
  orderId,
  balances,
}: Props) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className="admin-btn admin-btn--primary"
        onClick={() => setOpen(true)}
        data-testid="create-finished-goods-shipment-button"
      >
        <Truck size={16} strokeWidth={1.6} aria-hidden />
        Создать отгрузку
      </button>
      {open && (
        <CreateFinishedGoodsShipmentDialog
          orderId={orderId}
          balances={balances}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
