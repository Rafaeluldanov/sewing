import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import {
  CreateAppRoleSchema,
  UpdateAppRoleSchema,
  type CreateAppRoleDto,
  type UpdateAppRoleDto,
} from '@sewing/shared/app-roles';
import {
  BulkArchiveRequestSchema,
  type BulkArchiveRequestDto,
  type BulkArchiveResultDto,
} from '@sewing/shared/archive';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, MachineScopes, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { AppRolesService } from './app-roles.service.js';

/**
 * Контроллер справочника ролей (`/admin/roles`).
 *
 *   GET   /api/app-roles          — весь справочник (активные + архив)
 *   GET   /api/app-roles/:id      — одна роль
 *   POST  /api/app-roles          — завести кастомную роль
 *   PATCH /api/app-roles/:id      — правка (у системной — только название)
 *   POST  /api/app-roles/archive|restore|purge — массовые операции архива
 *
 * RBAC — только `ADMIN`, в отличие от остальных справочников админки
 * (там `SHOP_MANAGER` тоже пускают). Причина: правка `inherits` меняет
 * права СРАЗУ всем носителям роли, то есть это инструмент выдачи
 * доступа, а не производственный справочник. Начальник цеха продолжает
 * назначать сотрудникам уже заведённые роли через `/admin/employees`.
 *
 * Читать справочник должен и `SHOP_MANAGER` — иначе форма сотрудника у
 * него останется без списка ролей; поэтому `GET`-и открыты обоим.
 *
 * Контракт — `docs/api.md §3c`. UI — `apps/web/app/admin/roles`.
 */
@Roles('ADMIN')
@Controller('app-roles')
// Только чтение: правка ролей — ADMIN, а машине ADMIN не выдаётся (см. FORBIDDEN_ROLES).
@MachineScopes('roles:read')
export class AppRolesController {
  constructor(private readonly service: AppRolesService) {}

  /**
   * Метод-уровневый `@Roles(...)` расширяет класс-уровневый `ADMIN` на
   * начальника цеха: список ролей нужен ему для селектов в карточке
   * сотрудника (`/admin/employees/[id]`).
   */
  @Get()
  @Roles('SHOP_MANAGER', 'ADMIN')
  list() {
    return this.service.list();
  }

  @Get(':id')
  @Roles('SHOP_MANAGER', 'ADMIN')
  getById(@Param('id') id: string) {
    return this.service.getById(id);
  }

  @Post()
  create(
    @Body(new ZodValidationPipe(CreateAppRoleSchema)) body: CreateAppRoleDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.service.create(body, user.employeeId);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateAppRoleSchema)) body: UpdateAppRoleDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.service.update(id, body, user.employeeId);
  }

  /**
   * Массовые операции архива (контракт — `@sewing/shared/archive`):
   *   archive — `active = false`, роль пропадает из назначения, но у
   *             тех, кому уже выдана, продолжает работать;
   *   restore — обратно;
   *   purge   — снести навсегда; только из архива, только если роль
   *             никому не выдана и её никто не наследует.
   *
   * Системные роли не проходят ни один из гейтов — попадают в `skipped`
   * с причиной `FORBIDDEN`.
   */
  @Post('archive')
  archiveMany(
    @Body(new ZodValidationPipe(BulkArchiveRequestSchema))
    dto: BulkArchiveRequestDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<BulkArchiveResultDto> {
    return this.service.archiveMany(dto.ids, user.employeeId);
  }

  @Post('restore')
  restoreMany(
    @Body(new ZodValidationPipe(BulkArchiveRequestSchema))
    dto: BulkArchiveRequestDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<BulkArchiveResultDto> {
    return this.service.restoreMany(dto.ids, user.employeeId);
  }

  @Post('purge')
  purgeMany(
    @Body(new ZodValidationPipe(BulkArchiveRequestSchema))
    dto: BulkArchiveRequestDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<BulkArchiveResultDto> {
    return this.service.purgeMany(dto.ids, user.employeeId);
  }
}
