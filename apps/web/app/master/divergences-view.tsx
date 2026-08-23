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
 * Решение принимается ЗДЕСЬ же. Строка расхождения — это готовая пара
 * «заказ × операция», то есть тело наряда-допуска; мастеру остаётся
 * ответить на единственный вопрос, который система за него решить не
 * может: какой шаг маршрута эта работа закрывает. Отправлять его за
 * этим на отдельный экран — значит гарантировать, что он туда не пойдёт
 * и вместо допуска попросит «выключить эту вашу проверку».
 *
 * Кнопки «делают не то» сознательно нет: остановка работы — это разговор
 * со швеёй у станка, а не нажатие в интерфейсе. Система тут может только
 * показать факт, что она и делает.
 */

import { useCallback, useEffect, useState } from 'react';
import type {
  RouteDebtDto,
  RouteDebtsDto,
  RouteDivergenceDto,
  RouteDivergencesDto,
  RouteWorkPermitDto,
} from '@sewing/shared';
import {
  loadRouteDebtsAction,
  loadRouteDivergencesAction,
  loadRouteWorkPermitsAction,
  revokeRouteWorkPermitAction,
} from './production-board-actions';
import { PermitForm } from './permit-form';

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

/** Куда уводит кнопка «Поправить маршрут» — вкладка «Заказы». */
export interface RouteFocus {
  orderId: string;
  orderNumber: string;
  operationName: string;
}

function DivergenceRow({
  item,
  onPermitIssued,
  onOpenRoute,
}: {
  item: RouteDivergenceDto;
  onPermitIssued: (message: string) => void;
  onOpenRoute?: (focus: RouteFocus) => void;
}) {
  const [formOpen, setFormOpen] = useState(false);
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
      {/* Решение мастера прямо здесь: строка расхождения — это уже
          готовая пара «заказ × операция», то есть тело допуска. */}
      {!formOpen ? (
        <div className="divergence-row__actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setFormOpen(true)}
            disabled={item.routeSewingSteps.length === 0}
            title={
              item.routeSewingSteps.length === 0
                ? 'У заказа нет швейных шагов маршрута — закрывать нечего'
                : undefined
            }
          >
            Так и должно быть — выдать допуск
          </button>
          {/* Второй ответ на ту же строку. Допуск закрывает работу,
              которая УЖЕ сделана; правка маршрута лечит причину — если
              цех перешёл на другую технологию, операции место в
              маршруте. Впереди фронта, поэтому прошлые паспорта она не
              закрывает: это по-прежнему допуск. */}
          {onOpenRoute && (
            <button
              type="button"
              className="btn btn-sm divergence-row__to-route"
              onClick={() =>
                onOpenRoute({
                  orderId: item.orderId,
                  orderNumber: item.orderNumber,
                  operationName: `${item.operationCode} ${item.operationName}`,
                })
              }
            >
              Поправить маршрут →
            </button>
          )}
        </div>
      ) : (
        <PermitForm
          item={item}
          onCancel={() => setFormOpen(false)}
          onDone={(msg) => {
            setFormOpen(false);
            onPermitIssued(msg);
          }}
        />
      )}
    </li>
  );
}

/**
 * Секция «Незакрытая работа» — зеркальная половина расхождений.
 *
 * Расхождение = закрыли операцию, которой нет в маршруте. Долг =
 * операция в маршруте есть, а закрытия по ней нет, хотя паспорт уже
 * уехал вперёд. Второе тише и дороже: гейт такой случай пропускает по
 * построению (проверяются только шаги МЕЖДУ текущим и целевым), экранов
 * не было вообще, а без `OPERATION_FINISHED` не создаётся и начисление
 * — работа сделана и не оплачена никому.
 *
 * Кнопок здесь нет сознательно, как и в строке расхождения: долг
 * закрывается у станка, а не в интерфейсе. Любой сотрудник на этой
 * операции может отсканировать паспорт и завершить его сам —
 * маршрутный гейт доделку разрешает (`allowCatchUp`).
 */
function DebtsSection({ data }: { data: RouteDebtsDto | null }) {
  const items = data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <div className="divergences__debts">
      <h3 className="divergences__debts-title">Незакрытая работа</h3>
      <p className="muted divergences__debts-lead">
        Паспорт уехал вперёд, а шаг маршрута позади остался без закрытия.
        Сделка за эту работу не начислена никому: начисление создаётся
        только при завершении операции.
      </p>
      <ul className="divergences__list">
        {items.map((it) => (
          <DebtRow key={`${it.orderId}:${it.operationId}:${it.reason}`} item={it} />
        ))}
      </ul>
    </div>
  );
}

function DebtRow({ item }: { item: RouteDebtDto }) {
  const abandoned = item.reason === 'ABANDONED';
  const age = item.firstAt ? daysSince(item.firstAt) : null;
  return (
    <li className="debt-row">
      <div className="divergence-row__head">
        <span className="divergence-row__order">{item.orderNumber}</span>
        {age !== null && (
          <span className="debt-row__age" title="Сколько дней висит">
            {age === 0 ? 'сегодня' : `${age} дн.`}
          </span>
        )}
      </div>
      <div className="divergence-row__op">
        <span className="debt-row__reason">
          {abandoned ? 'Взяли и не закрыли' : 'Проехали мимо'}
        </span>
        {' — '}
        <strong>{item.operationCode}</strong> {item.operationName}
      </div>
      <div className="divergence-row__meta">
        <span>
          Паспортов: <strong>{item.passportCount}</strong>
        </span>
        <span>изделий: {item.qty}</span>
        {item.firstAt && <span>с {formatDay(item.firstAt)}</span>}
        {item.employees.length > 0 && <span>{item.employees.join(', ')}</span>}
      </div>
      <div className="divergence-row__meta">
        <span>
          {abandoned
            ? 'Доделать может любой сотрудник на этой операции: отсканировать паспорт и завершить.'
            : 'Шаг никто не брал в работу — вопрос к маршруту заказа.'}
        </span>
      </div>
    </li>
  );
}

/** Действующие допуски: мастер должен видеть, что сам разрешил. */
function PermitsSection({
  permits,
  onChanged,
}: {
  permits: RouteWorkPermitDto[];
  onChanged: (message: string) => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const active = permits.filter((p) => p.active);
  if (active.length === 0) return null;

  async function revoke(p: RouteWorkPermitDto) {
    setBusyId(p.id);
    const res = await revokeRouteWorkPermitAction(
      p.id,
      'Отозван мастером из вкладки «Расхождения»',
    );
    setBusyId(null);
    if (res.ok) onChanged('Допуск отозван.');
  }

  return (
    <div className="divergences__permits">
      <h3 className="divergences__permits-title">Действующие допуски</h3>
      <ul className="divergences__list">
        {active.map((p) => (
          <li key={p.id} className="permit-row">
            <div className="divergence-row__head">
              <span className="divergence-row__order">{p.orderNumber}</span>
              <span className="permit-row__until">
                до {formatDay(p.expiresAt)}
              </span>
            </div>
            <div className="divergence-row__op">
              <strong>
                {p.operationCode} {p.operationName}
              </strong>{' '}
              закрывает{' '}
              <strong>
                {p.satisfiesStepOperationCode} {p.satisfiesStepOperationName}
              </strong>
            </div>
            <div className="divergence-row__meta">
              <span>{p.reason}</span>
              <span>
                {p.qtyLimit != null
                  ? `${p.qtyUsed} из ${p.qtyLimit} шт`
                  : `${p.qtyUsed} шт, без лимита`}
              </span>
              <span>выдал: {p.createdByName}</span>
            </div>
            <div className="divergence-row__actions">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={busyId === p.id}
                onClick={() => revoke(p)}
              >
                {busyId === p.id ? 'Отзываем…' : 'Отозвать'}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function DivergencesView({
  onOpenRoute,
}: {
  /** Открыть маршрут заказа во вкладке «Заказы» (см. `RouteFocus`). */
  onOpenRoute?: (focus: RouteFocus) => void;
} = {}) {
  const [data, setData] = useState<RouteDivergencesDto | null>(null);
  const [permits, setPermits] = useState<RouteWorkPermitDto[]>([]);
  const [debts, setDebts] = useState<RouteDebtsDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [res, permitsRes, debtsRes] = await Promise.all([
      loadRouteDivergencesAction(),
      loadRouteWorkPermitsAction(),
      loadRouteDebtsAction(),
    ]);
    if (res.ok) {
      setData(res.data);
      setError(null);
    } else {
      setError(res.error);
    }
    // Допуски — вспомогательный блок: их недоступность не должна
    // прятать главное, ради чего мастер открыл вкладку.
    if (permitsRes.ok) setPermits(permitsRes.items);
    // Долги — независимый расчёт: их недоступность не должна прятать
    // расхождения, и наоборот.
    if (debtsRes.ok) setDebts(debtsRes.data);
    setLoading(false);
  }, []);

  const afterChange = useCallback(
    (message: string) => {
      setToast(message);
      void load();
    },
    [load],
  );

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

      {toast && (
        <p className="divergences__toast" role="status" aria-live="polite">
          {toast}
        </p>
      )}

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
                onPermitIssued={afterChange}
                onOpenRoute={onOpenRoute}
              />
            ))}
          </ul>
        </>
      )}

      <DebtsSection data={debts} />

      <PermitsSection permits={permits} onChanged={afterChange} />
    </div>
  );
}
