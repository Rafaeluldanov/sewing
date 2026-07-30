'use client';

/**
 * `RecalcCostButton` — кнопка «Пересчитать себестоимость» из плашки
 * «Себестоимость устарела» во вкладке «Потребности».
 *
 * Фича «Правка потребности на любой стадии»: обычно пересчёт происходит
 * сам, сразу после правки строки. Плашка и эта кнопка появляются только
 * когда автопересчёт объективно не смог — чаще всего потому, что в
 * строках есть USD, а курса у системы нет. Поэтому рядом с кнопкой поле
 * курса: это и есть недостающий человеку ввод.
 *
 * Тот же server-action, что и у кнопки в блоке «Корректировка после
 * просчёта» (`recalculateOrderCostEstimateAction`) — второй ручки к
 * бэкенду не заводим.
 */

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Calculator } from 'lucide-react';
import { recalculateOrderCostEstimateAction } from '@/app/orders/actions';

interface Props {
  orderId: string;
  /** Показывать поле курса USD (причина отказа — отсутствие курса). */
  needsUsdRate: boolean;
}

export function RecalcCostButton({ orderId, needsUsdRate }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [usdRate, setUsdRate] = useState('');

  return (
    <div className="needs-stale__actions">
      {needsUsdRate && (
        <input
          type="text"
          inputMode="decimal"
          className="admin-input"
          placeholder="Курс USD, ₽"
          value={usdRate}
          onChange={(e) => setUsdRate(e.target.value)}
          disabled={pending}
          aria-label="Курс USD в рублях"
        />
      )}
      <button
        type="button"
        className="admin-btn admin-btn--primary"
        disabled={pending}
        data-testid="order-cost-stale-recalc"
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await recalculateOrderCostEstimateAction(
              orderId,
              usdRate,
            );
            if (result?.error) {
              setError(result.error);
              return;
            }
            router.refresh();
          });
        }}
      >
        <Calculator size={16} strokeWidth={1.6} aria-hidden />
        {pending ? 'Пересчитываем…' : 'Пересчитать себестоимость'}
      </button>
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

export default RecalcCostButton;
