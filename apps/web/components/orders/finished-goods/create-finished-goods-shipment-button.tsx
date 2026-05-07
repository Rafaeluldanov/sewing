'use client';

/**
 * `CreateFinishedGoodsShipmentButton` — client-wrapper над
 * `CreateFinishedGoodsShipmentDialog`. Нужен, чтобы серверная
 * `OrderFinishedGoodsShipmentSection` могла показать кнопку «Создать
 * отгрузку» и развернуть inline-форму без модальных окон / отдельных
 * страниц (тот же паттерн, что у `CreateMaterialIssueButton`).
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

  if (open) {
    return (
      <CreateFinishedGoodsShipmentDialog
        orderId={orderId}
        balances={balances}
        onClose={() => setOpen(false)}
      />
    );
  }

  return (
    <button
      type="button"
      className="admin-btn admin-btn--primary"
      onClick={() => setOpen(true)}
      data-testid="create-finished-goods-shipment-button"
    >
      <Truck size={16} strokeWidth={1.6} aria-hidden />
      Создать отгрузку
    </button>
  );
}
