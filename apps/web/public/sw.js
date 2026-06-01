/* Service worker для Web Push «пришёл брак от ОТК».
 *
 * Намеренно минимальный: НИКАКОГО кэширования/offline — приложение
 * остаётся обычным online-SPA, SW нужен исключительно как приёмник
 * push-событий (без него Web Push в браузере невозможен).
 *
 * Жизненный цикл: активируемся сразу (skipWaiting + clients.claim),
 * чтобы первая же подписка получала пуши без перезагрузки вкладки.
 *
 * Контракт payload задаёт бэкенд (apps/api/.../push.service.ts →
 * PushNotificationPayload): { tag, title, body, url }.
 */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = data.title || 'Sewing';
  const options = {
    body: data.body || '',
    tag: data.tag || 'sewing-notification',
    // renotify: даже если уведомление с тем же tag висит, повторно
    // звякнуть/вибрировать — брак важно не пропустить.
    renotify: true,
    // requireInteraction: уведомление не исчезает само, висит пока
    // швея не тапнет (где платформа это поддерживает — Android/desktop).
    requireInteraction: true,
    vibrate: [200, 100, 200, 100, 200],
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: data.url || '/work' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/work';
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        // Если вкладка приложения уже открыта — фокусируем её и ведём
        // на нужный путь, иначе открываем новую.
        for (const client of clientList) {
          if ('focus' in client) {
            client.navigate(url).catch(() => {});
            return client.focus();
          }
        }
        if (self.clients.openWindow) return self.clients.openWindow(url);
        return undefined;
      }),
  );
});
