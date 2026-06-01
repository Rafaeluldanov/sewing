import {
  Body,
  Controller,
  Get,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { PushService } from './push.service.js';
import {
  PushSubscribeSchema,
  PushUnsubscribeSchema,
  type PushSubscribeDto,
  type PushUnsubscribeDto,
} from './push.dto.js';

/**
 * Web Push API для клиента. Все маршруты под глобальным `AuthGuard`
 * (без `@Public`) — подписку может оформить любой авторизованный
 * сотрудник. Никаких `@Roles`: фактически пуши о браке шлются только
 * швеям, но подписка безвредна для остальных.
 *
 * Браузер ходит сюда НЕ напрямую, а через server actions Next.js
 * (`apps/web/app/work/push-actions.ts`) — как и весь остальной трафик
 * web→API (cookie форвардится на стороне Next).
 */
@Controller('push')
export class PushController {
  constructor(private readonly push: PushService) {}

  /** Публичный VAPID-ключ для `pushManager.subscribe`. */
  @Get('public-key')
  publicKey(): { key: string; enabled: boolean } {
    return { key: this.push.getPublicKey(), enabled: this.push.isEnabled() };
  }

  @Post('subscribe')
  async subscribe(
    @Body(new ZodValidationPipe(PushSubscribeSchema)) dto: PushSubscribeDto,
    @CurrentUser() user: AuthPrincipal,
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    const ua = req.headers['user-agent'] ?? null;
    await this.push.saveSubscription(
      user.employeeId,
      dto,
      typeof ua === 'string' ? ua : null,
    );
    return { ok: true };
  }

  @Post('unsubscribe')
  async unsubscribe(
    @Body(new ZodValidationPipe(PushUnsubscribeSchema)) dto: PushUnsubscribeDto,
  ): Promise<{ ok: true }> {
    await this.push.deleteSubscription(dto.endpoint);
    return { ok: true };
  }
}
