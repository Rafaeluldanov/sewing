'use client';

/**
 * Вкладка «Заказы» кабинета мастера — заказы, их маршруты и правка
 * маршрута прямо с телефона.
 *
 * Три экрана внутри одной вкладки (мастер не уходит со своей страницы):
 *   1) список — карточка заказа с мини-цепочкой маршрута и отметкой
 *      фронта производства (`GET /api/master/orders`);
 *   2) маршрут заказа — цепочка целиком, деньги и время плана, кнопка
 *      «Изменить маршрут»;
 *   3) холст правки — тот же `RouteAmendmentTab`, что во вкладке
 *      «Маршрут» drawer-а заказа, но в тач-режиме (`compact`).
 *
 * Правка идёт существующей ручкой `PUT /orders/:id/amendments/route`:
 * замороженный префикс, обязательная причина у запущенного заказа,
 * журнал и пересчёт плана — общие с менеджерским холстом, здесь не
 * дублируются.
 *
 * Зачем это мастеру. Он первым видит, что в заказе нет ОТК перед
 * упаковкой или что работу закрывают мимо маршрута (вкладка
 * «Расхождения»), — и до сих пор мог только позвать менеджера. Состав
 * операций — его зона; количество, размерность и расценки остаются у
 * менеджера заказа.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { OperationAmendmentStateDto } from '@sewing/shared';
import type {
  MasterOrderListItemDto,
  MasterOrderTab,
  MasterOrdersDto,
} from '@sewing/shared/master-orders';
import { ORDER_STATUS_LABELS } from '@sewing/shared/orders';
import { RouteAmendmentTab } from '@/components/orders/amendments/route-amendment-tab';
import {
  routeStepIcon,
  routeStepTone,
} from '@/components/admin/admin-route-steps';
import {
  loadMasterOrdersAction,
  loadRouteAmendmentStateAction,
} from './master-orders-actions';

const TABS: { key: MasterOrderTab; label: string }[] = [
  { key: 'production', label: 'В работе' },
  { key: 'pending', label: 'Ждут запуска' },
  { key: 'done', label: 'Готовы' },
];

/** `дд.мм` в московской зоне — иначе RSC и клиент разъедутся при гидрации. */
function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
  });
}

/** Дней до срока; отрицательное — просрочка. */
function daysToDue(iso: string): number {
  const ms = new Date(iso).getTime() - Date.now();
  return Math.ceil(ms / (24 * 60 * 60 * 1000));
}

function DueBadge({ dueDate }: { dueDate: string | null }) {
  if (!dueDate) return <span className="morders__meta-item">срок не задан</span>;
  const left = daysToDue(dueDate);
  const tone = left < 0 ? 'bad' : left <= 1 ? 'warn' : 'ok';
  const text =
    left < 0
      ? `просрочен на ${Math.abs(left)} дн.`
      : left === 0
        ? 'срок сегодня'
        : left === 1
          ? 'срок завтра'
          : `срок ${formatDay(dueDate)}`;
  return <span className={`morders__due morders__due--${tone}`}>{text}</span>;
}

/** Мини-цепочка маршрута в карточке списка. */
function RouteStrip({ item }: { item: MasterOrderListItemDto }) {
  if (item.steps.length === 0) {
    return (
      <p className="morders__no-route">
        Маршрут не назначен — операции считать не по чему.
      </p>
    );
  }
  return (
    <ul className="morders__chain">
      {item.steps.map((s, i) => {
        const Icon = routeStepIcon(s.operationCategory);
        // Отметку «фронт» ставим ПОСЛЕ последнего пройденного шага: она
        // разделяет сделанное и предстоящее, а не подписывает шаг.
        // Сравниваем `index` снимка, а не позицию в массиве: после правки
        // маршрута нумерация шагов — это их `index`, и позиция совпадает
        // с ним только пока снимок не переставляли.
        const frontHere = item.frontierIndex >= 0 && s.index === item.frontierIndex;
        const parallelWithPrev =
          i > 0 &&
          s.parallelGroup != null &&
          s.parallelGroup === item.steps[i - 1].parallelGroup;
        return (
          <li key={s.index} className="morders__chain-item">
            {i > 0 && (
              <span className="morders__chain-sep" aria-hidden>
                {parallelWithPrev ? '⇄' : '›'}
              </span>
            )}
            <span
              className={`admin-route-step admin-route-step--mini ${routeStepTone(
                s.operationCategory,
              )}${s.passed ? ' admin-route-step--frozen' : ''}`}
              title={
                s.passed
                  ? `${s.operationName} — паспорта прошли или проходят`
                  : s.operationName
              }
            >
              <span className="admin-route-step__icon" aria-hidden>
                <Icon size={12} strokeWidth={1.7} />
              </span>
              <span className="admin-route-step__name">{s.operationName}</span>
            </span>
            {frontHere && <span className="morders__front">фронт</span>}
          </li>
        );
      })}
    </ul>
  );
}

function OrderCard({
  item,
  onOpen,
}: {
  item: MasterOrderListItemDto;
  onOpen: () => void;
}) {
  const done =
    item.qtyPlanTotal > 0
      ? Math.min(100, Math.round((item.qtyFinishedTotal / item.qtyPlanTotal) * 100))
      : 0;
  return (
    <li className="morders__card">
      <button type="button" className="morders__card-btn" onClick={onOpen}>
        <div className="morders__card-top">
          <span className="morders__number">{item.number}</span>
          <span className="morders__status">
            {ORDER_STATUS_LABELS[item.status] ?? item.status}
          </span>
        </div>
        <div className="morders__product">
          {item.productName ?? 'Изделие не указано'}
          {item.color ? `, ${item.color}` : ''} · {item.qtyPlanTotal} шт
        </div>
        <div className="morders__meta">
          <DueBadge dueDate={item.dueDate} />
          {item.clientName && (
            <span className="morders__meta-item">{item.clientName}</span>
          )}
          {item.passportCount > 0 && (
            <span className="morders__meta-item">
              паспортов {item.passportCount}
            </span>
          )}
        </div>
        <RouteStrip item={item} />
        {item.qtyPlanTotal > 0 && (
          <>
            <div className="morders__bar" aria-hidden>
              <i style={{ width: `${done}%` }} />
            </div>
            <div className="morders__progress">
              упаковано {item.qtyFinishedTotal} из {item.qtyPlanTotal} шт ·{' '}
              {item.steps.length} шаг(ов) маршрута
            </div>
          </>
        )}
      </button>
    </li>
  );
}

/** Экран заказа: маршрут целиком + вход в правку. */
function OrderRouteScreen({
  item,
  focusOperationName,
  onBack,
  onSaved,
}: {
  item: MasterOrderListItemDto;
  focusOperationName?: string | null;
  onBack: () => void;
  onSaved: () => void;
}) {
  const [state, setState] = useState<OperationAmendmentStateDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await loadRouteAmendmentStateAction(item.id);
    if (res.ok) {
      setState(res.data);
      setError(null);
    } else {
      setError(res.error);
    }
    setLoading(false);
  }, [item.id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Правка сохранена — `RouteAmendmentTab` зовёт `onClose`. Перечитываем
  // состояние (фронт мог уехать, пока правили) и обновляем список.
  const afterSave = useCallback(() => {
    setEditing(false);
    void load();
    onSaved();
  }, [load, onSaved]);

  const totals = useMemo(() => {
    const steps = state?.steps ?? [];
    return {
      rate: steps.reduce((a, s) => a + (s.rateRub ?? 0), 0),
      sec: steps.reduce((a, s) => a + (s.timeNormSec ?? 0), 0),
    };
  }, [state]);

  return (
    <div className="morders__detail">
      <div className="morders__detail-head">
        <button type="button" className="morders__back" onClick={onBack}>
          ‹ Заказы
        </button>
        <div>
          <div className="morders__number">{item.number}</div>
          <div className="morders__product">
            {item.productName ?? 'Изделие не указано'} · {item.qtyPlanTotal} шт
          </div>
        </div>
      </div>

      {focusOperationName && (
        <p className="morders__focus" role="status">
          Из «Расхождений»: работу закрывают операцией{' '}
          <strong>{focusOperationName}</strong>, а в маршруте её нет. Поставьте
          её на нужное место — или вернитесь и выпишите наряд-допуск.
        </p>
      )}

      {loading && <p className="muted">Загружаем маршрут…</p>}
      {error && (
        <div className="master-page__error" role="alert">
          {error}
          <button type="button" className="btn btn-secondary" onClick={load}>
            Повторить
          </button>
        </div>
      )}

      {state && !editing && (
        <div className="morders__route-card">
          <div className="morders__route-head">
            <span className="morders__route-title">Маршрут заказа</span>
            <span className="muted">{state.steps.length} шаг(ов)</span>
          </div>

          {state.steps.length === 0 ? (
            <p className="morders__no-route">
              Маршрут не назначен. Соберите цепочку операций — по ней считаются
              выработка, гейты паспортов и план.
            </p>
          ) : (
            <RouteStrip
              item={{
                ...item,
                frontierIndex: state.frontierIndex,
                steps: state.steps.map((s) => ({
                  index: s.index,
                  operationCode: s.operationCode,
                  operationName: s.operationName,
                  operationCategory: s.operationCategory,
                  parallelGroup: s.parallelGroup,
                  passed: s.index <= state.frontierIndex,
                })),
              }}
            />
          )}

          <div className="morders__totals">
            <span>
              Сделка: <b>{totals.rate.toFixed(2)} ₽/шт</b>
            </span>
            <span>
              Норма: <b>{Math.round(totals.sec / 60)} мин</b>
            </span>
          </div>

          {state.started && state.frontierIndex >= 0 && (
            <p className="morders__hint morders__hint--warn">
              Паспорта дошли до шага {state.frontierIndex + 1}. Шаги до него
              заморожены: их не убрать, не переставить и не вставить перед ними
              операцию.
            </p>
          )}
          {!state.started && (
            <p className="morders__hint">
              Заказ ещё не запущен — маршрут правится целиком и без причины.
            </p>
          )}

          {state.editable ? (
            <button
              type="button"
              className="master-page__primary morders__cta"
              onClick={() => setEditing(true)}
            >
              Изменить маршрут
            </button>
          ) : (
            <p className="morders__hint morders__hint--warn">
              Заказ закрыт — маршрут в нём уже не меняется.
            </p>
          )}
        </div>
      )}

      {state && editing && (
        <div className="morders__editor">
          <RouteAmendmentTab
            orderId={item.id}
            state={state}
            compact
            onClose={afterSave}
          />
          <button
            type="button"
            className="btn btn-secondary morders__cancel"
            onClick={() => setEditing(false)}
          >
            Выйти из правки
          </button>
        </div>
      )}
    </div>
  );
}

export function OrdersRoutesView({
  focusOrderId,
  focusOrderNumber,
  focusOperationName,
  onFocusConsumed,
}: {
  /** Заказ, который надо открыть сразу (переход из «Расхождений»). */
  focusOrderId?: string | null;
  /** Его номер — им же подставляем поиск, чтобы заказ точно попал в выборку. */
  focusOrderNumber?: string | null;
  /** Операция расхождения — подсказка в шапке экрана заказа. */
  focusOperationName?: string | null;
  onFocusConsumed?: () => void;
}) {
  const [tab, setTab] = useState<MasterOrderTab>('production');
  const [search, setSearch] = useState('');
  const [data, setData] = useState<MasterOrdersDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(
    async (nextTab: MasterOrderTab, nextSearch: string) => {
      setLoading(true);
      const res = await loadMasterOrdersAction({
        tab: nextTab,
        search: nextSearch.trim() || undefined,
      });
      if (res.ok) {
        setData(res.data);
        setError(null);
      } else {
        setError(res.error);
      }
      setLoading(false);
    },
    [],
  );

  // Поиск с задержкой: у мастера телефон, и запрос на каждую букву — это
  // мигающий список под пальцем. `loading` поднимаем сразу, не дожидаясь
  // таймера: иначе окно «данные ещё старые, но loading уже false» гасит
  // только что открытый заказ (см. эффект-сторож ниже).
  useEffect(() => {
    setLoading(true);
    const t = window.setTimeout(() => void load(tab, search), search ? 350 : 0);
    return () => window.clearTimeout(t);
  }, [load, tab, search]);

  /**
   * Переход из «Расхождений». Заказ мог не попасть ни в текущую вкладку,
   * ни в лимит списка, поэтому не надеемся, что он уже в `items`: ставим
   * вкладку «в работе» и подставляем номер в поиск — та же ручка вернёт
   * ровно этот заказ.
   */
  useEffect(() => {
    if (!focusOrderId) return;
    setTab('production');
    setSearch(focusOrderNumber ?? '');
    setOpenId(focusOrderId);
  }, [focusOrderId, focusOrderNumber]);

  const items = data?.items ?? [];
  const open = items.find((o) => o.id === openId) ?? null;

  // Стабильная ссылка: `OrderRouteScreen` держит её в зависимостях
  // колбэка «правка сохранена».
  const reload = useCallback(() => void load(tab, search), [load, tab, search]);

  // Заказ открыт, но его нет в выборке (сменилась вкладка, изменился
  // поиск, заказ уехал в другой статус) — возвращаемся к списку, а не
  // показываем пустой экран.
  useEffect(() => {
    if (openId && !loading && !open) setOpenId(null);
  }, [openId, loading, open]);

  if (openId && !open && loading) {
    return <p className="muted">Открываем заказ…</p>;
  }

  if (open) {
    return (
      <OrderRouteScreen
        item={open}
        focusOperationName={
          focusOrderId === open.id ? focusOperationName : null
        }
        onBack={() => {
          setOpenId(null);
          onFocusConsumed?.();
        }}
        onSaved={reload}
      />
    );
  }

  return (
    <div className="morders">
      <div className="morders__tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={`morders__tab${tab === t.key ? ' is-active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
            {data ? ` · ${data.counts[t.key]}` : ''}
          </button>
        ))}
      </div>

      <input
        type="search"
        className="morders__search"
        placeholder="Номер заказа, изделие, клиент…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        aria-label="Поиск заказа"
      />

      {error && (
        <div className="master-page__error" role="alert">
          {error}
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void load(tab, search)}
          >
            Повторить
          </button>
        </div>
      )}

      {loading && items.length === 0 && <p className="muted">Загружаем…</p>}

      {!loading && items.length === 0 && !error && (
        <div className="morders__empty">
          <strong>Заказов нет.</strong>
          <span>
            {search.trim()
              ? 'По запросу ничего не нашлось — проверьте номер.'
              : 'На этой вкладке пусто.'}
          </span>
        </div>
      )}

      <ul className="morders__list">
        {items.map((it) => (
          <OrderCard key={it.id} item={it} onOpen={() => setOpenId(it.id)} />
        ))}
      </ul>
    </div>
  );
}
