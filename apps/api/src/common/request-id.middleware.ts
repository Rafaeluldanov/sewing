import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'crypto';

/**
 * Request-ID middleware (Шаг 12 / Pilot Rollout).
 *
 * Зачем:
 *   - на пилоте оператор называет поддержке короткий идентификатор
 *     запроса, а поддержка по нему мгновенно находит логи;
 *   - все ответы API получают `X-Request-Id`, а в теле ошибки
 *     `GlobalExceptionFilter` отдаёт то же значение в поле
 *     `requestId` (см. `docs/api.md §13`).
 *
 * Алгоритм:
 *   - если входящий запрос уже содержит `X-Request-Id` — берём его
 *     (полезно для прокси/балансировщика и сквозной корреляции);
 *   - иначе генерируем UUID v4 (`crypto.randomUUID`).
 *
 * Контракт:
 *   - значение прикрепляется к `req.requestId` — оттуда его читают
 *     `GlobalExceptionFilter`, контроллеры и сервисы (для логов).
 *   - заголовок `X-Request-Id` ставится в ответ сразу же, чтобы
 *     попасть в любой ответ, включая ранние ошибки.
 */
export function requestIdMiddleware(
  req: Request & { requestId?: string },
  res: Response,
  next: NextFunction,
): void {
  const incoming = req.headers['x-request-id'];
  const headerValue = Array.isArray(incoming) ? incoming[0] : incoming;
  const requestId =
    typeof headerValue === 'string' && headerValue.trim().length > 0
      ? headerValue.trim().slice(0, 64)
      : randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
}
