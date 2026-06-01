'use client';

/**
 * Подключение фоновых Web Push-уведомлений «пришёл брак от ОТК» в
 * кабинете швеи (/work).
 *
 * Зачем отдельно от звукового модала (`seamstress-active-panel.tsx`):
 * звук + поллинг работают только пока вкладка открыта и активна.
 * Web Push добивает кейс «приложение свёрнуто / экран потушен» —
 * служба доставки браузера будит service worker (`public/sw.js`) и
 * показывает системное уведомление.
 *
 * Платформенные оговорки, которые отражает UI:
 *   - Android Chrome — работает в браузере, установка не нужна.
 *   - iOS Safari — Web Push доступен ТОЛЬКО в установленной на «Домой»
 *     PWA (iOS 16.4+). В обычной вкладке `Notification`/`PushManager`
 *     недоступны → показываем подсказку «Поделиться → На экран Домой».
 *
 * Разрешение запрашиваем строго по нажатию кнопки (user gesture) —
 * этого требует и хороший UX, и сам iOS.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  getPushPublicKeyAction,
  removePushSubscriptionAction,
  savePushSubscriptionAction,
} from './push-actions';

type Status =
  | 'loading'
  | 'unsupported' // браузер не умеет Web Push вовсе
  | 'needs-install' // iOS Safari вне установленной PWA
  | 'prompt' // можно включить
  | 'working' // идёт подписка
  | 'enabled' // подписка активна
  | 'denied' // пользователь запретил уведомления
  | 'error';

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

function isIos(): boolean {
  return (
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    // iPadOS 13+ маскируется под Mac, но имеет тач
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

function isStandalone(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    // iOS-специфичный флаг
    (window.navigator as unknown as { standalone?: boolean }).standalone ===
      true
  );
}

function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export function ReworkPushSetup() {
  const [status, setStatus] = useState<Status>('loading');

  // Первичная диагностика среды + проверка уже существующей подписки.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!pushSupported()) {
        // На iOS без установки Notification/PushManager просто нет —
        // отличаем «надо установить» от «браузер не умеет вообще».
        if (isIos() && !isStandalone()) {
          if (!cancelled) setStatus('needs-install');
        } else if (!cancelled) {
          setStatus('unsupported');
        }
        return;
      }
      if (Notification.permission === 'denied') {
        if (!cancelled) setStatus('denied');
        return;
      }
      try {
        const reg = await navigator.serviceWorker.register('/sw.js');
        const existing = await reg.pushManager.getSubscription();
        if (existing && Notification.permission === 'granted') {
          // Повторно отдаём подписку на бэк — вдруг сервер потерял её
          // (новая БД, чистка) или сменился сотрудник на устройстве.
          await savePushSubscriptionAction(
            existing.toJSON() as never,
          ).catch(() => {});
          if (!cancelled) setStatus('enabled');
        } else if (!cancelled) {
          setStatus('prompt');
        }
      } catch {
        if (!cancelled) setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const enable = useCallback(async () => {
    setStatus('working');
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setStatus(permission === 'denied' ? 'denied' : 'prompt');
        return;
      }
      const cfg = await getPushPublicKeyAction();
      if (!cfg || !cfg.enabled || !cfg.key) {
        // Сервер без VAPID-ключей — уведомления физически не уйдут.
        setStatus('error');
        return;
      }
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        // cast: lib.dom типизирует applicationServerKey как
        // BufferSource поверх ArrayBuffer, наш Uint8Array<ArrayBufferLike>
        // эквивалентен в рантайме.
        applicationServerKey: urlBase64ToUint8Array(cfg.key) as unknown as BufferSource,
      });
      const res = await savePushSubscriptionAction(sub.toJSON() as never);
      setStatus(res.ok ? 'enabled' : 'error');
    } catch {
      setStatus('error');
    }
  }, []);

  const disable = useCallback(async () => {
    setStatus('working');
    try {
      const reg = await navigator.serviceWorker.getRegistration('/sw.js');
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await removePushSubscriptionAction(sub.endpoint).catch(() => {});
        await sub.unsubscribe().catch(() => {});
      }
      setStatus('prompt');
    } catch {
      setStatus('error');
    }
  }, []);

  // Пока грузимся / браузер не умеет — ничего не показываем, чтобы не
  // мусорить интерфейс швеи на десктопе-без-пуша.
  if (status === 'loading' || status === 'unsupported') return null;

  if (status === 'needs-install') {
    return (
      <section
        className="card push-setup push-setup--hint"
        aria-label="Уведомления о браке"
      >
        <h2 className="card__title">🔔 Уведомления о браке</h2>
        <p className="card__hint">
          Чтобы получать сигнал о браке, даже когда приложение свёрнуто:
          нажмите «Поделиться» → «На экран „Домой“», откройте приложение с
          домашнего экрана и включите уведомления здесь.
        </p>
      </section>
    );
  }

  if (status === 'denied') {
    return (
      <section
        className="card push-setup push-setup--hint"
        aria-label="Уведомления о браке"
      >
        <h2 className="card__title">🔕 Уведомления выключены</h2>
        <p className="card__hint">
          Вы запретили уведомления для этого сайта. Чтобы получать сигнал о
          браке при свёрнутом приложении, включите уведомления в настройках
          браузера для этого сайта.
        </p>
      </section>
    );
  }

  if (status === 'enabled') {
    return (
      <section
        className="card push-setup push-setup--on"
        aria-label="Уведомления о браке"
      >
        <h2 className="card__title">🔔 Уведомления о браке включены</h2>
        <p className="card__hint">
          Сигнал придёт, даже если приложение свёрнуто или экран погашен.
        </p>
        <button
          type="button"
          className="scan-card__manual-toggle"
          onClick={disable}
        >
          Выключить уведомления
        </button>
      </section>
    );
  }

  // 'prompt' | 'working' | 'error'
  return (
    <section className="card push-setup" aria-label="Уведомления о браке">
      <h2 className="card__title">🔔 Уведомления о браке</h2>
      <p className="card__hint">
        Включите, чтобы получать сигнал о возврате на переделку, даже когда
        приложение свёрнуто или экран погашен.
      </p>
      {status === 'error' && (
        <div className="error-box" role="alert">
          <div className="error-box__msg">
            Не удалось включить уведомления. Попробуйте ещё раз.
          </div>
        </div>
      )}
      <button
        type="button"
        className="btn btn-primary btn-block"
        onClick={enable}
        disabled={status === 'working'}
      >
        {status === 'working' ? 'Включаем…' : 'Включить уведомления'}
      </button>
    </section>
  );
}
