'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ModalPortal } from '@/components/modal-portal';
import { idleLogoutAction, touchSessionAction } from '@/app/(auth)/session-actions';

/**
 * Сторож бездействия: выводит из системы того, кто ушёл и не нажал
 * «Выйти».
 *
 * Зачем. Терминал в цехе один на несколько человек, кнопку выхода
 * после смены почти никто не жмёт — следующий садится под чужой
 * учёткой, и работа уходит не тому сотруднику. Серверная часть
 * (`apps/api/src/modules/auth/session-policy.ts`) выпускает cookie ровно
 * на окно бездействия, но сама по себе она молчалива: открытая
 * вкладка узнала бы о протухшей сессии только при следующем переходе.
 * Этот компонент закрывает разрыв — считает то же окно на клиенте,
 * предупреждает и уводит на форму входа.
 *
 * Что считается активностью: клик/тап, нажатие клавиши (сюда же
 * попадает сканер штрихкода — он эмулирует клавиатуру), прокрутка
 * колесом, возврат на вкладку. Фоновые опросы страниц активностью НЕ
 * считаются сознательно — иначе забытая на столе вкладка держала бы
 * сессию вечно и вся настройка потеряла бы смысл.
 *
 * Продление сессии на сервере (`touchSessionAction`) идёт не на каждое
 * движение, а не чаще `REFRESH_MIN_INTERVAL_MS` — иначе один рабочий
 * день швеи превратился бы в тысячи запросов.
 *
 * Несколько вкладок синхронизируются через `localStorage`: активность
 * в одной сдвигает дедлайн во всех, иначе фоновая вкладка выкинула бы
 * человека, работающего в соседней.
 *
 * Компонент рендерится только для авторизованных и только когда
 * настройка включена (см. `app/layout.tsx` и
 * `MeResponseDto.sessionIdleTimeoutMinutes`).
 */

/** За сколько секунд до выхода показываем предупреждение. */
const WARN_SECONDS = 60;
/** Реже этого интервала сессию на сервере не продлеваем. */
const REFRESH_MIN_INTERVAL_MS = 60_000;
/** Ключ, через который вкладки сообщают друг другу о действиях человека. */
const ACTIVITY_STORAGE_KEY = 'sewing:last-activity';

const ACTIVITY_EVENTS = [
  'pointerdown',
  'keydown',
  'wheel',
  'touchstart',
] as const;

export function IdleLogoutWatcher({
  timeoutMinutes,
}: {
  timeoutMinutes: number;
}) {
  const timeoutMs = Math.max(1, timeoutMinutes) * 60_000;
  // Предупреждение не должно съедать всё окно: при коротком таймауте
  // (5 минут) минута предупреждения — это уже пятая часть, при совсем
  // экзотическом — не больше половины.
  const warnMs = Math.min(WARN_SECONDS * 1000, Math.floor(timeoutMs / 2));

  const deadlineRef = useRef(Date.now() + timeoutMs);
  const lastRefreshRef = useRef(Date.now());
  const loggingOutRef = useRef(false);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  /** Единственная точка выхода — чтобы не выстрелить дважды. */
  const logout = useCallback(() => {
    if (loggingOutRef.current) return;
    loggingOutRef.current = true;
    void idleLogoutAction();
  }, []);

  /**
   * Отметить действие человека: сдвинуть дедлайн, разбудить соседние
   * вкладки и — не чаще раза в минуту — продлить сессию на сервере.
   *
   * `broadcast = false` для события из другой вкладки: она уже
   * записала отметку, и повторная запись гоняла бы вкладки по кругу.
   */
  const markActive = useCallback(
    (broadcast = true) => {
      if (loggingOutRef.current) return;
      const now = Date.now();
      deadlineRef.current = now + timeoutMs;
      setSecondsLeft(null);

      if (broadcast) {
        try {
          window.localStorage.setItem(ACTIVITY_STORAGE_KEY, String(now));
        } catch {
          // Приватный режим/переполнение — синхронизация вкладок не
          // критична, свой отсчёт мы уже сдвинули.
        }
      }

      if (now - lastRefreshRef.current < REFRESH_MIN_INTERVAL_MS) return;
      lastRefreshRef.current = now;
      void touchSessionAction().then((alive) => {
        // Сессия умерла раньше нашего таймера (её отозвали или
        // сотрудника деактивировали) — уводим сразу, а не через окно.
        if (!alive) logout();
      });
    },
    [logout, timeoutMs],
  );

  useEffect(() => {
    const onActivity = () => markActive();
    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, onActivity, { passive: true });
    }

    // Возврат на вкладку — тоже действие человека, НО сначала надо
    // проверить, не истекло ли окно, пока вкладка была скрыта: иначе
    // отошедший на час сотрудник вернулся бы к живой сессии.
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() >= deadlineRef.current) {
        logout();
        return;
      }
      markActive();
    };
    document.addEventListener('visibilitychange', onVisibility);

    // Действие в соседней вкладке.
    const onStorage = (e: StorageEvent) => {
      if (e.key !== ACTIVITY_STORAGE_KEY) return;
      markActive(false);
    };
    window.addEventListener('storage', onStorage);

    const tick = window.setInterval(() => {
      const remaining = deadlineRef.current - Date.now();
      if (remaining <= 0) {
        logout();
        return;
      }
      setSecondsLeft(
        remaining <= warnMs ? Math.ceil(remaining / 1000) : null,
      );
    }, 1000);

    return () => {
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, onActivity);
      }
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('storage', onStorage);
      window.clearInterval(tick);
    };
  }, [logout, markActive, warnMs]);

  if (secondsLeft === null) return null;

  return (
    <ModalPortal>
      <div className="modal-backdrop" role="presentation">
        <div
          className="modal modal--idle-logout"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="idle-logout-title"
        >
          <h2 id="idle-logout-title" className="modal__title">
            Вы ещё работаете?
          </h2>
          <p className="modal__text">
            Из-за бездействия выход из системы через <b>{secondsLeft}</b> с.
            Незавершённая смена при этом не закрывается — после входа вы
            продолжите с того же места.
          </p>
          <div className="modal__actions">
            <button type="button" className="btn" onClick={logout}>
              Выйти сейчас
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => markActive()}
              autoFocus
            >
              Я здесь
            </button>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}
