'use client';

/**
 * Механика «архив → удалить навсегда» для любого списка на `AdminTable`.
 *
 * Обобщение того, что сначала было сделано точечно для номенклатуры
 * (`app/admin/patterns/pattern-archive.tsx`) и для потребностей цеха
 * (`app/admin/workshop-needs/order-archive.tsx`). Разделов девять
 * (техкарты, маршруты, операции, заявки конструктору, цеховой монитор,
 * оборудование, принтеры, сотрудники, поставщики), и переписывать один
 * и тот же провайдер девять раз незачем: сюда вынесены выбор строк,
 * подтверждение, вызов server action, разбор частичного успеха и
 * нижний тулбар. Раздел приносит только свои server actions и слова.
 *
 * Как подключается на серверной странице:
 *
 *   <BulkArchiveProvider
 *     mode={tab}                        // 'active' | 'archive'
 *     allIds={items.map((i) => i.id)}   // для «Очистить архив»
 *     actions={{ archive: xAction, restore: yAction, purge: zAction }}
 *     labels={{ one: 'техкарту', many: 'техкарт', … }}
 *   >
 *     <AdminSectionHeader actions={<BulkArchiveHeaderButton />} … />
 *     <AdminTable columns={[ …, {render: (r) => <BulkArchiveCheckbox id={r.id}/>} ]} … />
 *   </BulkArchiveProvider>
 *
 * Server actions прокидываются пропсами из RSC — Next.js сериализует
 * их как ссылки, поэтому клиентскому компоненту не нужно знать, какой
 * именно модуль он обслуживает.
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
import { describeBulkArchiveSkips } from '@sewing/shared/archive';
import type { BulkArchiveSkipDto } from '@sewing/shared/archive';

export type BulkArchiveMode = 'active' | 'archive';
type OpKind = 'archive' | 'restore' | 'purge';

/** Результат server action раздела (см. `lib/bulk-archive-actions.ts`). */
export interface BulkArchiveActionResult {
  ok: boolean;
  processed: number;
  skipped: BulkArchiveSkipDto[];
  error?: string;
}

export type BulkArchiveAction = (
  ids: string[],
) => Promise<BulkArchiveActionResult>;

export interface BulkArchiveActions {
  archive: BulkArchiveAction;
  restore: BulkArchiveAction;
  purge: BulkArchiveAction;
}

export interface BulkArchiveLabels {
  /** Винительный падеж, ед. ч.: «техкарту», «маршрут», «сотрудника». */
  one: string;
  /** Родительный падеж, мн. ч. для счётчика: «техкарт», «маршрутов». */
  many: string;
  /** Что теряется при удалении навсегда (хвост фразы подтверждения). */
  purgeHint?: string;
  /** Что происходит при архивации (хвост фразы подтверждения). */
  archiveHint?: string;
}

// ---------------------------------------------------------------------------
// Тексты
// ---------------------------------------------------------------------------

function confirmText(
  kind: OpKind,
  count: number,
  labels: BulkArchiveLabels,
): string {
  const n = `${labels.many}: ${count}`;
  if (kind === 'archive') {
    return `Отправить в архив (${n})? ${
      labels.archiveHint ??
      'Записи пропадут из активного списка, данные сохранятся.'
    } Вернуть можно во вкладке «Архив».`;
  }
  if (kind === 'restore') {
    return `Вернуть из архива (${n})? Записи снова появятся в активном списке.`;
  }
  return `Удалить НАВСЕГДА (${n})? ${
    labels.purgeHint ?? 'Восстановить будет нельзя.'
  } Отменить нельзя.`;
}

/** Сообщение о пропущенных записях (частичный успех) либо ошибка. */
function resultMessage(res: BulkArchiveActionResult): string | null {
  if (!res.ok) return res.error ?? 'Не удалось выполнить операцию.';
  if (res.skipped.length === 0) return null;
  return `Обработано: ${res.processed}. Пропущено: ${res.skipped.length} — ${describeBulkArchiveSkips(res.skipped)}.`;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface BulkArchiveContextShape {
  mode: BulkArchiveMode;
  selected: ReadonlySet<string>;
  pending: boolean;
  toggle: (id: string) => void;
  clear: () => void;
  run: (kind: OpKind, ids: string[]) => void;
  allIds: string[];
  labels: BulkArchiveLabels;
}

const Ctx = createContext<BulkArchiveContextShape | null>(null);

export function BulkArchiveProvider({
  mode,
  allIds,
  actions,
  labels,
  children,
}: {
  mode: BulkArchiveMode;
  allIds: string[];
  actions: BulkArchiveActions;
  labels: BulkArchiveLabels;
  children: ReactNode;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [pending, startTransition] = useTransition();

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const clear = useCallback(() => setSelected(new Set()), []);

  const run = useCallback(
    (kind: OpKind, ids: string[]) => {
      if (ids.length === 0) return;
      if (!window.confirm(confirmText(kind, ids.length, labels))) return;
      startTransition(async () => {
        const action =
          kind === 'archive'
            ? actions.archive
            : kind === 'restore'
              ? actions.restore
              : actions.purge;
        const res = await action(ids);
        const message = resultMessage(res);
        if (message) window.alert(message);
        setSelected(new Set());
        router.refresh();
      });
    },
    [router, actions, labels],
  );

  const value = useMemo<BulkArchiveContextShape>(
    () => ({ mode, selected, pending, toggle, clear, run, allIds, labels }),
    [mode, selected, pending, toggle, clear, run, allIds, labels],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      <BulkArchiveToolbar />
    </Ctx.Provider>
  );
}

// ---------------------------------------------------------------------------
// Чекбокс в строке
// ---------------------------------------------------------------------------

export function BulkArchiveCheckbox({ id }: { id: string }) {
  const ctx = useContext(Ctx);
  if (!ctx) return null;
  const checked = ctx.selected.has(id);
  return (
    <input
      type="checkbox"
      className="admin-bulk-check"
      aria-label={checked ? 'Снять выбор' : 'Выбрать строку'}
      checked={checked}
      disabled={ctx.pending}
      onChange={() => ctx.toggle(id)}
    />
  );
}

// ---------------------------------------------------------------------------
// Кнопки действий в строке
// ---------------------------------------------------------------------------

export function BulkArchiveRowActions({
  id,
  /** Строку нельзя архивировать (например, «сам себя») — кнопка гаснет. */
  disabled,
  disabledHint,
}: {
  id: string;
  disabled?: boolean;
  disabledHint?: string;
}) {
  const ctx = useContext(Ctx);
  if (!ctx) return null;

  if (ctx.mode === 'active') {
    return (
      <button
        type="button"
        className="admin-btn admin-btn--ghost admin-table__action-btn"
        disabled={ctx.pending || disabled}
        title={disabled ? disabledHint : 'Скрыть из активного списка (в архив)'}
        onClick={() => ctx.run('archive', [id])}
      >
        <Archive size={15} strokeWidth={1.7} aria-hidden />В архив
      </button>
    );
  }

  return (
    <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
      <button
        type="button"
        className="admin-btn admin-btn--ghost admin-table__action-btn"
        disabled={ctx.pending || disabled}
        title={disabled ? disabledHint : 'Вернуть в активный список'}
        onClick={() => ctx.run('restore', [id])}
      >
        <RotateCcw size={15} strokeWidth={1.7} aria-hidden />
        Вернуть
      </button>
      <button
        type="button"
        className="admin-btn admin-btn--danger admin-table__action-btn"
        disabled={ctx.pending || disabled}
        title={disabled ? disabledHint : 'Удалить навсегда (необратимо)'}
        onClick={() => ctx.run('purge', [id])}
      >
        <Trash2 size={15} strokeWidth={1.7} aria-hidden />
        Удалить
      </button>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Кнопка в шапке: «Очистить архив» (только во вкладке «Архив»)
// ---------------------------------------------------------------------------

/**
 * Массовой кнопки «Архивировать все» сознательно нет: это справочники,
 * и «убрать весь список одним кликом» — сценарий, которого не бывает,
 * зато промах стоит дорого. Чистка архива — наоборот, обычное дело.
 */
export function BulkArchiveHeaderButton() {
  const ctx = useContext(Ctx);
  if (!ctx || ctx.mode !== 'archive' || ctx.allIds.length === 0) return null;
  return (
    <button
      type="button"
      className="admin-btn admin-btn--danger"
      disabled={ctx.pending}
      title="Удалить навсегда всё из архива (кроме того, что используется)"
      onClick={() => ctx.run('purge', ctx.allIds)}
    >
      <Trash2 size={15} strokeWidth={1.7} aria-hidden />
      Очистить архив
    </button>
  );
}

// ---------------------------------------------------------------------------
// Нижний тулбар при выборе
// ---------------------------------------------------------------------------

function BulkArchiveToolbar() {
  const ctx = useContext(Ctx);
  if (!ctx) return null;
  const count = ctx.selected.size;
  if (count === 0) return null;
  const ids = Array.from(ctx.selected);

  return (
    <div
      className="admin-bulk-bar"
      role="region"
      aria-label="Действия с выбранными строками"
    >
      <span className="admin-bulk-bar__count">Выбрано: {count}</span>
      <button
        type="button"
        className="admin-bulk-bar__link"
        onClick={ctx.clear}
        disabled={ctx.pending}
      >
        <X size={14} strokeWidth={2} aria-hidden />
        Снять выбор
      </button>
      <span className="admin-bulk-bar__spacer" />
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
            className="admin-bulk-bar__link"
            disabled={ctx.pending}
            onClick={() => ctx.run('restore', ids)}
          >
            <RotateCcw size={14} strokeWidth={1.8} aria-hidden />
            Вернуть ({count})
          </button>
          <button
            type="button"
            className="admin-btn admin-btn--danger"
            disabled={ctx.pending}
            onClick={() => ctx.run('purge', ids)}
          >
            <Trash2 size={15} strokeWidth={1.7} aria-hidden />
            Удалить навсегда ({count})
          </button>
        </>
      )}
    </div>
  );
}
