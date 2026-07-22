'use client';

/**
 * Сворачивание на экране закупщика `/admin/workshop-needs`.
 *
 * Три уровня (согласованный макет):
 *   1. вся страница — кнопка «Свернуть все / Развернуть все»
 *      (`CollapseAllButton`) рядом с фильтрами;
 *   2. карточка заказа — `CollapsibleOrderCard` (шапка видна всегда,
 *      вкладки вариантов + секции прячутся);
 *   3. секция «Материалы / Фурнитура / …» — `CollapsibleSection`
 *      (в заголовке количество и сумма, поэтому свёрнутую секцию видно
 *      в деньгах).
 *
 * Всё по умолчанию РАЗВЁРНУТО — экран выглядит как раньше, сворачивание
 * добровольное. Состояние живёт только в памяти вкладки браузера
 * (перезагрузка возвращает всё развёрнутым) — сознательно, чтобы не
 * заводить persist ради вспомогательного UI.
 *
 * Server-компоненты (карточка заказа, строки потребности) передаются
 * сюда как `children` и `head` — их разметка не меняется.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { ChevronDown } from 'lucide-react';

interface CollapseCtx {
  /** Зарегистрировать карточку; возвращает её текущее состояние. */
  register: (id: string) => void;
  unregister: (id: string) => void;
  isOpen: (id: string) => boolean;
  toggle: (id: string) => void;
  /** Все ли зарегистрированные карточки развёрнуты. */
  allOpen: boolean;
  toggleAll: () => void;
}

const Ctx = createContext<CollapseCtx | null>(null);

export function CollapseProvider({ children }: { children: ReactNode }) {
  // id карточки → открыта ли. Отсутствие ключа = открыта (default).
  const [closed, setClosed] = useState<Record<string, true>>({});
  const [ids, setIds] = useState<string[]>([]);

  const register = useCallback((id: string) => {
    setIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }, []);
  const unregister = useCallback((id: string) => {
    setIds((prev) => prev.filter((x) => x !== id));
  }, []);
  const isOpen = useCallback((id: string) => !closed[id], [closed]);
  const toggle = useCallback((id: string) => {
    setClosed((prev) => {
      const next = { ...prev };
      if (next[id]) delete next[id];
      else next[id] = true;
      return next;
    });
  }, []);

  const allOpen = ids.length > 0 && ids.every((id) => !closed[id]);

  const toggleAll = useCallback(() => {
    setClosed((prev) => {
      const everyOpen = ids.length > 0 && ids.every((id) => !prev[id]);
      if (everyOpen) {
        const next: Record<string, true> = {};
        for (const id of ids) next[id] = true;
        return next;
      }
      return {};
    });
  }, [ids]);

  const value = useMemo(
    () => ({ register, unregister, isOpen, toggle, allOpen, toggleAll }),
    [register, unregister, isOpen, toggle, allOpen, toggleAll],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Кнопка массового сворачивания. Без провайдера не рендерится. */
export function CollapseAllButton() {
  const ctx = useContext(Ctx);
  if (!ctx) return null;
  return (
    <button
      type="button"
      className="admin-btn admin-btn--ghost wn-collapse-all"
      onClick={ctx.toggleAll}
    >
      {ctx.allOpen ? 'Свернуть все' : 'Развернуть все'}
      <ChevronDown
        size={15}
        strokeWidth={2}
        aria-hidden
        className={
          ctx.allOpen ? 'wn-chev wn-chev--open' : 'wn-chev'
        }
      />
    </button>
  );
}

/**
 * Карточка заказа со сворачиванием: `head` видна всегда, `children`
 * (вкладки вариантов + секции) прячутся. `summary` — короткая строка
 * под шапкой в свёрнутом виде («2 варианта · 6 строк»).
 */
export function CollapsibleOrderCard({
  id,
  head,
  summary,
  children,
}: {
  id: string;
  head: ReactNode;
  summary?: ReactNode;
  children: ReactNode;
}) {
  const ctx = useContext(Ctx);
  useEffect(() => {
    if (!ctx) return;
    ctx.register(id);
    return () => ctx.unregister(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const open = ctx ? ctx.isOpen(id) : true;
  return (
    <article className="workshop-order-group-card" data-open={open || undefined}>
      <div className="wn-card-headline">
        {head}
        {ctx && (
          <button
            type="button"
            className="wn-card-toggle"
            aria-expanded={open}
            aria-label={open ? 'Свернуть заказ' : 'Развернуть заказ'}
            title={open ? 'Свернуть заказ' : 'Развернуть заказ'}
            onClick={() => ctx.toggle(id)}
          >
            <ChevronDown
              size={16}
              strokeWidth={2}
              aria-hidden
              className={open ? 'wn-chev wn-chev--open' : 'wn-chev'}
            />
          </button>
        )}
      </div>
      {!open && summary ? (
        <div className="wn-card-collapsed">{summary}</div>
      ) : null}
      {open ? children : null}
    </article>
  );
}

/**
 * Секция «Материалы / Фурнитура / …» со сворачиванием. В заголовке:
 * название, количество строк и сумма (сумма видна и в свёрнутом виде).
 */
export function CollapsibleSection({
  kind,
  label,
  count,
  sum,
  children,
}: {
  kind: string;
  label: string;
  count: number;
  sum?: string | null;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section
      className={`workshop-need-section workshop-need-section--${kind.toLowerCase()}`}
      data-open={open || undefined}
    >
      <button
        type="button"
        className="workshop-need-section__header wn-section-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="workshop-need-section__label">{label}</span>
        <span className="workshop-need-section__count">{count}</span>
        {sum ? <span className="wn-section-sum">{sum}</span> : null}
        <ChevronDown
          size={15}
          strokeWidth={2}
          aria-hidden
          className={open ? 'wn-chev wn-chev--open' : 'wn-chev'}
        />
      </button>
      {open ? <div className="workshop-need-section__rows">{children}</div> : null}
    </section>
  );
}
