import { z } from 'zod';

/**
 * Тело `POST /push/subscribe` — сериализованный браузерный
 * `PushSubscription` (W3C Push API). `endpoint` — адрес доставки в
 * службе пуша (FCM/Mozilla/Apple), `keys.p256dh`/`keys.auth` — ключи
 * для ECDH-шифрования payload библиотекой `web-push`.
 *
 * Схему держим локально в модуле (а не в `@sewing/shared`): формат
 * задан стандартом браузера, в UI-формах не переиспользуется.
 */
export const PushSubscribeSchema = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({
    p256dh: z.string().min(1).max(255),
    auth: z.string().min(1).max(255),
  }),
});

export type PushSubscribeDto = z.infer<typeof PushSubscribeSchema>;

/** Тело `POST /push/unsubscribe`. */
export const PushUnsubscribeSchema = z.object({
  endpoint: z.string().url().max(2000),
});

export type PushUnsubscribeDto = z.infer<typeof PushUnsubscribeSchema>;
