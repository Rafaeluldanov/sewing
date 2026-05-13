'use client';

/**
 * Компонент истории паспорта внутри `PassportActionsSheet` на
 * `/master`. Открывается по кнопке «Посмотреть историю паспорта»
 * между шапкой sheet'а и кнопками действий.
 *
 * Источник данных — `GET /api/passports/:id/history` через server
 * action `fetchPassportHistoryAction` (см.
 * `apps/web/app/master/master-actions-actions.ts`).
 *
 * UX:
 *   - кнопка «Назад к действиям» сверху (симметрично `ActionBody`,
 *     см. `passport-actions-sheet.tsx::onBack`);
 *   - вертикальный скролл внутри блока (на маленьких экранах истории
 *     может быть много — особенно для P-…0191 с 7+ событиями); CSS-
 *     ограничение по высоте у класса `.master-actions-sheet__history`;
 *   - события рендерятся как вертикальный таймлайн: время + тип +
 *     инициатор + операция + ячейка + qty;
 *   - события с пометкой `manual = true` выделяются бейджем
 *     «(ручная правка)» — это записи, созданные ручной правкой
 *     админа (id-префикс `man_`).
 */

import { useEffect, useState } from 'react';
import type { PassportHistoryEventDto } from '@sewing/shared';
import { fetchPassportHistoryAction } from './master-actions-actions';

interface Props {
  passportId: string;
  passportNumber: string;
  onBack: () => void;
}

export function PassportHistoryView({
  passportId,
  passportNumber,
  onBack,
}: Props) {
  const [events, setEvents] = useState<PassportHistoryEventDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setError(null);
    fetchPassportHistoryAction(passportId)
      .then((res) => {
        if (cancelled) return;
        if (res.ok) {
          setEvents(res.result.events);
        } else {
          setError(res.error);
        }
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [passportId]);

  return (
    <div className="master-actions-sheet__body">
      <button
        type="button"
        className="master-actions-sheet__back"
        onClick={onBack}
      >
        ← Назад к действиям
      </button>
      <h4 className="master-actions-sheet__action-title">
        История паспорта {passportNumber}
      </h4>
      <p className="master-actions-sheet__action-hint">
        Хронологический список событий: что было сделано по паспорту, кем
        и когда.
      </p>

      {busy && (
        <p
          className="master-actions-sheet__history-status"
          role="status"
          aria-live="polite"
        >
          Загружаем историю…
        </p>
      )}
      {error && (
        <p
          className="master-actions-sheet__error"
          role="alert"
        >
          {error}
        </p>
      )}
      {events && events.length === 0 && !error && (
        <p className="master-actions-sheet__history-status" role="status">
          По этому паспорту пока нет событий.
        </p>
      )}
      {events && events.length > 0 && (
        <ol className="master-actions-sheet__history" aria-label="История событий">
          {events.map((ev) => (
            <li
              key={ev.id}
              className={`master-actions-sheet__history-item${ev.manual ? ' master-actions-sheet__history-item--manual' : ''}`}
            >
              <div className="master-actions-sheet__history-time">
                {formatEventTime(ev.createdAt)}
              </div>
              <div className="master-actions-sheet__history-main">
                <div className="master-actions-sheet__history-type">
                  {ev.typeLabel}
                  {ev.manual && (
                    <span
                      className="master-actions-sheet__history-manual"
                      title="Запись создана ручной правкой администратора"
                    >
                      (ручная правка)
                    </span>
                  )}
                </div>
                <div className="master-actions-sheet__history-meta">
                  {ev.employee && <span>Кто: {ev.employee.fullName}</span>}
                  {ev.operation && <span>Операция: {ev.operation.name}</span>}
                  {ev.fromOperation && (
                    <span>Откуда: {ev.fromOperation.name}</span>
                  )}
                  {ev.cell && <span>Ячейка: {ev.cell.code}</span>}
                  {ev.qty !== null && <span>Кол-во: {ev.qty}</span>}
                  {ev.defectQty !== null && ev.defectQty > 0 && (
                    <span>Брак: {ev.defectQty}</span>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/**
 * Форматирует ISO-строку как `DD.MM.YYYY HH:mm` в локали браузера.
 * Без секунд — оператору не нужна точность до секунды на бытовом UI.
 */
function formatEventTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
