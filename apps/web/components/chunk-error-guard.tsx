'use client';

import { useEffect, useState } from 'react';

/**
 * Клиентский guard от `ChunkLoadError`.
 *
 * Корневая причина — nginx не отдаёт `/_next/static/...` напрямую с
 * диска (см. `docs/deploy-stage.md §2a`). В таком окружении любая
 * lazy-загрузка чанка падает, и страница перестаёт реагировать на
 * взаимодействие. Это конфигурационная проблема инфраструктуры,
 * исправляется только корректным `location /_next/static/` в nginx.
 *
 * Компонент НЕ маскирует баг: он лишь страхует пользователя в двух
 * сценариях, в которых ошибка реально может случиться даже на
 * корректно настроенном сервере:
 *
 *   1. Деплой во время открытой вкладки. Между `npm run build` и
 *      рестартом Next-процесса hash в имени чанка меняется, старые
 *      файлы из памяти браузера ссылаются на уже не существующие
 *      имена. Один тихий `location.reload()` решает проблему — после
 *      него браузер забирает свежий набор чанков.
 *   2. Краткий обрыв сети у мобильного клиента (швея в цеху). Тут
 *      тоже помогает один reload.
 *
 * Чтобы не уйти в reload-loop, перед перезагрузкой ставим маркер в
 * `sessionStorage`. Если после reload снова прилетел `ChunkLoadError`
 * — это уже не «гонка деплоя», а реально сломанный nginx, и мы
 * показываем человекопонятную плашку без попыток ещё раз перезагружать
 * страницу.
 *
 * Покрываем оба канала ошибок:
 *   - `window.onerror` / `'error'` — для классических `<script>`-fail-ов;
 *   - `'unhandledrejection'` — для `import()` / dynamic imports (Next
 *     именно так грузит app-router-овские чанки).
 */
const RELOAD_FLAG = 'sewing.chunkErrorReloaded';

function isChunkLoadError(err: unknown): boolean {
  if (!err) return false;
  // Стандартная форма: `Error { name: 'ChunkLoadError', message: '...' }`.
  if (typeof err === 'object') {
    const e = err as { name?: unknown; message?: unknown };
    if (e.name === 'ChunkLoadError') return true;
    if (typeof e.message === 'string') {
      const m = e.message;
      if (
        m.includes('ChunkLoadError') ||
        m.includes('Loading chunk') ||
        m.includes('Loading CSS chunk') ||
        m.includes('Failed to fetch dynamically imported module')
      ) {
        return true;
      }
    }
  }
  if (typeof err === 'string') {
    return (
      err.includes('ChunkLoadError') ||
      err.includes('Loading chunk') ||
      err.includes('Loading CSS chunk')
    );
  }
  return false;
}

export function ChunkErrorGuard() {
  const [showBanner, setShowBanner] = useState(false);

  useEffect(() => {
    function handle(err: unknown) {
      if (!isChunkLoadError(err)) return;
      let alreadyReloaded = false;
      try {
        alreadyReloaded =
          window.sessionStorage.getItem(RELOAD_FLAG) === '1';
      } catch {
        // sessionStorage может быть недоступен (приватный режим
        // Safari, политика cookies). Fallback — сразу плашка.
        alreadyReloaded = true;
      }
      if (alreadyReloaded) {
        setShowBanner(true);
        return;
      }
      try {
        window.sessionStorage.setItem(RELOAD_FLAG, '1');
      } catch {
        /* ignore */
      }
      window.location.reload();
    }

    function onError(event: ErrorEvent) {
      handle(event.error ?? event.message);
    }
    function onRejection(event: PromiseRejectionEvent) {
      handle(event.reason);
    }

    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);

    // Если страница ожила без ошибок — снимаем флаг, чтобы следующий
    // настоящий ChunkLoadError снова получил один шанс на reload.
    const clearTimer = window.setTimeout(() => {
      try {
        window.sessionStorage.removeItem(RELOAD_FLAG);
      } catch {
        /* ignore */
      }
    }, 5000);

    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
      window.clearTimeout(clearTimer);
    };
  }, []);

  if (!showBanner) return null;

  return (
    <div
      role="alert"
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 9999,
        padding: '12px 16px',
        background: '#b91c1c',
        color: '#fff',
        fontSize: 14,
        lineHeight: 1.4,
        textAlign: 'center',
        boxShadow: '0 -4px 12px rgba(0,0,0,0.2)',
      }}
    >
      Не удалось загрузить часть приложения. Обновите страницу
      (Ctrl+Shift+R / Cmd+Shift+R). Если ошибка повторяется — сообщите
      администратору, проблема на сервере (nginx /_next/static).
    </div>
  );
}
