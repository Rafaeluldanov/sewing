'use client';

/**
 * Клиентская механика архива заказов на экране `/admin/workshop-needs`.
 *
 * Единица операции — заказ ЦЕЛИКОМ (не строка потребности). Две вкладки:
 *   - «Потребности» (`mode='active'`): у карточки чекбокс + кнопка
 *     «В архив»; в шапке списка «Архивировать все»; нижний тулбар при
 *     выборе — «В архив (N)».
 *   - «Архив» (`mode='archive'`): чекбокс + «Восстановить» /
 *     «Удалить безвозвратно»; в шапке «Очистить архив»; нижний тулбар —
 *     «Восстановить (N)» / «Удалить безвозвратно (N)».
 *
 * Выбор живёт в React Context (как `BulkCreatePoProvider`), чтобы
 * чекбоксы в шапках серверных карточек дотягивались до состояния без
 * props-drilling. Операции — server actions (`archive-actions.ts`),
 * подтверждение через `window.confirm`, пропущенные заказы (не прошли
 * гейт) показываем через `window.alert`. Деструктивное удаление — только
 * из архива и с явным подтверждением.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useTransition,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import { Archive, RotateCcw, Trash2, X } from 'lucide-react';
import { WORKSHOP_NEED_ARCHIVE_SKIP_REASON_LABELS } from '@sewing/shared/workshop-needs';
import {
  archiveWorkshopNeedsAction,
  purgeWorkshopNeedsAction,
  restoreWorkshopNeedsAction,
  type ArchiveActionResult,
} from './archive-actions';

export type ArchiveMode = 'active' | 'archive';
type OpKind = 'archive' | 'restore' | 'purge';

// ---------------------------------------------------------------------------
// Тексты
// ---------------------------------------------------------------------------

function confirmText(kind: OpKind, count: number): string {
  const n = `заказов: ${count}`;
  if (kind === 'archive') {
    return `Отправить в архив (${n})? Заказы скроются из списка потребностей, данные сохранятся — восстановить можно во вкладке «Архив».`;
  }
  if (kind === 'restore') {
    return `Вернуть из архива (${n})? Заказы снова появятся во вкладке «Потребности».`;
  }
  return `Удалить БЕЗВОЗВРАТНО просчёт (${n})? Все варианты просчёта и строки потребности будут стёрты. Отменить нельзя.`;
}

/** Сообщение о пропущенных заказах (частичный успех) либо ошибка. */
function resultMessage(res: ArchiveActionResult): string | null {
  if (!res.ok) return res.error ?? 'Не удалось выполнить операцию.';
  if (res.skipped.length === 0) return null;
  const reasons = Array.from(
    new Set(
      res.skipped.map((s) => WORKSHOP_NEED_ARCHIVE_SKIP_REASON_LABELS[s.reason]),
    ),
  );
  return `Обработано заказов: ${res.processed}. Пропущено: ${res.skipped.length} — ${reasons.join('; ')}.`;
}

function actionFor(kind: OpKind) {
  if (kind === 'archive') return archiveWorkshopNeedsAction;
  if (kind === 'restore') return restoreWorkshopNeedsAction;
  return purgeWorkshopNeedsAction;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface ArchiveContextShape {
  mode: ArchiveMode;
  selected: ReadonlySet<string>;
  pending: boolean;
  toggle: (orderId: string) => void;
  clear: () => void;
  /** Запустить операцию над явным списком id (карточка / тулбар / «все»). */
  run: (kind: OpKind, orderIds: string[]) => void;
  /** Все id списка — для кнопки «Архивировать все» / «Очистить архив». */
  allOrderIds: string[];
}

const ArchiveCtx = createContext<ArchiveContextShape | null>(null);

export function OrderArchiveProvider({
  mode,
  allOrderIds,
  children,
}: {
  mode: ArchiveMode;
  allOrderIds: string[];
  children: ReactNode;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [pending, startTransition] = useTransition();

  const toggle = useCallback((orderId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(orderId)) next.delete(orderId);
      else next.add(orderId);
      return next;
    });
  }, []);

  const clear = useCallback(() => setSelected(new Set()), []);

  const run = useCallback(
    (kind: OpKind, orderIds: string[]) => {
      if (orderIds.length === 0) return;
      if (!window.confirm(confirmText(kind, orderIds.length))) return;
      startTransition(async () => {
        const res = await actionFor(kind)(orderIds);
        const message = resultMessage(res);
        if (message) window.alert(message);
        setSelected(new Set());
        router.refresh();
      });
    },
    [router],
  );

  const value = useMemo<ArchiveContextShape>(
    () => ({ mode, selected, pending, toggle, clear, run, allOrderIds }),
    [mode, selected, pending, toggle, clear, run, allOrderIds],
  );

  return (
    <ArchiveCtx.Provider value={value}>
      {children}
      <OrderArchiveToolbar />
    </ArchiveCtx.Provider>
  );
}

// ---------------------------------------------------------------------------
// Чекбокс в шапке карточки заказа
// ---------------------------------------------------------------------------

export function OrderArchiveCheckbox({ orderId }: { orderId: string }) {
  const ctx = useContext(ArchiveCtx);
  if (!ctx) return null;
  const checked = ctx.selected.has(orderId);
  return (
    <input
      type="checkbox"
      className="wn-archive-check"
      aria-label={checked ? 'Снять выбор заказа' : 'Выбрать заказ'}
      checked={checked}
      disabled={ctx.pending}
      onChange={() => ctx.toggle(orderId)}
    />
  );
}

// ---------------------------------------------------------------------------
// Кнопки действий в карточке
// ---------------------------------------------------------------------------

export function OrderArchiveRowActions({
  orderId,
  archivable,
}: {
  orderId: string;
  /** Заказ на стадии расчёта — можно архивировать (для mode='active'). */
  archivable: boolean;
}) {
  const ctx = useContext(ArchiveCtx);
  if (!ctx) return null;

  if (ctx.mode === 'active') {
    return (
      <button
        type="button"
        className="admin-btn admin-btn--ghost workshop-order-group-card__action wn-archive-btn"
        disabled={ctx.pending || !archivable}
        title={
          archivable
            ? 'Скрыть заказ из списка потребностей (в архив)'
            : 'Заказ не на стадии расчёта — архивировать нельзя'
        }
        onClick={() => ctx.run('archive', [orderId])}
      >
        <Archive size={15} strokeWidth={1.7} aria-hidden />В архив
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        className="admin-btn admin-btn--ghost workshop-order-group-card__action"
        disabled={ctx.pending}
        onClick={() => ctx.run('restore', [orderId])}
      >
        <RotateCcw size={15} strokeWidth={1.7} aria-hidden />
        Восстановить
      </button>
      <button
        type="button"
        className="admin-btn admin-btn--danger workshop-order-group-card__action"
        disabled={ctx.pending}
        onClick={() => ctx.run('purge', [orderId])}
      >
        <Trash2 size={15} strokeWidth={1.7} aria-hidden />
        Удалить безвозвратно
      </button>
    </>
  );
}

// ---------------------------------------------------------------------------
// Кнопка в шапке списка: «Архивировать все» / «Очистить архив»
// ---------------------------------------------------------------------------

export function OrderArchiveHeaderButton() {
  const ctx = useContext(ArchiveCtx);
  if (!ctx || ctx.allOrderIds.length === 0) return null;

  if (ctx.mode === 'active') {
    return (
      <button
        type="button"
        className="admin-btn admin-btn--ghost wn-archive-all"
        disabled={ctx.pending}
        onClick={() => ctx.run('archive', ctx.allOrderIds)}
      >
        <Archive size={15} strokeWidth={1.7} aria-hidden />
        Архивировать все
      </button>
    );
  }

  return (
    <button
      type="button"
      className="admin-btn admin-btn--danger wn-archive-all"
      disabled={ctx.pending}
      onClick={() => ctx.run('purge', ctx.allOrderIds)}
    >
      <Trash2 size={15} strokeWidth={1.7} aria-hidden />
      Очистить архив
    </button>
  );
}

// ---------------------------------------------------------------------------
// Нижний тулбар при выборе
// ---------------------------------------------------------------------------

function OrderArchiveToolbar() {
  const ctx = useContext(ArchiveCtx);
  if (!ctx) return null;
  const count = ctx.selected.size;
  if (count === 0) return null;
  const ids = Array.from(ctx.selected);

  return (
    <div className="wn-archive-bar" role="region" aria-label="Действия с выбранными заказами">
      <span className="wn-archive-bar__count">Выбрано заказов: {count}</span>
      <button
        type="button"
        className="wn-archive-bar__link"
        onClick={ctx.clear}
        disabled={ctx.pending}
      >
        <X size={14} strokeWidth={2} aria-hidden />
        Снять выбор
      </button>
      <span className="wn-archive-bar__spacer" />
      {ctx.mode === 'active' ? (
        <button
          type="button"
          className="admin-btn admin-btn--primary"
          disabled={ctx.pending}
          onClick={() => ctx.run('archive', ids)}
        >
          <Archive size={15} strokeWidth={1.7} aria-hidden />В архив ({count})
        </button>
      ) : (
        <>
          <button
            type="button"
            className="wn-archive-bar__link"
            disabled={ctx.pending}
            onClick={() => ctx.run('restore', ids)}
          >
            <RotateCcw size={14} strokeWidth={1.8} aria-hidden />
            Восстановить ({count})
          </button>
          <button
            type="button"
            className="admin-btn admin-btn--danger"
            disabled={ctx.pending}
            onClick={() => ctx.run('purge', ids)}
          >
            <Trash2 size={15} strokeWidth={1.7} aria-hidden />
            Удалить безвозвратно ({count})
          </button>
        </>
      )}
    </div>
  );
}
