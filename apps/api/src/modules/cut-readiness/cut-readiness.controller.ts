import { Controller, Get, Param } from '@nestjs/common';
import type { CutReadinessDto } from '@sewing/shared/cut-readiness';

import { MachineScopes, Roles } from '../auth/auth.decorators.js';
import { CutReadinessService } from './cut-readiness.service.js';

/**
 * `/api/orders/:orderId/cut-readiness` — read-only проверка
 * готовности заказа к крою (Этап 8А, см.
 * `docs/recon-soft-integration.md §«Этап 8А»`).
 *
 * RBAC:
 *   - `ADMIN`             — полный доступ;
 *   - `SHOP_MANAGER`      — управленец, ему нужна сводка перед
 *                           запуском кроя;
 *   - `CUTTER`            — раскройщик, перед физическим раскроем
 *                           видит, чего не хватает;
 *   - `CUTTER_ASSISTANT`  — помощник раскройщика, тот же сценарий.
 *
 * Никаких write-методов — это сознательное ограничение Этапа 8А.
 */
@Controller('orders')
@MachineScopes('orders:read')
@Roles('ADMIN', 'SHOP_MANAGER', 'CUTTER', 'CUTTER_ASSISTANT')
export class CutReadinessController {
  constructor(private readonly readiness: CutReadinessService) {}

  @Get(':orderId/cut-readiness')
  getForOrder(
    @Param('orderId') orderId: string,
  ): Promise<CutReadinessDto> {
    return this.readiness.getForOrder(orderId);
  }
}
