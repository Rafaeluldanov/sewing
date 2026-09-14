'use client';

/**
 * Автосохранение строк потребности на `/admin/workshop-needs`.
 *
 * Раньше строка уезжала на backend только по галочке «Сохранить»
 * (`ZoneSaveButton`). Всё, что закупщик ввёл и не сохранил, жило только
 * в памяти вкладки: сворачивание карточки заказа (`CollapsibleOrderCard`
 * демонтирует строки), переключение варианта просчёта, drill-in по зоне
 * «Расчёт», F5 — и введённое пропадало. Главный сценарий потери —
 * «Завершить расчёт» по несохранённым строкам: backend отвечал
 * «заполните данные по строке», закупщик видел ошибку и пустые поля.
 *
 * Теперь строка сохраняется сама — по уходу из поля / смене селекта
 * (см. `InlineEditWorkshopNeedRow`). Провайдер здесь решает две задачи:
 *
 *   1. считает сохранения «в полёте» (`begin`/`end` вокруг server-action
 *      строки);
 *   2. даёт «Завершить расчёт» способ ДОЖДАТЬСЯ строк: `flushAll()`
 *      просит каждую смонтированную строку сохранить несохранённое и
 *      резолвится, когда сохранений в полёте не осталось. Без этого
 *      blur последнего поля и клик по кнопке уходили на сервер
 *      одновременно, и завершение расчёта читало ещё не записанную
 *      цену.
 *
 * Счётчик и реестр строк живут в ref-ах, а не в state: `flushAll`
 * должен видеть `begin()` синхронно, в том же тике, что и
 * `requestSubmit()` строки (React зовёт action `useFormState`
 * синхронно, пока очередь действий формы пуста).
 */

import {
  createContext,
  useContext,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';

/** Страховка `flushAll`: дольше этого кнопку не держим, даже если что-то зависло. */
const FLUSH_MAX_WAIT_MS = 8000;

export interface WorkshopNeedAutosaveCtx {
  /**
   * Строка регистрирует свой `flush` (сохранить, если есть несохранённое).
   * Возвращает функцию снятия регистрации — для cleanup эффекта.
   */
  register: (id: string, flush: () => void) => () => void;
  /** Сохранение строки началось. */
  begin: () => void;
  /** Сохранение строки завершилось (успехом или ошибкой). */
  end: () => void;
  /**
   * Дёрнуть `flush` у всех смонтированных строк и дождаться, пока
   * сохранений в полёте не останется.
   */
  flushAll: () => Promise<void>;
}

const Ctx = createContext<WorkshopNeedAutosaveCtx | null>(null);

export function WorkshopNeedAutosaveProvider({
  children,
}: {
  children: ReactNode;
}) {
  const rows = useRef(new Map<string, () => void>());
  const pending = useRef(0);
  const waiters = useRef<Array<() => void>>([]);

  const value = useMemo<WorkshopNeedAutosaveCtx>(() => {
    const notifyIfIdle = () => {
      if (pending.current !== 0) return;
      const list = waiters.current;
      waiters.current = [];
      for (const resolve of list) resolve();
    };
    return {
      register(id, flush) {
        rows.current.set(id, flush);
        return () => {
          rows.current.delete(id);
        };
      },
      begin() {
        pending.current += 1;
      },
      end() {
        pending.current = Math.max(0, pending.current - 1);
        // Очередь `useFormState` запускает следующее действие строки в
        // микрозадаче после завершения предыдущего — между `end()` и
        // следующим `begin()` счётчик на миг равен нулю. Проверяем
        // в макрозадаче, когда очередь уже продвинулась.
        if (pending.current === 0) setTimeout(notifyIfIdle, 0);
      },
      flushAll() {
        for (const flush of rows.current.values()) flush();
        return new Promise<void>((resolve) => {
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            resolve();
          };
          // Такт на то, чтобы `requestSubmit()` строк дошёл до `begin()`.
          setTimeout(() => {
            if (pending.current === 0) finish();
            else waiters.current.push(finish);
          }, 0);
          setTimeout(finish, FLUSH_MAX_WAIT_MS);
        });
      },
    };
  }, []);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** `null` вне провайдера — строка тогда работает без учёта «в полёте». */
export function useWorkshopNeedAutosave(): WorkshopNeedAutosaveCtx | null {
  return useContext(Ctx);
}
