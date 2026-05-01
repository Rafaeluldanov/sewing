import { Body, Controller, Get, Post } from '@nestjs/common';
import {
  CreateDisplayScreenSchema,
  type CreateDisplayScreenDto,
} from '@sewing/shared/display-screens';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { Roles } from '../auth/auth.decorators.js';
import { DisplayScreensService } from './display-screens.service.js';

/**
 * Контроллер «Display screens» (большие мониторы цеха).
 *
 *   GET  /api/display-screens   — список конфигов экранов
 *   POST /api/display-screens   — создать экран + DISPLAY-учётку
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
}
