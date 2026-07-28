'use client';

/**
 * Вкладка «Расхождения» кабинета мастера.
 *
 * Экран утренней пятиминутки: «есть ли сегодня работа, которая идёт
 * мимо маршрута заказа». Пусто — работаем дальше. Есть строка — разбор
 * в тот же день.
 *
 * Зачем он вообще. Швея выбирает операцию из списка своего СТАНКА —
 * маршрут заказа в этом выборе не участвует. Если операции нет в снимке
 * маршрута, гейт `evaluateRouteOrder` не проверяет НИЧЕГО: работа
 * принимается молча, сделка начисляется, партия шьётся до конца — и
 * упирается только в AND-гейт перед ОТК, недели спустя, сразу десятками
 * паспортов. Так было шесть раз с 13.05.2026. В последний раз (28.07)
 * встало 70 паспортов в 8 заказах, а лаг обнаружения составил 27 дней.
 * На истории прода этот же запрос, запущенный утром 02.07, показал бы
 * одну строку — «O-20260530-0001 · ОКАНТОВКА · 21 паспорт · со вчера».
 *
 * Сознательно НЕ сделано: кнопок «так и должно быть» / «делают не то».
 * Решение по расхождению принимает владелец маршрутов (роль
 * `SHOP_MANAGER`), а он в системе пока не назначен — кнопка без
 * адресата превратилась бы в «прочитано» и вернула бы тот же эффект
 * привыкания, из-за которого не сработало жёлтое предупреждение швее.
 */

import { useCallback, useEffect, useState } from 'react';
import type { RouteDivergenceDto, RouteDivergencesDto } from '@sewing/shared';
import { loadRouteDivergencesAction } from './production-board-actions';

/** `дд.мм` в московской зоне — иначе RSC/клиент разъедутся при гидрации. */
function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
  });
}

/** Сколько дней расхождение уже живёт — главный признак срочности. */
function daysSince(iso: string): number {
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(ms / (24 * 60 * 60 * 1000)));
}

function DivergenceRow({ item }: { item: RouteDivergenceDto }) {
  const age = daysSince(item.firstAt);
  return (
    <li className="divergence-row">
      <div className="divergence-row__head">
        <span className="divergence-row__order">{item.orderNumber}</span>
        <span className="divergence-row__age" title="Сколько дней идёт">
          {age === 0 ? 'сегодня' : `${age} дн.`}
        </span>
      </div>
      <div className="divergence-row__op">
        Закрывают <strong>{item.operationCode}</strong> {item.operationName}
        {' — '}
        такого шага нет в маршруте заказа
      </div>
      <div className="divergence-row__meta">
        <span>
          Паспортов: <strong>{item.passportCount}</strong>
        </span>
        <span>с {formatDay(item.firstAt)}</span>
        {item.employees.length > 0 && <span>{item.employees.join(', ')}</span>}
      </div>
    </li>
  );
}

export function DivergencesView() {
  const [data, setData] = useState<RouteDivergencesDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await loadRouteDivergencesAction();
    if (res.ok) {
      setData(res.data);
      setError(null);
    } else {
      setError(res.error);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !data) {
    return <p className="muted">Загружаем…</p>;
  }
  if (error) {
    return (
      <div className="divergences">
        <p className="form-error">{error}</p>
        <button type="button" className="btn btn-secondary" onClick={load}>
          Повторить
        </button>
      </div>
    );
  }

  const items = data?.items ?? [];

  return (
    <div className="divergences">
      <div className="divergences__head">
        <p className="muted">
          Работа, закрытая мимо маршрута заказа, за последние{' '}
          {data?.windowDays ?? 30} дн.
        </p>
        <button type="button" className="btn btn-secondary" onClick={load}>
          Обновить
        </button>
      </div>

      {items.length === 0 ? (
        <div className="divergences__empty">
          <strong>Расхождений нет.</strong>
          <span>
            Вся работа за окно идёт по маршрутам заказов — разбирать нечего.
          </span>
        </div>
      ) : (
        <>
          <p className="divergences__lead">
            По этим заказам работа не засчитается на гейте перед ОТК: партия
            встанет. По каждой строке нужно решение — либо цех перешёл на
            другую технологию и маршрут заказа надо поправить, либо делают
            не то и работу надо остановить.
          </p>
          <ul className="divergences__list">
            {items.map((it) => (
              <DivergenceRow
                key={`${it.orderId}:${it.operationId}`}
                item={it}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
