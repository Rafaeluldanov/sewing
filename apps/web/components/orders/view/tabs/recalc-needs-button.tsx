'use client';

/**
 * «Пересчитать потребность» — явное действие вместо тихого пересчёта.
 *
 * Почему кнопка, а не автоматика. Пересчёт после правки спецификации зовётся
 * best-effort с `force: false`, и это защита: стоит закупщику тронуть строку
 * (поставить цену, отправить в заказ поставщику), как пересчёт по всему заказу
 * отбивается `WorkshopNeedsAlreadyReviewedException`. Раньше исключение уходило
 * в лог, и менеджер видел удалённый из техкарты материал живым в закупке.
 *
 * Перетереть работу закупщика молча нельзя — но и оставлять устаревшие цифры
 * тоже. Поэтому решение отдаём человеку и показываем цену: сколько строк уже в
 * работе и что они будут пересозданы.
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import { recalcOrderNeedsAction } from '@/app/admin/orders/[id]/recalc-needs-action';

export function RecalcNeedsButton({
  orderId,
  reviewedCount,
}: {
  orderId: string;
  /** Строк, которые закупщик уже увёл из статуса «рассчитано». */
  reviewedCount: number;
}) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function run(force: boolean) {
    setError(null);
    startTransition(async () => {
      const r = await recalcOrderNeedsAction(orderId, force);
      if (!r.ok) {
        setError(r.error);
        // Отбилось из-за работы закупщика — предлагаем осознанный force.
        if (r.needsForce) setConfirming(true);
        return;
      }
      setConfirming(false);
      router.refresh();
    });
  }

  if (confirming) {
    return (
      <div className="needs-stale__confirm">
        <p className="needs-stale__text">
          {reviewedCount > 0 ? (
            <>
              Строк в работе у закупщика: <b>{reviewedCount}</b>. Пересчёт
              создаст их заново — введённые цена, поставщик и статус пропадут.
            </>
          ) : (
            <>Пересчёт создаст строки потребности заново.</>
          )}
        </p>
        <div className="needs-stale__actions">
          <button
            type="button"
            className="btn btn-danger"
            disabled={pending}
            onClick={() => run(true)}
          >
            {pending ? 'Пересчитываю…' : 'Всё равно пересчитать'}
          </button>
          <button
            type="button"
            className="btn"
            disabled={pending}
            onClick={() => {
              setConfirming(false);
              setError(null);
            }}
          >
            Отмена
          </button>
        </div>
        {error && <p className="needs-stale__error">{error}</p>}
      </div>
    );
  }

  return (
    <div className="needs-stale__actions">
      <button
        type="button"
        className="btn btn-primary"
        disabled={pending}
        onClick={() => run(false)}
      >
        {pending ? 'Пересчитываю…' : 'Пересчитать'}
      </button>
      {error && <p className="needs-stale__error">{error}</p>}
    </div>
  );
}
