import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { HttpStatus } from '@nestjs/common';
import {
  StartRecutSchema,
  type RecutOrderSearchItemDto,
  type RecutSessionDto,
} from '@sewing/shared/recut';

import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { BusinessException } from '../../common/errors.js';
import { RecutService } from './recut.service.js';

/**
 * `/api/recut` — фича «Подкрой» (роль `CUTTER`).
 *
 * Подкрой — отдельная хронометрируемая активность раскройщика по заказу
 * (докрой деталей), возможная даже по завершённому заказу. Доступен в
 * рамках открытой смены; заказ выбирается поиском по номеру.
 *
 * RBAC: `CUTTER` — основной пользователь; `SHOP_MANAGER`/`ADMIN`
 * оставлены, чтобы менеджер мог помочь/посмотреть (как и в кабинете
 * раскройщика). `employeeId` всегда берётся из сессии (ADR-0014).
 */
@Controller('recut')
export class RecutController {
  constructor(private readonly recut: RecutService) {}

  /** Активный подкрой текущего сотрудника (для живого таймера на доске). */
  @Get('active')
  @Roles('CUTTER', 'SHOP_MANAGER', 'ADMIN')
  getActive(
    @CurrentUser() user: AuthPrincipal,
  ): Promise<RecutSessionDto | null> {
    return this.recut.getActiveForEmployee(this.employeeId(user));
  }

  /** Поиск заказа по номеру (любой статус, вкл. завершённые). */
  @Get('orders')
  @Roles('CUTTER', 'SHOP_MANAGER', 'ADMIN')
  searchOrders(
    @Query('q') q?: string,
  ): Promise<RecutOrderSearchItemDto[]> {
    return this.recut.searchOrders(q ?? '');
  }

  /** «Начать подкрой» — требует открытую смену и отсутствие активного подкроя. */
  @Post('start')
  @Roles('CUTTER', 'SHOP_MANAGER', 'ADMIN')
  start(
    @Body() body: unknown,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<RecutSessionDto> {
    const parsed = StartRecutSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BusinessException(
        'RECUT_PAYLOAD_INVALID',
        parsed.error.issues.map((i) => i.message).join('; ') ||
          'Невалидный payload.',
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.recut.start({
      employeeId: this.employeeId(user),
      orderId: parsed.data.orderId,
    });
  }

  /** «Завершить подкрой» — `ACTIVE` → `DONE` + пересчёт доплаты. */
  @Post(':id/complete')
  @Roles('CUTTER', 'SHOP_MANAGER', 'ADMIN')
  complete(
    @Param('id') id: string,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<RecutSessionDto> {
    return this.recut.complete(id, this.employeeId(user));
  }

  /** «Отменить подкрой» — `ACTIVE` → `CANCELLED`, без оплаты. */
  @Post(':id/cancel')
  @Roles('CUTTER', 'SHOP_MANAGER', 'ADMIN')
  cancel(
    @Param('id') id: string,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<RecutSessionDto> {
    return this.recut.cancel(id, this.employeeId(user));
  }

  private employeeId(user: AuthPrincipal): string {
    if (!user.employeeId) {
      throw new BusinessException(
        'RECUT_NO_EMPLOYEE',
        'У вашей учётки нет привязанного сотрудника — обратитесь к администратору.',
        HttpStatus.CONFLICT,
      );
    }
    return user.employeeId;
  }
}
