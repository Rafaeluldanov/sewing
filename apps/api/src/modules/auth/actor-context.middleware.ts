import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { parseActorHeaders, runWithActor } from './actor-context.js';
import { readServiceToken } from './service-token.js';

/**
 * Кладёт автора действия (заголовки `X-Sewing-Actor*`) в контекст запроса — только для запросов
 * с машинным токеном `sew_…`. Человеку с cookie заголовки не читаются вовсе: подделать автора,
 * дописав заголовок к обычному запросу, нельзя.
 *
 * Сам токен здесь НЕ проверяется — это работа `AuthGuard`. Невалидный токен упадёт там 401,
 * и автор из контекста никуда не запишется: до аудита такой запрос не доходит.
 */
@Injectable()
export class ActorContextMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    if (!readServiceToken(req.headers.authorization)) {
      next();
      return;
    }
    const actor = parseActorHeaders(req.headers);
    if (!actor) {
      next();
      return;
    }
    runWithActor(actor, () => next());
  }
}
