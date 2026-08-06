import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import {
  CreateDisplayScreenSchema,
  UpdateDisplayScreenSchema,
  type CreateDisplayScreenDto,
  type UpdateDisplayScreenDto,
} from '@sewing/shared/display-screens';
import {
  BulkArchiveRequestSchema,
  type BulkArchiveRequestDto,
  type BulkArchiveResultDto,
} from '@sewing/shared/archive';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { DisplayScreensService } from './display-screens.service.js';

/**
 * Контроллер «Display screens» (большие мониторы цеха).
 *
 *   GET   /api/display-screens       — список конфигов экранов
 *   POST  /api/display-screens       — создать экран + DISPLAY-учётку
 *   GET   /api/display-screens/:id   — один экран (карточка админки)
 *   PATCH /api/display-screens/:id   — правка экрана и его учётки
 *
 * Доступ — только `SHOP_MANAGER` и `ADMIN`. DISPLAY сюда не пускаем
 * принципиально: смысл этой ручки — управлять самими DISPLAY-учётками
 * и распределением подразделений между мониторами, а не работать
 * «изнутри» одного из них (см. `apps/web/middleware.ts`,
 * `apps/web/lib/rbac.ts`).
 *
 * Контракт — `docs/api.md §11`. UI — `apps/web/app/admin/display-screens`.
 */
@Roles('SHOP_MANAGER', 'ADMIN')
@Controller('display-screens')
export class DisplayScreensController {
  constructor(private readonly service: DisplayScreensService) {}

  @Get()
  list() {
    return this.service.list();
  }

  @Post()
  create(
    @Body(new ZodValidationPipe(CreateDisplayScreenSchema))
    body: CreateDisplayScreenDto,
  ) {
    return this.service.create(body);
  }

  /**
   * Карточка экрана `/admin/display-screens/[id]`. 404 приходит
   * стабильным кодом `DISPLAY_SCREEN_NOT_FOUND` — страница превращает
   * его в `notFound()`.
   *
   * `:id` — самый «жадный» паттерн контроллера, но с bulk-ручками
   * ниже он не сталкивается: те объявлены как `@Post`, а это `@Get`.
   * Если когда-нибудь появится GET со статическим сегментом
   * (`/display-screens/export`), объявлять его нужно ВЫШЕ этого метода.
   */
  @Get(':id')
  getOne(@Param('id') id: string) {
    return this.service.getOne(id);
  }

  /**
   * Правка экрана: название, подразделение, логин и PIN его
   * DISPLAY-учётки — одной транзакцией на обе записи. `isActive` сюда
   * НЕ входит: включением/выключением заведует контур архива ниже
   * (он же синхронно гасит учётку).
   */
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateDisplayScreenSchema))
    body: UpdateDisplayScreenDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.service.update(id, body, user.employeeId);
  }

  /**
   * Массовые операции архива со списка `/admin/display-screens`
   * (контракт — `@sewing/shared/archive`):
   *   archive — `isActive = false` + гасим DISPLAY-учётку экрана;
   *   restore — обратно;
   *   purge   — снести конфиг (только из архива) и, если получится,
   *             саму DISPLAY-учётку — иначе её логин навсегда занят.
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
