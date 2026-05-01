'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  SHOPFLOOR_STAGES,
  SHOPFLOOR_STAGE_LABELS,
  SHOPFLOOR_STAGE_QTY_KEYS,
  type ShopfloorOrderOptionDto,
  type ShopfloorRowDto,
  type ShopfloorStage,
  type ShopfloorStateDto,
  type ShopfloorSummaryDto,
} from '@sewing/shared/shopfloor';
import { Icon } from '@/components/icon';
import { getApiBaseUrl } from '@/lib/api-base';

interface Props {
  initialState: ShopfloorStateDto;
  initialOrderId: string | null;
  orders: ShopfloorOrderOptionDto[];
}

/** Период polling (мс). Согласовано с ADR-0007 (2–5 сек). */
const POLL_INTERVAL_MS = 3000;

/** Длительность подсветки изменения ячейки (мс). */
const FLASH_DURATION_MS = 1100;

interface FlashState {
  /** Ключ ячейки (`sizeId:stage` или `sum:stage`) → направление дельты. */
  cells: Record<string, 'up' | 'down'>;
}

function clientApiBase(): string {
  // Делегируем общему `getApiBaseUrl()`: на клиенте он отдаст
  // `NEXT_PUBLIC_API_URL`, а если переменная не задана — относительный
  // `/api` (nginx сам проксирует на backend на том же хосте). Так больше
  // нет шанса уйти на `api.prod.teeon.ru` из stage/dev.
  return getApiBaseUrl();
}

export function ShopfloorBoard({
  initialState,
  initialOrderId,
  orders,
}: Props) {
  const [state, setState] = useState<ShopfloorStateDto>(initialState);
  const [orderId, setOrderId] = useState<string | null>(initialOrderId);
  const [flash, setFlash] = useState<FlashState>({ cells: {} });
  const [polling, setPolling] = useState(true);
  const [pollError, setPollError] = useState<string | null>(null);

  const previousRef = useRef<ShopfloorStateDto>(initialState);
  const flashTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  // Синкаем initial state, если родитель отдал новый.
  useEffect(() => {
    setState(initialState);
    previousRef.current = initialState;
  }, [initialState]);

  const triggerFlash = useCallback(
    (key: string, direction: 'up' | 'down') => {
      setFlash((prev) => ({
        cells: { ...prev.cells, [key]: direction },
      }));
      const existing = flashTimers.current.get(key);
      if (existing) clearTimeout(existing);
      const t = setTimeout(() => {
        setFlash((prev) => {
          if (!(key in prev.cells)) return prev;
          const next = { ...prev.cells };
          delete next[key];
          return { cells: next };
        });
        flashTimers.current.delete(key);
      }, FLASH_DURATION_MS);
      flashTimers.current.set(key, t);
    },
    [],
  );

  const applyDiff = useCallback(
    (next: ShopfloorStateDto) => {
      const prev = previousRef.current;
      const prevRows = new Map(prev.rows.map((r) => [r.sizeId, r]));
      // Сравниваем по каждой (size, stage) ячейке.
      for (const r of next.rows) {
        const before = prevRows.get(r.sizeId);
        for (const stage of SHOPFLOOR_STAGES) {
          const key = SHOPFLOOR_STAGE_QTY_KEYS[stage];
          const prevQty = before ? before[key] : 0;
          const nextQty = r[key];
          if (nextQty !== prevQty) {
            triggerFlash(
              `${r.sizeId}:${stage}`,
              nextQty > prevQty ? 'up' : 'down',
            );
          }
        }
        const prevDef = before?.qtyDefect ?? 0;
        if (r.qtyDefect !== prevDef) {
          triggerFlash(
            `${r.sizeId}:DEFECT`,
            r.qtyDefect > prevDef ? 'up' : 'down',
          );
        }
      }
      // Размеры, которые исчезли (стали нулём → убрались сервером).
      for (const r of prev.rows) {
        if (!next.rows.find((x) => x.sizeId === r.sizeId)) {
          for (const stage of SHOPFLOOR_STAGES) {
            const key = SHOPFLOOR_STAGE_QTY_KEYS[stage];
            if (r[key] !== 0) {
              triggerFlash(`${r.sizeId}:${stage}`, 'down');
            }
          }
        }
      }
      // Summary-стрипа: подсветка строки итогов.
      for (const stage of SHOPFLOOR_STAGES) {
        const key = SHOPFLOOR_STAGE_QTY_KEYS[stage];
        if (next.summary[key] !== prev.summary[key]) {
          triggerFlash(
            `sum:${stage}`,
            next.summary[key] > prev.summary[key] ? 'up' : 'down',
          );
        }
      }
      if (next.summary.qtyDefect !== prev.summary.qtyDefect) {
        triggerFlash(
          'sum:DEFECT',
          next.summary.qtyDefect > prev.summary.qtyDefect ? 'up' : 'down',
        );
      }

      previousRef.current = next;
      setState(next);
    },
    [triggerFlash],
  );

  const fetchState = useCallback(async () => {
    const base = clientApiBase();
    const url = new URL(
      `shopfloor/state`,
      base.endsWith('/') ? base : `${base}/`,
    );
    if (orderId) url.searchParams.set('orderId', orderId);
    try {
      const res = await fetch(url.toString(), {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const json = (await res.json()) as ShopfloorStateDto;
      setPollError(null);
      applyDiff(json);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Polling failed';
      setPollError(msg);
    }
  }, [orderId, applyDiff]);

  // При смене orderId — сбрасываем «previous» и грузим заново.
  useEffect(() => {
    if (orderId === initialOrderId) return;
    previousRef.current = {
      ...state,
      rows: [],
      summary: {
        qtyCut: 0,
        qtySewing: 0,
        qtyQc: 0,
        qtyQcDone: 0,
        qtyWto: 0,
        qtyWtoDone: 0,
        qtyPacking: 0,
        qtyFinished: 0,
        qtyDefect: 0,
      },
    };
    void fetchState();
    // Обновим URL, чтобы можно было поделиться ссылкой / открыть в новой
    // вкладке нужный фильтр.
    const params = new URLSearchParams(window.location.search);
    if (orderId) params.set('orderId', orderId);
    else params.delete('orderId');
    const qs = params.toString();
    const next = `${window.location.pathname}${qs ? `?${qs}` : ''}`;
    window.history.replaceState(null, '', next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId]);

  // Polling loop.
  useEffect(() => {
    if (!polling) return;
    const id = setInterval(() => {
      void fetchState();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [polling, fetchState]);

  // Cleanup flash timers on unmount.
  useEffect(() => {
    return () => {
      for (const t of flashTimers.current.values()) clearTimeout(t);
      flashTimers.current.clear();
    };
  }, []);

  const updatedLabel = useMemo(() => {
    const d = new Date(state.updatedAt);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleTimeString('ru-RU');
  }, [state.updatedAt]);

  return (
    <div className="shopfloor-board">
      <div className="shopfloor-toolbar">
        <div className="shopfloor-title">
          <h1>
            <Icon name="shopfloor" size={26} />
            <span style={{ marginLeft: '0.4rem' }}>Цех</span>
          </h1>
          <span className="shopfloor-scope">{state.scopeLabel}</span>
        </div>
        <div className="shopfloor-controls">
          <label className="shopfloor-control">
            <span>Заказ</span>
            <select
              value={orderId ?? ''}
              onChange={(e) => setOrderId(e.target.value || null)}
            >
              <option value="">Все активные</option>
              {orders.map((o) => (
                <option key={o.id} value={o.id}>
                  № {o.number}
                  {o.productName ? ` · ${o.productName}` : ''}
                  {o.color ? ` · ${o.color}` : ''}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn"
            onClick={() => {
              void fetchState();
            }}
            title="Обновить сейчас"
            style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}
          >
            <Icon name="refresh" size={14} />
            Обновить
          </button>
          <label className="shopfloor-toggle">
            <input
              type="checkbox"
              checked={polling}
              onChange={(e) => setPolling(e.target.checked)}
            />
            Авто‑обновление
          </label>
          <span
            className={`shopfloor-status ${
              polling ? 'shopfloor-status--on' : 'shopfloor-status--off'
            }`}
          >
            <span className="shopfloor-status__dot" />
            {polling ? `обновлено ${updatedLabel}` : 'пауза'}
          </span>
        </div>
      </div>

      {pollError && (
        <div className="error-box shopfloor-poll-error">
          Ошибка обновления: {pollError}. Продолжаю показывать последние
          актуальные данные.
        </div>
      )}

      <SummaryStrip summary={state.summary} flash={flash} />

      <BoardTable rows={state.rows} flash={flash} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function flashClass(flash: FlashState, key: string): string {
  const dir = flash.cells[key];
  if (!dir) return '';
  return dir === 'up' ? 'shopfloor-cell--flash-up' : 'shopfloor-cell--flash-down';
}

function SummaryStrip({
  summary,
  flash,
}: {
  summary: ShopfloorSummaryDto;
  flash: FlashState;
}) {
  return (
    <div className="shopfloor-summary">
      {SHOPFLOOR_STAGES.map((stage) => {
        const qty = summary[SHOPFLOOR_STAGE_QTY_KEYS[stage]];
        return (
          <div
            key={stage}
            className={`shopfloor-summary__card ${flashClass(
              flash,
              `sum:${stage}`,
            )}`}
          >
            <div className="shopfloor-summary__label">
              {SHOPFLOOR_STAGE_LABELS[stage]}
            </div>
            <div
              className={`shopfloor-summary__value ${
                qty === 0 ? 'is-zero' : ''
              }`}
            >
              {qty}
            </div>
          </div>
        );
      })}
      <div
        className={`shopfloor-summary__card shopfloor-summary__card--defect ${flashClass(
          flash,
          'sum:DEFECT',
        )}`}
      >
        <div className="shopfloor-summary__label">Брак</div>
        <div
          className={`shopfloor-summary__value ${
            summary.qtyDefect === 0 ? 'is-zero' : ''
          }`}
        >
          {summary.qtyDefect}
        </div>
      </div>
    </div>
  );
}

function BoardTable({
  rows,
  flash,
}: {
  rows: ShopfloorRowDto[];
  flash: FlashState;
}) {
  if (rows.length === 0) {
    return (
      <div className="shopfloor-empty card">
        Нет активных паспортов в выбранной области. Запустите заказ
        в производство и выпустите первый паспорт, чтобы увидеть движение.
      </div>
    );
  }
  return (
    <div className="shopfloor-table-wrap">
      <table className="shopfloor-table">
        <thead>
          <tr>
            <th className="shopfloor-table__size">Размер</th>
            {SHOPFLOOR_STAGES.map((stage) => (
              <th key={stage}>{SHOPFLOOR_STAGE_LABELS[stage]}</th>
            ))}
            <th className="shopfloor-table__defect">Брак</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.sizeId}>
              <th scope="row" className="shopfloor-table__size">
                {r.sizeCode}
              </th>
              {SHOPFLOOR_STAGES.map((stage) => {
                const qty = r[SHOPFLOOR_STAGE_QTY_KEYS[stage]];
                return (
                  <td
                    key={stage}
                    className={`shopfloor-cell ${
                      qty === 0 ? 'is-zero' : ''
                    } ${flashClass(flash, `${r.sizeId}:${stage}`)}`}
                  >
                    {qty}
                  </td>
                );
              })}
              <td
                className={`shopfloor-cell shopfloor-cell--defect ${
                  r.qtyDefect === 0 ? 'is-zero' : ''
                } ${flashClass(flash, `${r.sizeId}:DEFECT`)}`}
              >
                {r.qtyDefect}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
