import { Controller, Param, Post } from '@nestjs/common';
import type { OrderTechCardParametersDto } from '@sewing/shared/order-tech-cards';

import { CurrentUser, MachineScopes, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { OrdersService } from '../orders/orders.service.js';
import { OrderTechCardService } from './order-tech-card.service.js';

/**
 * Мосты «заказ ↔ номенклатура» для спецификации материалов (этап 5
 * «техкарты → номенклатура»: обратного моста «сохранить как шаблон»
 * больше нет — состав правится на карточке номенклатуры).
 */
@Controller('orders/:id/tech-card')
@MachineScopes('orders:read')
export class OrderTechCardTemplateController {
  constructor(
    private readonly orders: OrdersService,
    private readonly orderTechCard: OrderTechCardService,
  ) {}

  /**
   * «Обновить нормы из номенклатуры» — мягкий брат «Обновить из шаблона».
   * Структуру строк не трогает: снимает отметку «норма правлена в заказе» и
   * перечитывает числа из карточки номенклатуры (нормы фурнитуры, погонные
   * метры, площади). Ручные строки остаются со своими числами.
   */
  @MachineScopes('orders:write')
  @Post('reload-norms')
  @Roles('ADMIN', 'SHOP_MANAGER')
  reloadNorms(
    @Param('id') orderId: string,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<OrderTechCardParametersDto> {
    return this.orderTechCard.resetNormsFromNomenclature(
      orderId,
      user.employeeId,
    );
  }

  /**
   * «Обновить из номенклатуры» — обратный клапан к принципу «источник
   * читается один раз». Действие РАЗРУШИТЕЛЬНОЕ: структура строк
   * перезаписывается спецификацией карточки, правки, сделанные в заказе,
   * теряются. Значения параметров и ручные строки переживают.
   */
  @MachineScopes('orders:write')
  @Post('reload-from-template')
  @Roles('ADMIN', 'SHOP_MANAGER')
  async reload(
    @Param('id') orderId: string,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<{ ok: true }> {
    await this.orders.reloadTechCardFromTemplate(orderId, user.employeeId);
    return { ok: true };
  }

}
