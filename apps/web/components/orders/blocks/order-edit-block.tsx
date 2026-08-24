'use client';

/**
 * `OrderEditBlock` — общий паттерн «правка на месте» для блоков карточки
 * заказа (шаг 1 плана из `docs/mockups/order-page-inline-edit-mockup.html`,
 * вторая половина варианта C аудита `docs/order-page-ui-recon.md`).
 *
 * Зачем: правка заказа переезжает из отдельной страницы `/admin/orders/[id]/edit`
 * в блоки самой карточки. Страница правки шлёт снимок ВСЕЙ формы и потому
 * затирает параллельные правки расцветок / нанесения (§1.2 аудита); блоки
 * шлют только своё.
 *
 * Каждый блок живёт в четырёх состояниях — они одинаковы для всех блоков,
 * меняется только содержимое:
 *
 *   1. просмотр      — сводка + карандаш «Править»;
 *   2. правка        — форма блока, соседние блоки только для чтения;
 *   3. сохранено     — сводка + чип «✓ Сохранено» + (опц.) строка следствия
 *                      («потребность пересчитана — 12 строк»);
 *   4. не сохранено  — блок ОСТАЁТСЯ в правке с введёнными значениями,
 *                      сообщение стоит на блоке (не общим баннером сверху),
 *                      рядом «Отменить правку» и «Повторить», а если гейт
 *                      предлагает другой путь — ссылка туда.
 *
 * Инварианты, взятые из макета:
 *   - **один блок за раз**: пока правится соседний, остальные показывают
 *     просмотр без карандаша. Это заменяет dirty-tracking и не даёт двум
 *     несогласованным правкам уехать вместе;
 *   - **правки не теряются при ошибке**: выбросить введённое можно только
 *     явным «Отменить правку»;
 *   - **у каждого блока своё окно правки** — общего не существует. Гейт
 *     приходит пропом `gate` из вызывающего кода, который берёт его из
 *     `OrdersService.update` / `ORDER_*_EDITABLE_STATUSES`, и объясняет
 *     не только «нельзя», но и «как можно» (`gate.action`).
 *
 * Backend / DTO / Prisma не задействованы — это presentation-слой. Сохранение
 * целиком на совести формы внутри блока: она сама зовёт свой server action и
 * докладывает результат через `api.saved()` / `api.failed()`.
 *
 * Как форма получает `api`: через контекст (`useOrderEditBlockApi()`), а НЕ
 * render-prop-ом. Блоки живут внутри серверных компонентов (шапка карточки —
 * server component), а функцию нельзя передать пропом из server в client:
 * React отвечает «Functions are not valid as a child of Client Components».
 * Поэтому `children` — обычный ReactNode: он собирается на сервере, но
 * рендерится блоком только в состоянии «правка».
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import { AlertCircle, Check, Pencil, RotateCcw, X } from 'lucide-react';

/** Ссылка «другим путём» — например, на правку тиража в производстве. */
export interface OrderEditBlockAction {
  href: string;
  label: string;
}

/**
 * Окно правки конкретного блока. Источник истины — код backend-а
 * (`OrdersService.update`, константы `ORDER_*_EDITABLE_STATUSES`), а не
 * этот компонент: он лишь показывает то, что ему передали.
 */
export interface OrderEditBlockGate {
  /** Можно ли править прямо сейчас. */
  editable: boolean;
  /** Почему нельзя — человеческим языком, в просмотре вместо карандаша. */
  reason?: string;
  /** Куда идти, если правка возможна, но другим путём. */
  action?: OrderEditBlockAction;
}

/** То, что блок даёт форме внутри себя. */
export interface OrderEditBlockApi {
  /** Закрыть правку, выбросив введённое. */
  cancel: () => void;
  /**
   * Сохранение прошло: блок возвращается в просмотр и показывает чип
   * «Сохранено». `consequence` — короткая строка последствия правки
   * (например, «Потребность пересчитана — 12 строк»).
   */
  saved: (consequence?: ReactNode) => void;
  /**
   * Сохранение не прошло: блок ОСТАЁТСЯ в правке, сообщение встаёт на нём.
   * `retry` — повторить тот же запрос, `action` — уйти другим путём.
   */
  failed: (
    message: string,
    opts?: { retry?: () => void; action?: OrderEditBlockAction },
  ) => void;
}

// ---------------------------------------------------------------------------
// «Один блок за раз»
// ---------------------------------------------------------------------------

interface BlocksContextValue {
  activeId: string | null;
  /** Занять правку. `false` — уже правится другой блок. */
  request: (id: string) => boolean;
  release: (id: string) => void;
}

/**
 * Дефолт для блока, отрисованного вне провайдера: правка всегда разрешена.
 * Так одиночный блок работает без обвязки (и не падает в тестах).
 */
const BlocksContext = createContext<BlocksContextValue | null>(null);

/**
 * Обёртка вокруг карточки заказа. Держит id блока, который сейчас правится,
 * — остальные блоки внутри становятся read-only.
 */
export function OrderEditBlocksProvider({ children }: { children: ReactNode }) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const value = useMemo<BlocksContextValue>(
    () => ({
      activeId,
      request: (id) => {
        let ok = false;
        setActiveId((current) => {
          if (current === null || current === id) {
            ok = true;
            return id;
          }
          return current;
        });
        // `setActiveId` синхронно вызывает updater — на момент выхода
        // из него `ok` уже проставлен.
        return ok;
      },
      release: (id) =>
        setActiveId((current) => (current === id ? null : current)),
    }),
    [activeId],
  );
  return (
    <BlocksContext.Provider value={value}>{children}</BlocksContext.Provider>
  );
}

/**
 * Контекст блока для формы внутри него. Пустой (`null`) — форма
 * отрисована вне блока: тогда `useOrderEditBlockApi()` вернёт no-op,
 * и форма продолжит работать как обычная (полезно в тестах).
 */
const ApiContext = createContext<OrderEditBlockApi | null>(null);

const NOOP_API: OrderEditBlockApi = {
  cancel: () => {},
  saved: () => {},
  failed: () => {},
};

/** Доступ к состояниям блока изнутри его формы. */
export function useOrderEditBlockApi(): OrderEditBlockApi {
  return useContext(ApiContext) ?? NOOP_API;
}

interface Props {
  /**
   * Стабильный код блока: `basics`, `colorways`, `route`, … Он же поедет
   * в `?edit=<id>` на шаге 4 плана (адресация блока ссылкой из алерта).
   */
  id: string;
  title: string;
  icon?: ReactNode;
  /** Содержимое состояния «просмотр» — сводка блока. */
  summary: ReactNode;
  /** Окно правки. По умолчанию — правка разрешена. */
  gate?: OrderEditBlockGate;
  /** Подпись карандаша. Default — «Править». */
  editLabel?: string;
  /**
   * Форма блока. Рендерится только в состоянии «правка»; результат
   * сохранения докладывает через `useOrderEditBlockApi()`.
   */
  children: ReactNode;
}

export function OrderEditBlock({
  id,
  title,
  icon,
  summary,
  gate,
  editLabel = 'Править',
  children,
}: Props) {
  const blocks = useContext(BlocksContext);
  const [editing, setEditing] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [consequence, setConsequence] = useState<ReactNode>(null);
  const [failure, setFailure] = useState<{
    message: string;
    retry?: () => void;
    action?: OrderEditBlockAction;
  } | null>(null);

  const editable = gate?.editable ?? true;
  // Соседний блок в правке — этот показывает просмотр без карандаша.
  const blockedByNeighbour =
    blocks != null && blocks.activeId !== null && blocks.activeId !== id;

  const stopEditing = useCallback(() => {
    setEditing(false);
    setFailure(null);
    blocks?.release(id);
  }, [blocks, id]);

  const api = useMemo<OrderEditBlockApi>(
    () => ({
      cancel: stopEditing,
      saved: (nextConsequence) => {
        setConsequence(nextConsequence ?? null);
        setSavedAt(Date.now());
        stopEditing();
      },
      failed: (message, opts) =>
        setFailure({ message, retry: opts?.retry, action: opts?.action }),
    }),
    [stopEditing],
  );

  // Чип «Сохранено» гаснет сам — он подтверждение, а не статус.
  useEffect(() => {
    if (savedAt === null) return undefined;
    const timer = setTimeout(() => {
      setSavedAt(null);
      setConsequence(null);
    }, 8000);
    return () => clearTimeout(timer);
  }, [savedAt]);

  // Блок мог остаться «активным» в провайдере, если его размонтировали
  // прямо из правки (переключение вкладки карточки).
  const releaseRef = useRef(stopEditing);
  releaseRef.current = stopEditing;
  useEffect(() => () => releaseRef.current(), []);

  const startEditing = (): void => {
    if (!editable || blockedByNeighbour) return;
    if (blocks && !blocks.request(id)) return;
    setSavedAt(null);
    setConsequence(null);
    setFailure(null);
    setEditing(true);
  };

  const state = editing ? (failure ? 'failed' : 'editing') : 'view';

  return (
    <section
      className={`order-edit-block order-edit-block--${state}`}
      data-block={id}
      data-state={state}
      aria-label={title}
    >
      <header className="order-edit-block__head">
        <h3 className="order-edit-block__title">
          {icon && (
            <span className="order-edit-block__icon" aria-hidden>
              {icon}
            </span>
          )}
          {title}
        </h3>

        <div className="order-edit-block__head-actions">
          {state === 'editing' && (
            <span className="order-edit-block__chip order-edit-block__chip--editing">
              правка
            </span>
          )}
          {state === 'failed' && (
            <span className="order-edit-block__chip order-edit-block__chip--failed">
              не сохранено
            </span>
          )}
          {state === 'view' && savedAt !== null && (
            <span
              className="order-edit-block__chip order-edit-block__chip--saved"
              role="status"
            >
              <Check size={13} strokeWidth={2.2} aria-hidden /> Сохранено
            </span>
          )}
          {state === 'view' && editable && !blockedByNeighbour && (
            <button
              type="button"
              className="admin-btn admin-btn--ghost order-edit-block__edit"
              onClick={startEditing}
            >
              <Pencil size={14} strokeWidth={1.7} aria-hidden />
              {editLabel}
            </button>
          )}
          {state === 'view' && !editable && gate?.action && (
            <Link
              href={gate.action.href}
              className="admin-btn admin-btn--ghost order-edit-block__edit"
            >
              {gate.action.label} →
            </Link>
          )}
        </div>
      </header>

      {state === 'view' ? (
        <>
          <div className="order-edit-block__summary">{summary}</div>
          {consequence && savedAt !== null && (
            <p className="order-edit-block__consequence">{consequence}</p>
          )}
          {!editable && gate?.reason && (
            <p className="order-edit-block__gate">{gate.reason}</p>
          )}
          {editable && blockedByNeighbour && (
            <p className="order-edit-block__gate">
              Пока правится соседний блок, остальные только для чтения.
            </p>
          )}
        </>
      ) : (
        <div className="order-edit-block__body">
          {failure && (
            <div className="order-edit-block__failure" role="alert">
              <AlertCircle size={16} strokeWidth={1.7} aria-hidden />
              <div className="order-edit-block__failure-text">
                <span>{failure.message}</span>
                {failure.action && (
                  <Link
                    href={failure.action.href}
                    className="order-edit-block__failure-link"
                  >
                    {failure.action.label} →
                  </Link>
                )}
              </div>
              <div className="order-edit-block__failure-actions">
                <button
                  type="button"
                  className="admin-btn admin-btn--ghost"
                  onClick={stopEditing}
                >
                  <X size={14} strokeWidth={1.7} aria-hidden />
                  Отменить правку
                </button>
                {failure.retry && (
                  <button
                    type="button"
                    className="admin-btn"
                    onClick={failure.retry}
                  >
                    <RotateCcw size={14} strokeWidth={1.7} aria-hidden />
                    Повторить
                  </button>
                )}
              </div>
            </div>
          )}
          <ApiContext.Provider value={api}>{children}</ApiContext.Provider>
        </div>
      )}
    </section>
  );
}
