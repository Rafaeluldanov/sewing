import { Global, type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AppRolesModule } from '../app-roles/app-roles.module.js';
import { AuthService } from './auth.service.js';
import { AuthController } from './auth.controller.js';
import { ActorContextMiddleware } from './actor-context.middleware.js';
import { AuthGuard } from './auth.guard.js';
import { FeatureModulesService } from './feature-modules.service.js';
import { ServiceTokenService } from './service-token.service.js';

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
  // Справочник ролей нужен `AuthService.resolvePrincipal` на КАЖДОМ
  // запросе (раскрытие наследования до проверки `@Roles(...)`).
  // Зависимость односторонняя: `AppRolesModule` про auth не знает.
  imports: [AppRolesModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    FeatureModulesService,
    // Машинный токен: резолвится в том же глобальном гварде, но своим путём —
    // мимо политики сессий сотрудника (см. service-token.service.ts).
    ServiceTokenService,
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
  ],
  exports: [AuthService, ServiceTokenService],
})
export class AuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Автор действия из ERP — в контекст запроса ДО гварда и хендлера (правило §0.1).
    // Middleware, а не гвард: только `als.run` вокруг `next()` доживает до аудита.
    consumer.apply(ActorContextMiddleware).forRoutes('*');
  }
}
