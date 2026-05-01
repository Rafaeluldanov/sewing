import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthService } from './auth.service.js';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';

/**
 * Auth-модуль (MVP 1.1, ADR-0014).
 *
 * Помечен `@Global`, чтобы `AuthService` был доступен в `AuthGuard`,
 * который зарегистрирован глобально через `APP_GUARD`. Контроллеры
 * других модулей сессию руками не обрабатывают — берут принципала
 * через `@CurrentUser()`.
 *
 * Контракты — `docs/api.md §1`. Бизнес-правила — `docs/flows.md §F0`.
 */
@Global()
@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
  ],
  exports: [AuthService],
})
export class AuthModule {}
