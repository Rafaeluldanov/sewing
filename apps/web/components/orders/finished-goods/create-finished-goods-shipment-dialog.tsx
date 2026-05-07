'use client';

/**
 * `CreateFinishedGoodsShipmentDialog` — форма создания документа
 * отгрузки готовой продукции по заказу
 * (`/admin/orders/[id]?tab=production`).
 *
 * UI-паттерн (см. `apps/web/components/orders/material-issues/create-material-issue-dialog.tsx`):
 *   - inline-форма поверх блока, без полноценного модального окна;
 *   - submit идёт через `useFormState` + server action
 *     `createFinishedGoodsShipmentAction`.
 *
 * Контракт ввода (см. ТЗ §10):
 *   - по каждому доступному `FinishedGoodsBalance` есть один input
 *     «отгрузить, шт» с `min=0` и `max=available`;
 *   - строки с `qty = 0` / пустые НЕ отправляются на backend (фильтр
 *     в server action и здесь UI-side);
 *   - duplicate невозможен: один input на баланс;
 *   - `clientRequestId` генерируется один раз через
 *     `crypto.randomUUID()` (повторный submit формы идемпотентен).
 *
 * После submit:
 *   - server action вернёт `ok: true` + `createdNumber`;
 *   - `revalidatePath('/admin/orders/[id]')` обновит балансы и
 *     историю отгрузок в RSC секции.
 */

import { useEffect, useMemo, useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import { CheckCircle, Truck, XCircle } from 'lucide-react';
import type { FinishedGoodsBalanceListItem } from '@/lib/finished-goods-api';
import {
  createFinishedGoodsShipmentAction,
  initialFinishedGoodsShipmentFormState,
} from '@/app/admin/orders/[id]/finished-goods-shipments-actions';

interface Props {
  orderId: string;
  balances: FinishedGoodsBalanceListItem[];
  /** Вызывается при закрытии формы (Cancel / успех). */
  onClose: () => void;
}

function formatBalanceName(b: FinishedGoodsBalanceListItem): string {
  const product = b.productName ?? b.productId;
  const size = b.sizeCode ?? b.sizeId;
  const parts: string[] = [];
  if (product) parts.push(product);
  if (b.color) parts.push(b.color);
  if (size) parts.push(size);
  return parts.join(' / ');
}

function makeUUID(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function SubmitButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  const isDisabled = pending || disabled;
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={isDisabled}
    >
      <CheckCircle size={16} strokeWidth={1.6} aria-hidden />
      {pending ? 'Отгружаем…' : 'Отгрузить'}
    </button>
  );
}

export function CreateFinishedGoodsShipmentDialog({
  orderId,
  balances,
  onClose,
}: Props) {
  const [shippedAt, setShippedAt] = useState<string>('');
  const [comment, setComment] = useState<string>('');
  // Map balanceId → строка ввода (контролируемый input). Пустая строка
  // / 0 → не отправляем строку на backend.
  const [qtyByBalance, setQtyByBalance] = useState<Record<string, string>>({});
  // ClientRequestId генерируется ОДИН раз на жизненный цикл формы —
  // повторный submit (двойной клик / network retry) идёт под одним
  // ключом и идемпотентен (см. `buildFinishedGoodsShipmentSourceKey`).
  const [clientRequestId] = useState<string>(() => makeUUID());

  const [state, formAction] = useFormState(
    createFinishedGoodsShipmentAction.bind(null, orderId),
    initialFinishedGoodsShipmentFormState,
  );

  useEffect(() => {
    if (state.ok) {
      // Закроем форму после успеха — RSC сам перерисует балансы и
      // таблицу отгрузок благодаря `revalidatePath`.
      onClose();
    }
  }, [state.ok, onClose]);

  const linesPayload = useMemo(() => {
    return balances
      .map((b) => {
        const raw = qtyByBalance[b.id];
        if (raw === undefined || raw.trim() === '') return null;
        const n = Number(raw.replace(',', '.'));
        if (!Number.isInteger(n) || n <= 0) return null;
        return { finishedGoodsBalanceId: b.id, qty: n };
      })
      .filter((entry): entry is { finishedGoodsBalanceId: string; qty: number } =>
        Boolean(entry),
      );
  }, [balances, qtyByBalance]);

  const totalQty = linesPayload.reduce((acc, l) => acc + l.qty, 0);
  const noLines = linesPayload.length === 0;
  const exceedsAvailable = balances.some((b) => {
    const raw = qtyByBalance[b.id];
    if (raw === undefined || raw.trim() === '') return false;
    const n = Number(raw.replace(',', '.'));
    if (!Number.isInteger(n)) return false;
    return n > b.qty;
  });

  const payload = JSON.stringify({
    shippedAt: shippedAt || undefined,
    comment: comment.trim() || undefined,
    clientRequestId,
    lines: linesPayload,
  });

  return (
    <form
      action={formAction}
      className="admin-form"
      data-testid="create-finished-goods-shipment-dialog"
      style={{
        marginTop: 12,
        padding: 12,
        border: '1px solid var(--admin-border, #e5e7eb)',
        borderRadius: 6,
      }}
    >
      <input type="hidden" name="payload" value={payload} />

      <div className="admin-form-grid" style={{ marginBottom: 12 }}>
        <div className="admin-field">
          <label htmlFor="fgShipmentShippedAt">Дата отгрузки</label>
          <input
            id="fgShipmentShippedAt"
            type="date"
            value={shippedAt}
            onChange={(e) => setShippedAt(e.target.value)}
          />
        </div>
        <div className="admin-field" style={{ flex: 2 }}>
          <label htmlFor="fgShipmentComment">Комментарий</label>
          <input
            id="fgShipmentComment"
            type="text"
            maxLength={500}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Например, Партия № 12 для клиента"
          />
        </div>
      </div>

      <table className="admin-table" style={{ marginBottom: 12 }}>
        <thead>
          <tr>
            <th>Номенклатура</th>
            <th>Склад / ячейка</th>
            <th style={{ textAlign: 'right' }}>Доступно</th>
            <th style={{ textAlign: 'right' }}>Отгрузить, шт</th>
          </tr>
        </thead>
        <tbody>
          {balances.map((b) => {
            const raw = qtyByBalance[b.id] ?? '';
            const n = Number(raw.replace(',', '.'));
            const isOver =
              raw !== '' && Number.isInteger(n) && n > b.qty;
            return (
              <tr key={b.id} data-balance-id={b.id}>
                <td>{formatBalanceName(b)}</td>
                <td>
                  {b.warehouseName ?? <span className="admin-muted">—</span>}
                  {b.cellCode ? ` / ${b.cellCode}` : ''}
                </td>
                <td style={{ textAlign: 'right' }}>
                  {b.qty.toLocaleString('ru-RU')}
                </td>
                <td style={{ textAlign: 'right' }}>
                  <input
                    type="number"
                    min={0}
                    max={b.qty}
                    step={1}
                    value={raw}
                    onChange={(e) =>
                      setQtyByBalance((prev) => ({
                        ...prev,
                        [b.id]: e.target.value,
                      }))
                    }
                    style={{
                      width: 90,
                      textAlign: 'right',
                      borderColor: isOver
                        ? 'var(--admin-danger-fg, #b91c1c)'
                        : undefined,
                    }}
                    aria-invalid={isOver ? true : undefined}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div
        className="admin-muted"
        style={{ fontSize: '0.85rem', marginBottom: 12 }}
      >
        К отгрузке: {totalQty.toLocaleString('ru-RU')} шт
        {noLines ? ' — укажите количество хотя бы по одной строке.' : ''}
      </div>

      {state.error && (
        <div
          role="alert"
          style={{
            color: 'var(--admin-danger-fg, #b91c1c)',
            fontSize: '0.88rem',
            marginBottom: 8,
          }}
        >
          <XCircle size={14} strokeWidth={1.6} aria-hidden /> {state.error}
        </div>
      )}

      <div className="admin-actions-row">
        <SubmitButton disabled={noLines || exceedsAvailable} />
        <button
          type="button"
          className="admin-btn admin-btn--ghost"
          onClick={onClose}
        >
          Отмена
        </button>
        <span className="admin-muted" style={{ marginLeft: 'auto' }}>
          <Truck
            size={14}
            strokeWidth={1.6}
            aria-hidden
            style={{ verticalAlign: 'middle', marginRight: 4 }}
          />
          Уменьшит остаток готовой продукции и создаст движение
          «Отгрузка».
        </span>
      </div>
    </form>
  );
}
