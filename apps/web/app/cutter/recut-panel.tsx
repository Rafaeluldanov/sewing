'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type {
  RecutOrderSearchItemDto,
  RecutSessionDto,
} from '@sewing/shared/recut';
import {
  cancelRecutAction,
  completeRecutAction,
  searchRecutOrdersAction,
  startRecutAction,
} from './actions';

/**
 * Панель «Подкрой» на доске раскройщика (`/cutter`, только при активной
 * смене). Подкрой — отдельный таймер по заказу (докрой деталей),
 * возможный даже по завершённому заказу.
 *
 * Два состояния:
 *   - идёт подкрой → карточка с живым таймером и «Завершить» / «Отменить»;
 *   - ничего не идёт → поиск заказа по номеру → «Начать подкрой».
 *
 * После любого действия страница ревалидируется (`router.refresh`),
 * серверный `page.tsx` перечитывает активный подкрой — источник истины
 * всегда backend.
 */
export function RecutPanel({ active }: { active: RecutSessionDto | null }) {
  return (
    <section className="constructor-section">
      <h2 className="constructor-section__title">Подкрой</h2>
      {active ? <ActiveRecut session={active} /> : <StartRecut />}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Активный подкрой: живой таймер + завершить/отменить
// ---------------------------------------------------------------------------

function ActiveRecut({ session }: { session: RecutSessionDto }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const elapsed = useElapsed(session.startedAt);

  function run(action: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        router.refresh();
      } else {
        setError(result.error ?? 'Не удалось выполнить действие');
      }
    });
  }

  return (
    <div className="constructor-card constructor-card--status-in_progress">
      <div className="constructor-card__head">
        <strong className="constructor-card__name">
          Подкрой · заказ {session.orderNumber}
        </strong>
        <span className="constructor-status constructor-status--in_progress">
          Идёт
        </span>
      </div>
      <p
        className="recut-timer"
        style={{
          fontSize: '2rem',
          fontVariantNumeric: 'tabular-nums',
          margin: '0.5rem 0',
        }}
        aria-label="Время подкроя"
      >
        {elapsed ?? '—'}
      </p>
      <div className="constructor-actions">
        <button
          type="button"
          className="constructor-btn constructor-btn--primary"
          disabled={pending}
          onClick={() => run(() => completeRecutAction(session.id))}
        >
          {pending ? 'Завершаем…' : 'Завершить подкрой'}
        </button>
        <button
          type="button"
          className="constructor-btn"
          disabled={pending}
          onClick={() => run(() => cancelRecutAction(session.id))}
        >
          Отменить
        </button>
      </div>
      {error && (
        <p className="constructor-actions__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Запуск подкроя: поиск заказа по номеру
// ---------------------------------------------------------------------------

function StartRecut() {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<RecutOrderSearchItemDto[]>([]);
  const [searching, setSearching] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Монотонный id запроса: игнорируем ответы, пришедшие не по последнему
  // вводу (гонка debounce).
  const reqId = useRef(0);

  useEffect(() => {
    const term = query.trim();
    if (term.length === 0) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const my = ++reqId.current;
    const t = setTimeout(async () => {
      const rows = await searchRecutOrdersAction(term);
      if (my === reqId.current) {
        setResults(rows);
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  function start(orderId: string) {
    setError(null);
    startTransition(async () => {
      const result = await startRecutAction(orderId);
      if (result.ok) {
        router.refresh();
      } else {
        setError(result.error ?? 'Не удалось начать подкрой');
      }
    });
  }

  return (
    <div>
      <p className="constructor-section__empty" style={{ marginTop: 0 }}>
        Найдите заказ по номеру — подкрой можно начать даже по завершённому.
      </p>
      <input
        type="search"
        inputMode="search"
        className="cutter-input"
        placeholder="Номер заказа, напр. O-20260708-0001"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Поиск заказа по номеру"
      />
      {error && (
        <p className="constructor-actions__error" role="alert">
          {error}
        </p>
      )}
      {query.trim().length > 0 && (
        <ul className="constructor-list" style={{ marginTop: '0.75rem' }}>
          {searching && results.length === 0 ? (
            <li className="constructor-section__empty">Ищем…</li>
          ) : results.length === 0 ? (
            <li className="constructor-section__empty">
              Заказы не найдены. Проверьте номер.
            </li>
          ) : (
            results.map((o) => (
              <li key={o.id} className="constructor-list__item">
                <div className="constructor-card">
                  <div className="constructor-card__head">
                    <strong className="constructor-card__name">
                      Заказ {o.number}
                    </strong>
                    <span className="constructor-status">{o.statusLabel}</span>
                  </div>
                  {(o.clientName || o.productSummary) && (
                    <p className="constructor-card__comment">
                      {[o.clientName, o.productSummary]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  )}
                  <div className="constructor-actions">
                    <button
                      type="button"
                      className="constructor-btn constructor-btn--primary"
                      disabled={pending}
                      onClick={() => start(o.id)}
                    >
                      {pending ? 'Начинаем…' : 'Начать подкрой'}
                    </button>
                  </div>
                </div>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Живой таймер: HH:MM:SS от startedAt. Считается только на клиенте (после
// mount), чтобы не ловить hydration-mismatch (SSR не знает текущее время).
// ---------------------------------------------------------------------------

function useElapsed(startedAtIso: string): string | null {
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    const started = new Date(startedAtIso).getTime();
    const tick = () => {
      const sec = Math.max(0, Math.floor((Date.now() - started) / 1000));
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const s = sec % 60;
      const pad = (n: number) => String(n).padStart(2, '0');
      setText(`${pad(h)}:${pad(m)}:${pad(s)}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAtIso]);

  return text;
}
