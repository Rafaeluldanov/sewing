import { Module } from '@nestjs/common';
import { AppRolesController } from './app-roles.controller.js';
import { AppRolesService } from './app-roles.service.js';

/**
 * Модуль справочника ролей (`AppRole`, `/admin/roles`).
 *
 * Сервис экспортируется, потому что `AuthModule` вызывает его
 * `expand()` на каждом запросе — раскрытие наследования ролей идёт до
 * проверки `@Roles(...)` в `AuthGuard`.
 *
 * ВНИМАНИЕ на порядок импортов: `AuthModule` зависит от этого модуля,
 * поэтому обратной зависимости здесь быть не должно (иначе получим
 * circular dependency, которую Nest разруливает только через
 * `forwardRef`).
 *
 * Контракт — `docs/api.md §3c`. UI — `apps/web/app/admin/roles`.
 */
@Module({
  controllers: [AppRolesController],
  providers: [AppRolesService],
  exports: [AppRolesService],
})
export class AppRolesModule {}
