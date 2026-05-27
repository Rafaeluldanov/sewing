'use client';

/**
 * Модалка «История 30 дней» — таблица день-за-днём с суммами и
 * штуками.
 *
 * Открывается из `DailyEarningsPanel` по клику на «История 30 дней».
 * Грузит `/api/me/history?days=30` при mount; данные приходят
 * pre-filled нулями по всем 30 дням, чтобы UI рисовал «выходной»
 * там, где не было активности.
 */

import { useCallback, useEffect, useState } from 'react';
import type { MeHistoryDto } from '@sewing/shared/me-daily';
import { getMyHistoryAction } from '@/app/me/actions';
import { ModalPortal } from '@/components/modal-portal';

export interface EarningsHistoryModalProps {
  onClose: () => void;
  /** Горизонт в днях. По умолчанию 30. Передаётся как есть в API. */
  days?: number;
}

export function EarningsHistoryModal({
  onClose,
  days = 30,
}: EarningsHistoryModalProps) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<MeHistoryDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await getMyHistoryAction(days);
    if (res.ok) {
      setData(res.data);
    } else {
      setError(res.error);
      setData(null);
    }
    setLoading(false);
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <ModalPortal>
      <div
        className="qr-modal"
        role="dialog"
        aria-modal="true"
        aria-label="История начислений"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
        data-testid="my-day-history"
      >
        <div className="qr-modal__card my-history__card">
          <div className="qr-modal__header">
            <h3 className="qr-modal__title">История {days} дней</h3>
            <button
              type="button"
              className="qr-modal__close"
              onClick={onClose}
              aria-label="Закрыть"
            >
              ×
            </button>
          </div>

          {loading ? (
            <p className="qr-modal__hint">Загрузка…</p>
          ) : error ? (
            <div className="qr-modal__error" role="alert">
              <p className="qr-modal__error-title">{error}</p>
              <button
                type="button"
                className="btn"
                onClick={() => void load()}
              >
                Повторить
              </button>
            </div>
          ) : data ? (
            <HistoryTable data={data} />
          ) : null}

          <button
            type="button"
            className="btn btn-block qr-modal__cancel"
            onClick={onClose}
          >
            Закрыть
          </button>
        </div>
      </div>
    </ModalPortal>
  );
}

function HistoryTable({ data }: { data: MeHistoryDto }) {
  return (
    <>
      <table className="my-history__table">
        <thead>
          <tr>
            <th>Дата</th>
            <th className="my-history__th-num">Шт</th>
            <th className="my-history__th-num">Сделка</th>
            <th className="my-history__th-num">Оклад</th>
            <th className="my-history__th-num">Итого</th>
            <th className="my-history__th-status" aria-label="Статус" />
          </tr>
        </thead>
        <tbody>
          {data.items.map((item) => (
            <tr
              key={item.date}
              className={
                item.total === 0
                  ? 'my-history__row my-history__row--empty'
                  : 'my-history__row'
              }
            >
              <td>{formatDate(item.date)}</td>
              <td className="my-history__td-num">
                {item.pieceworkQty || '—'}
              </td>
              <td className="my-history__td-num">
                {item.pieceworkAmount > 0 ? formatRub(item.pieceworkAmount) : '—'}
              </td>
              <td className="my-history__td-num">
                {item.salaryAmount > 0 ? formatRub(item.salaryAmount) : '—'}
              </td>
              <td className="my-history__td-num my-history__td-total">
                {item.total > 0 ? formatRub(item.total) : '—'}
              </td>
              <td className="my-history__td-status">
                {item.total === 0 ? (
                  <span className="my-history__chip my-history__chip--off">
                    выходной
                  </span>
                ) : item.hasPending ? (
                  <span
                    className="my-history__chip my-history__chip--pending"
                    title="часть начислений ждёт упаковщика"
                  >
                    ⏳
                  </span>
                ) : (
                  <span
                    className="my-history__chip my-history__chip--ok"
                    title="всё подтверждено"
                  >
                    ✓
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td>За {data.days} дней</td>
            <td className="my-history__td-num" />
            <td className="my-history__td-num">
              {formatRub(data.totalPieceworkAmount)}
            </td>
            <td className="my-history__td-num">
              {formatRub(data.totalSalaryAmount)}
            </td>
            <td className="my-history__td-num my-history__td-total">
              {formatRub(data.totalAmount)}
            </td>
            <td />
          </tr>
        </tfoot>
      </table>
    </>
  );
}

function formatRub(value: number): string {
  return `${value.toLocaleString('ru-RU', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })} ₽`;
}

function formatDate(date: string): string {
  // YYYY-MM-DD по Москве, без таймзонных трюков.
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return date;
  const dd = String(d).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  return `${dd}.${mm}`;
}
