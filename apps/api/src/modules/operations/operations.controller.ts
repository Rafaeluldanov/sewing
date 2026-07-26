import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  CreateOperationSchema,
  UpdateOperationEquipmentSchema,
  UpdateOperationSchema,
  type CreateOperationDto,
  type OperationBlockersResponse,
  type OperationDetailDto,
  type OperationSummaryDto,
  type UpdateOperationDto,
  type UpdateOperationEquipmentDto,
} from '@sewing/shared/operations';
import {
  BulkArchiveRequestSchema,
  type BulkArchiveRequestDto,
  type BulkArchiveResultDto,
} from '@sewing/shared/archive';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { OperationsService } from './operations.service.js';

/**
 * Управление операциями (см. `docs/api.md §15a`, `docs/screens.md §10c`).
 *
 * Доступ — только `ADMIN` и `SHOP_MANAGER`. Это управленческий
 * раздел: сдельные ставки задаются здесь, и рабочие роли сюда не
 * ходят. Backend режет любые рабочие роли через `@Roles(...)`,
 * фронт дополнительно скрывает пункт меню (`canSeeAdmin` в
 * `apps/web/lib/rbac.ts`).
 *
 * Перечень операций для сменного flow (`/work`, `EquipmentService`)
 * остаётся прежним — он читает `Operation.active = true` через
 * собственные сервисы и не зависит от этого контроллера.
 */
@Controller('operations')
@Roles('SHOP_MANAGER', 'ADMIN')
export class OperationsController {
  constructor(private readonly operations: OperationsService) {}

  @Get()
  list(): Promise<OperationSummaryDto[]> {
    return this.operations.list();
  }

  @Post()
  create(
    @Body(new ZodValidationPipe(CreateOperationSchema))
    dto: CreateOperationDto,
  ): Promise<OperationDetailDto> {
    return this.operations.create(dto);
  }

  @Get(':id')
  getOne(@Param('id') id: string): Promise<OperationDetailDto> {
    return this.operations.getOne(id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateOperationSchema))
    dto: UpdateOperationDto,
  ): Promise<OperationDetailDto> {
    return this.operations.update(id, dto);
  }

  /**
   * Привязка операции к набору оборудования со стороны операции
   * (`PATCH /api/operations/:id/equipment`). Зеркало
   * `PATCH /api/equipment/:id/operations`: те же роли, та же таблица
   * `EquipmentOperation`, но pivot — по операции. Удобно при заведении
   * нового станка: открыл операцию → отметил станки → сохранил, и
   * операция сразу доступна на них в `/work`.
   */
  @Patch(':id/equipment')
  updateEquipment(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateOperationEquipmentSchema))
    dto: UpdateOperationEquipmentDto,
  ): Promise<OperationDetailDto> {
    return this.operations.updateEquipment(id, dto.equipmentIds);
  }

  /**
   * Превью «можно ли физически удалить операцию» (см.
   * `OperationsService.getBlockers`). UI по этому ответу решает,
   * показывать ли кнопку «Удалить» (hard) или только
   * «Деактивировать» (soft = `PATCH { isActive: false }`).
   */
  @Get(':id/blockers')
  getBlockers(@Param('id') id: string): Promise<OperationBlockersResponse> {
    return this.operations.getBlockers(id);
  }

  /**
   * Физическое удаление операции (`DELETE /api/operations/:id`).
   *
   * Метод-уровневый `@Roles('ADMIN')` переопределяет класс-уровневый
   * `@Roles('SHOP_MANAGER', 'ADMIN')` — hard-delete сознательно
   * доступен только администраторам, потому что операция необратима.
   *
   * 409 (`OPERATION_IN_USE`), если на операцию есть любые ссылки
   * (история / маршруты / substitute-правила); детали — через
   * `GET :id/blockers`. Менеджеру остаётся мягкое удаление —
   * `PATCH { isActive: false }`.
   *
   * Возвращает `204 No Content` при успехе; снимок удалённой операции
   * остаётся в `AuditLog` (`OPERATION_DELETED`).
   */
  @Roles('ADMIN')
  @Delete(':id')
  @HttpCode(204)
  async delete(
    @Param('id') id: string,
    @CurrentUser() viewer: AuthPrincipal,
  ): Promise<void> {
    await this.operations.remove(id, viewer);
  }

  /**
   * Массовые операции архива со списка `/admin/operations` (контракт —
   * `@sewing/shared/archive`): `active = false` → обратно → удалить
   * навсегда (только из архива и только если нет истории/маршрутов).
   *
   * `purge` оставлен `ADMIN`-only, как и одиночный `DELETE :id`:
   * необратимая операция. `archive`/`restore` — обратимы, доступны и
   * `SHOP_MANAGER` (класс-уровневый `@Roles`).
   */
  @Post('archive')
  archiveMany(
    @Body(new ZodValidationPipe(BulkArchiveRequestSchema))
    dto: BulkArchiveRequestDto,
    @CurrentUser() viewer: AuthPrincipal,
  ): Promise<BulkArchiveResultDto> {
    return this.operations.archiveMany(dto.ids, viewer);
  }

  @Post('restore')
  restoreMany(
    @Body(new ZodValidationPipe(BulkArchiveRequestSchema))
    dto: BulkArchiveRequestDto,
    @CurrentUser() viewer: AuthPrincipal,
  ): Promise<BulkArchiveResultDto> {
    return this.operations.restoreMany(dto.ids, viewer);
  }

  @Roles('ADMIN')
  @Post('purge')
  purgeMany(
    @Body(new ZodValidationPipe(BulkArchiveRequestSchema))
    dto: BulkArchiveRequestDto,
    @CurrentUser() viewer: AuthPrincipal,
  ): Promise<BulkArchiveResultDto> {
    return this.operations.purgeMany(dto.ids, viewer);
  }
}
