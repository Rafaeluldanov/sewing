import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  CreateEmployeeSchema,
  ListEmployeesQuerySchema,
  UpdateEmployeeSchema,
  type CreateEmployeeDto,
  type ListEmployeesQuery,
  type UpdateEmployeeDto,
} from '@sewing/shared/employees';
import { EMPLOYEE_QR_PREFIX } from '@sewing/shared/master-calls';
import {
  BulkArchiveRequestSchema,
  type BulkArchiveRequestDto,
  type BulkArchiveResultDto,
} from '@sewing/shared/archive';
import * as QRCode from 'qrcode';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, Public, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { EmployeesService } from './employees.service.js';
import { renderEmployeePrintHtml } from './employee-print.js';

/**
 * Контроллер блока «Сотрудники» (post-Шаг 18 / Шаг 19, ADR-0021,
 * + post-задача «Добавить сотрудника» с UI на `/admin/employees/new`).
 *
 *   GET   /api/employees          — список (фильтры active/role/comp/search)
 *   POST  /api/employees          — создание новой карточки
 *   GET   /api/employees/:id      — карточка
 *   PATCH /api/employees/:id      — правка management-полей
 *
 * Доступ — только `SHOP_MANAGER` и `ADMIN`. Информация о сотрудниках
 * (логин, ставка, тип оплаты) чувствительна — обычный сотрудник видит
 * только себя через `/api/auth/me`. Никакого «view другого сотрудника»
 * для рабочих ролей не предусмотрено. POST наследует тот же RBAC от
 * декоратора уровня класса (`@Roles('SHOP_MANAGER', 'ADMIN')`).
 */
@Roles('SHOP_MANAGER', 'ADMIN')
@Controller('employees')
export class EmployeesController {
  constructor(private readonly employees: EmployeesService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(ListEmployeesQuerySchema))
    query: ListEmployeesQuery,
  ) {
    return this.employees.list(query);
  }

  @Post()
  create(
    @Body(new ZodValidationPipe(CreateEmployeeSchema))
    body: CreateEmployeeDto,
  ) {
    return this.employees.create(body);
  }

  /**
   * Узкий справочник активных раскройщиков для select-а на форме
   * выпуска паспорта (`apps/web/app/orders/[id]/passports/new`).
   *
   * Метод-уровневый `@Roles(...)` переопределяет класс-уровневый
   * `@Roles('SHOP_MANAGER', 'ADMIN')` и расширяет доступ на
   * `CUTTER_ASSISTANT` — единственная роль, которой эта форма нужна
   * по UX (см. `docs/cutter-assistant-passport-release-recon.md §5`).
   *
   * Маршрут объявлен **до** `@Get(':id')` намеренно: иначе Nest
   * парсит литерал `cutters` как `id` и улетает в `get(id='cutters')`
   * → 404 `EMPLOYEE_NOT_FOUND` вместо успеха.
   *
   * Никаких payroll-полей не отдаём — проекция фиксируется в
   * `EmployeesService.listActiveCutters()` через Prisma `select`.
   */
  @Roles('CUTTER_ASSISTANT', 'SHOP_MANAGER', 'ADMIN')
  @Get('cutters')
  listActiveCutters() {
    return this.employees.listActiveCutters();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.employees.get(id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateEmployeeSchema))
    body: UpdateEmployeeDto,
    @CurrentUser() viewer: AuthPrincipal,
  ) {
    return this.employees.update(id, body, viewer);
  }

  /**
   * Preflight для блока archive / hard-delete (см.
   * `docs/employee-deletion-recon.md §3-§4`). UI на основе ответа решает,
   * какие кнопки доступны в строке таблицы и блоке «Опасная зона» на
   * странице карточки. Сам по себе вызов идемпотентен и не меняет
   * данные.
   */
  @Get(':id/blockers')
  getBlockers(@Param('id') id: string) {
    return this.employees.getBlockers(id);
  }

  /**
   * Мягкое архивирование (`active = true → false`). Идемпотентно для
   * уже архивных карточек. Falls back to `EMPLOYEE_ARCHIVE_BLOCKED`
   * при наличии открытой смены / висящих паспортов / открытых
   * `MasterCall` / `REQUESTED`-заявок на закрытие раскроя.
   *
   * RBAC — `SHOP_MANAGER`/`ADMIN` (от класс-уровневого `@Roles(...)`).
   * SHOP_MANAGER не может архивировать ADMIN — guard в сервисе.
   */
  @Post(':id/archive')
  archive(@Param('id') id: string, @CurrentUser() viewer: AuthPrincipal) {
    return this.employees.archive(id, viewer);
  }

  /**
   * Массовые операции архива со списка `/admin/employees` (контракт —
   * `@sewing/shared/archive`). Оборачивают одиночные `archive` /
   * `restore` / `hardDelete` со всеми их гейтами; не прошедшие
   * возвращаются в `skipped` с человекочитаемой причиной раздела
   * («нельзя на себе», «последний администратор», «есть история»).
   *
   * `purge` — `ADMIN`-only, как и одиночный `DELETE :id`, и требует,
   * чтобы карточка была в архиве.
   */
  @Post('archive')
  archiveMany(
    @Body(new ZodValidationPipe(BulkArchiveRequestSchema))
    dto: BulkArchiveRequestDto,
    @CurrentUser() viewer: AuthPrincipal,
  ): Promise<BulkArchiveResultDto> {
    return this.employees.archiveMany(dto.ids, viewer);
  }

  @Post('restore')
  restoreMany(
    @Body(new ZodValidationPipe(BulkArchiveRequestSchema))
    dto: BulkArchiveRequestDto,
    @CurrentUser() viewer: AuthPrincipal,
  ): Promise<BulkArchiveResultDto> {
    return this.employees.restoreMany(dto.ids, viewer);
  }

  @Roles('ADMIN')
  @Post('purge')
  purgeMany(
    @Body(new ZodValidationPipe(BulkArchiveRequestSchema))
    dto: BulkArchiveRequestDto,
    @CurrentUser() viewer: AuthPrincipal,
  ): Promise<BulkArchiveResultDto> {
    return this.employees.purgeMany(dto.ids, viewer);
  }

  /**
   * Снять архив (`active = false → true`). Идемпотентно для уже
   * активных карточек. RBAC — `SHOP_MANAGER`/`ADMIN` (от класс-уровневого
   * декоратора).
   */
  @Post(':id/restore')
  restore(@Param('id') id: string, @CurrentUser() viewer: AuthPrincipal) {
    return this.employees.restore(id, viewer);
  }

  /**
   * Физическое удаление карточки (`DELETE /api/employees/:id`).
   *
   * Метод-уровневый `@Roles('ADMIN')` переопределяет класс-уровневый
   * `@Roles('SHOP_MANAGER', 'ADMIN')` — hard-delete сознательно
   * доступен только администраторам, потому что операция необратима.
   *
   * 409 если есть финансовая/производственная история
   * (`EMPLOYEE_HAS_HISTORY` — детали через `GET :id/blockers`).
   * 409 если это DISPLAY-учётка с `DisplayScreenConfig` и нет
   * `ackDisplayCascade=true` — менеджер должен явно подтвердить
   * каскадный снос экрана (FK `onDelete: Cascade`).
   *
   * Возвращает `204 No Content` при успехе; снимок удалённой карточки
   * остаётся в `AuditLog` (`EMPLOYEE_DELETED`).
   */
  @Roles('ADMIN')
  @Delete(':id')
  @HttpCode(204)
  async delete(
    @Param('id') id: string,
    @CurrentUser() viewer: AuthPrincipal,
    @Query('ackDisplayCascade') ackDisplayCascade?: string,
  ): Promise<void> {
    await this.employees.hardDelete(id, viewer, {
      ackDisplayCascade: ackDisplayCascade === 'true',
    });
  }

  /**
   * HTML-этикетка с QR-кодом сотрудника. Используется на `/master`
   * (мастер цеха сканирует QR, чтобы закрыть открытый вызов
   * рабочего — см. `apps/api/src/modules/master-calls/*`).
   *
   * `@Public()` — этикетку печатают со станции без сессии (та же
   * модель, что у `/api/equipment/:id/print`,
   * `/api/passports/:id/print` и `/api/packing/boxes/:id/label`).
   * Никаких чувствительных полей сотрудника на печатной форме нет
   * (только ФИО, роль, login и сам QR), поэтому публичность здесь
   * безопасна.
   */
  @Public()
  @Get(':id/print')
  @Header('content-type', 'text/html; charset=utf-8')
  async print(@Param('id') id: string): Promise<string> {
    const employee = await this.employees.get(id);
    const qrDataUrl = await QRCode.toDataURL(
      `${EMPLOYEE_QR_PREFIX}${id}`,
      { errorCorrectionLevel: 'M', margin: 1, width: 360 },
    );
    return renderEmployeePrintHtml({ employee, qrDataUrl });
  }

  /**
   * PNG QR-кода сотрудника (`EMPLOYEE:<id>` по `EMPLOYEE_QR_PREFIX`).
   * Полезно для интеграций (отрисовка QR в произвольных формах) и
   * для предпросмотра в админке `/admin/employees/:id`.
   */
  @Public()
  @Get(':id/qr')
  async qr(@Param('id') id: string, @Res() res: Response): Promise<void> {
    await this.employees.get(id);
    const buf = await QRCode.toBuffer(`${EMPLOYEE_QR_PREFIX}${id}`, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 360,
      type: 'png',
    });
    res
      .status(200)
      .setHeader('content-type', 'image/png')
      .setHeader('cache-control', 'public, max-age=300')
      .send(buf);
  }
}
