import { Module } from '@nestjs/common';
import { PushService } from './push.service.js';
import { PushController } from './push.controller.js';

/**
 * Web Push (VAPID) — фоновые уведомления сотрудникам.
 * Контракт клиента: `apps/web/public/sw.js` + `app/work/push-actions.ts`.
 *
 * Экспортирует `PushService`, чтобы другие модули (например `QcModule`)
 * могли слать уведомления по бизнес-событиям — сейчас это «пришёл брак
 * от ОТК» в `QcService.returnToRework`.
 */
@Module({
  controllers: [PushController],
  providers: [PushService],
  exports: [PushService],
})
export class PushModule {}
