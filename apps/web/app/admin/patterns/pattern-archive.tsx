'use client';

/**
 * Клиентская механика архива номенклатуры на `/admin/patterns`.
 *
 * Двухшаговое удаление — как в «Архиве расчётов цеха»
 * (`app/admin/workshop-needs/order-archive.tsx`): сначала карточка
 * уезжает в архив (обратимо, ничего не теряется), и только из архива её
 * можно стереть безвозвратно. Единица операции — карточка
 * номенклатуры (`PatternItem`).
 *
 * Две вкладки списка:
 *   - «Номенклатура» (`mode='active'`): чекбокс в строке + кнопка
 *     «В архив»; нижний тулбар при выборе — «В архив (N)».
 *   - «Архив» (`mode='archive'`): чекбокс + «Вернуть» / «Удалить
 *     навсегда»; в шапке «Очистить архив»; тулбар — «Вернуть (N)» /
 *     «Удалить навсегда (N)».
 *
 * Кнопки «Архивировать все» сознательно НЕТ (в отличие от потребностей):
 * номенклатура — справочник, «убрать весь каталог одним кликом» слишком
 * опасно и не имеет сценария.
 *
 * Выбор живёт в React Context, чтобы чекбоксы внутри серверного
 * `AdminTable` дотягивались до состояния без props-drilling. Операции —
 * server actions (`archive-actions.ts`), подтверждение через
 * `window.confirm`, пропущенные карточки (не прошли гейт — например,
 * их используют заказы) показываем через `window.alert`.
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
import { PATTERN_ARCHIVE_SKIP_REASON_LABELS } from '@sewing/shared/patterns';
import {
  archivePatternsAction,
  purgePatternsAction,
  restorePatternsAction,
  type PatternsArchiveActionResult,
} from './archive-actions';

export type PatternArchiveMode = 'active' | 'archive';
type OpKind = 'archive' | 'restore' | 'purge';

// ---------------------------------------------------------------------------
// Тексты
// ---------------------------------------------------------------------------

function confirmText(kind: OpKind, count: number): string {
  const n = `номенклатур: ${count}`;
  if (kind === 'archive') {
    return `Отправить в архив (${n})? Карточки пропадут из активного справочника и перестанут предлагаться в заказах и техкартах. Данные сохранятся — вернуть можно во вкладке «Архив».`;
  }
  if (kind === 'restore') {
    return `Вернуть из архива (${n})? Карточки снова появятся в активном справочнике.`;
  }
  return `Удалить НАВСЕГДА (${n})? Вместе с карточкой пропадут её размеры, файлы лекал, площади, нормы и связанная задача конструктора. Отменить нельзя.`;
}

/** Сообщение о пропущенных карточках (частичный успех) либо ошибка. */
function resultMessage(res: PatternsArchiveActionResult): string | null {
  if (!res.ok) return res.error ?? 'Не удалось выполнить операцию.';
  if (res.skipped.length === 0) return null;
  const reasons = Array.from(
    new Set(
      res.skipped.map((s) => PATTERN_ARCHIVE_SKIP_REASON_LABELS[s.reason]),
    ),
  );
  return `Обработано: ${res.processed}. Пропущено: ${res.skipped.length} — ${reasons.join('; ')}. Номенклатуру, на которую ссылаются заказы, удалить навсегда нельзя — оставьте её в архиве.`;
}

function actionFor(kind: OpKind) {
  if (kind === 'archive') return archivePatternsAction;
  if (kind === 'restore') return restorePatternsAction;
  return purgePatternsAction;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface ArchiveContextShape {
  mode: PatternArchiveMode;
  selected: ReadonlySet<string>;
  pending: boolean;
  toggle: (patternId: string) => void;
  clear: () => void;
  /** Запустить операцию над явным списком id (строка / тулбар / «все»). */
  run: (kind: OpKind, patternIds: string[]) => void;
  /** Все id текущей выдачи — для кнопки «Очистить архив». */
  allPatternIds: string[];
}

const ArchiveCtx = createContext<ArchiveContextShape | null>(null);

export function PatternArchiveProvider({
  mode,
  allPatternIds,
  children,
}: {
  mode: PatternArchiveMode;
  allPatternIds: string[];
  children: ReactNode;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [pending, startTransition] = useTransition();

  const toggle = useCallback((patternId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(patternId)) next.delete(patternId);
      else next.add(patternId);
      return next;
    });
  }, []);

  const clear = useCallback(() => setSelected(new Set()), []);

  const run = useCallback(
    (kind: OpKind, patternIds: string[]) => {
      if (patternIds.length === 0) return;
      if (!window.confirm(confirmText(kind, patternIds.length))) return;
      startTransition(async () => {
        const res = await actionFor(kind)(patternIds);
        const message = resultMessage(res);
        if (message) window.alert(message);
        setSelected(new Set());
        router.refresh();
      });
    },
    [router],
  );

  const value = useMemo<ArchiveContextShape>(
    () => ({ mode, selected, pending, toggle, clear, run, allPatternIds }),
    [mode, selected, pending, toggle, clear, run, allPatternIds],
  );

  return (
    <ArchiveCtx.Provider value={value}>
      {children}
      <PatternArchiveToolbar />
    </ArchiveCtx.Provider>
  );
}

// ---------------------------------------------------------------------------
// Чекбокс в строке таблицы
// ---------------------------------------------------------------------------

export function PatternArchiveCheckbox({ patternId }: { patternId: string }) {
  const ctx = useContext(ArchiveCtx);
  if (!ctx) return null;
  const checked = ctx.selected.has(patternId);
  return (
    <input
      type="checkbox"
      className="admin-bulk-check"
      aria-label={checked ? 'Снять выбор номенклатуры' : 'Выбрать номенклатуру'}
      checked={checked}
      disabled={ctx.pending}
      onChange={() => ctx.toggle(patternId)}
    />
  );
}

// ---------------------------------------------------------------------------
// Кнопки действий в строке
// ---------------------------------------------------------------------------

export function PatternArchiveRowActions({
  patternId,
}: {
  patternId: string;
}) {
  const ctx = useContext(ArchiveCtx);
  if (!ctx) return null;

  if (ctx.mode === 'active') {
    return (
      <button
        type="button"
        className="admin-btn admin-btn--ghost admin-table__action-btn"
        disabled={ctx.pending}
        title="Скрыть из активного справочника (в архив)"
        onClick={() => ctx.run('archive', [patternId])}
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
        disabled={ctx.pending}
        title="Вернуть в активный справочник"
        onClick={() => ctx.run('restore', [patternId])}
      >
        <RotateCcw size={15} strokeWidth={1.7} aria-hidden />
        Вернуть
      </button>
      <button
        type="button"
        className="admin-btn admin-btn--danger admin-table__action-btn"
        disabled={ctx.pending}
        title="Удалить навсегда (необратимо)"
        onClick={() => ctx.run('purge', [patternId])}
      >
        <Trash2 size={15} strokeWidth={1.7} aria-hidden />
        Удалить
      </button>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Кнопка в шапке списка: «Очистить архив» (только во вкладке «Архив»)
// ---------------------------------------------------------------------------

export function PatternArchiveHeaderButton() {
  const ctx = useContext(ArchiveCtx);
  if (!ctx || ctx.mode !== 'archive' || ctx.allPatternIds.length === 0) {
    return null;
  }
  return (
    <button
      type="button"
      className="admin-btn admin-btn--danger"
      disabled={ctx.pending}
      title="Удалить навсегда все карточки архива (кроме тех, что используют заказы)"
      onClick={() => ctx.run('purge', ctx.allPatternIds)}
    >
      <Trash2 size={15} strokeWidth={1.7} aria-hidden />
      Очистить архив
    </button>
  );
}

// ---------------------------------------------------------------------------
// Нижний тулбар при выборе
// ---------------------------------------------------------------------------

function PatternArchiveToolbar() {
  const ctx = useContext(ArchiveCtx);
  if (!ctx) return null;
  const count = ctx.selected.size;
  if (count === 0) return null;
  const ids = Array.from(ctx.selected);

  return (
    <div
      className="admin-bulk-bar"
      role="region"
      aria-label="Действия с выбранной номенклатурой"
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
