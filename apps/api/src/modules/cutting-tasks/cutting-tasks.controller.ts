import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  SaveCuttingTaskProgressSchema,
  type CuttingTaskDetailDto,
  type CuttingTaskSummaryDto,
  type OrderReadyForReleaseDto,
  type OrderReleaseStateDto,
} from '@sewing/shared/cutting-tasks';

import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import {
  CuttingTaskPayloadInvalidException,
} from '../../common/errors.js';
import { CuttingTasksService } from './cutting-tasks.service.js';

/**
 * `/api/cutting-tasks` — кабинет раскройщика (роль `CUTTER`).
 *
 * RBAC: `CUTTER` — основной пользователь; `SHOP_MANAGER`/`ADMIN`
 * оставлены в матрице, чтобы менеджер мог открыть тот же экран и
 * помочь с застрявшей задачей (очередь общая, владение не энфорсится).
 *
 * Создание задачи здесь НЕ выставлено наружу: задачи рождаются
 * автоматически из `OrdersService.start()` при запуске заказа в
 * производство.
 */
@Controller('cutting-tasks')
export class CuttingTasksController {
  constructor(private readonly tasks: CuttingTasksService) {}

  @Get()
  @Roles('CUTTER', 'SHOP_MANAGER', 'ADMIN')
  list(): Promise<CuttingTaskSummaryDto[]> {
    return this.tasks.listForCabinet();
  }

  /**
   * Доска помощника раскройщика `/work/cut-orders`: заказы с завершённым
   * раскроем, готовые к выпуску паспортов (со статусом «новый»/«завершено»).
   * Объявлен ДО `@Get(':id')`, чтобы роутер не разрешил `ready-for-release`
   * как `id`.
   */
  @Get('ready-for-release')
  @Roles('CUTTER_ASSISTANT', 'SHOP_MANAGER', 'ADMIN')
  listReadyForRelease(): Promise<OrderReadyForReleaseDto[]> {
    return this.tasks.listReadyForRelease();
  }

  /**
   * Данные заказа для рулонного выпуска помощником: размеры (с раскладкой
   * `на настиле`), рулоны и карта уже выпущенных пар `(размер, рулон)`.
   */
  @Get('by-order/:orderId/release-state')
  @Roles('CUTTER_ASSISTANT', 'SHOP_MANAGER', 'ADMIN')
  getReleaseState(
    @Param('orderId') orderId: string,
  ): Promise<OrderReleaseStateDto> {
    return this.tasks.getReleaseState(orderId);
  }

  @Get(':id')
  @Roles('CUTTER', 'SHOP_MANAGER', 'ADMIN')
  getOne(@Param('id') id: string): Promise<CuttingTaskDetailDto> {
    return this.tasks.getOne(id);
  }

  /**
   * «Принять задание» — `NEW` → `IN_PROGRESS`. Фиксируем текущего
   * раскройщика как `assignedToId`.
   */
  @Post(':id/start')
  @Roles('CUTTER', 'SHOP_MANAGER', 'ADMIN')
  start(
    @Param('id') id: string,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<CuttingTaskDetailDto> {
    if (!user.employeeId) {
      throw new CuttingTaskPayloadInvalidException(
        'У вашей учётки нет привязанного сотрудника — обратитесь к администратору.',
      );
    }
    return this.tasks.start(id, user.employeeId);
  }

  /**
   * Автосохранение прогресса настила: `perLayerQty` по размерам + весь
   * набор рулонов. Тело валидируется `SaveCuttingTaskProgressSchema`.
   */
  @Patch(':id')
  @Roles('CUTTER', 'SHOP_MANAGER', 'ADMIN')
  save(
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<CuttingTaskDetailDto> {
    return this.tasks.saveProgress(id, this.parseBody(body));
  }

  /**
   * «Раскрой завершён» — финальное сохранение + `IN_PROGRESS` → `DONE`.
   */
  @Post(':id/complete')
  @Roles('CUTTER', 'SHOP_MANAGER', 'ADMIN')
  complete(
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<CuttingTaskDetailDto> {
    return this.tasks.complete(id, this.parseBody(body));
  }

  private parseBody(body: unknown) {
    const parsed = SaveCuttingTaskProgressSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new CuttingTaskPayloadInvalidException(
        parsed.error.issues.map((i) => i.message).join('; ') ||
          'Невалидный payload.',
      );
    }
    return parsed.data;
  }
}
