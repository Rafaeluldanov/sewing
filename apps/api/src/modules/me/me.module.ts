import { Module } from '@nestjs/common';
import { MeController } from './me.controller.js';
import { MeService } from './me.service.js';

/**
 * Модуль «Мой профиль» (`/api/me/*`, MVP).
 *
 * На MVP отсюда выставлен один маршрут — `GET /api/me/employee-qr`,
 * возвращающий подписанный QR-код текущего сотрудника для
 * показа мастеру / сканирования на рабочем терминале. Контракт и
 * payload токена — `packages/shared/src/employee-qr.ts`. Исходник
 * подписи — `apps/api/src/modules/auth/employee-qr-token.ts`.
 *
 * Зачем отдельный модуль (а не расширение `AuthController`):
 *   - `auth` исторически отвечает за login/logout/me — тонкая
 *     «кто я» карточка пользователя без бизнес-доменной логики;
 *   - `/me/*` — растущая зона «личный кабинет сотрудника», куда в
 *     будущем встанут /me/shifts, /me/earnings-summary и т.п.;
 *     держим её отдельно, чтобы auth не начал «знать всё».
 *   - `MeService` инъектит `AuthService` ради общего `JWT_SECRET`,
 *     без дубляжа env-чтения.
 */
@Module({
  controllers: [MeController],
  providers: [MeService],
})
export class MeModule {}
