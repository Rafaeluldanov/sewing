import { Body, Controller, Param, Post } from '@nestjs/common';
import {
  SaveOrderTechCardAsTemplateSchema,
  type SaveOrderTechCardAsTemplateDto,
} from '@sewing/shared/order-tech-cards';
import type { TechCardTemplateDetailDto } from '@sewing/shared/tech-cards';

import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { OrdersService } from '../orders/orders.service.js';
import { TechCardsService } from '../tech-cards/tech-cards.service.js';

/**
 * «Сохранить как новый шаблон» — единственный мостик из заказа в справочник.
 *
 * Всё остальное в фиче работает в одну сторону: правка шаблона не двигает
 * заказы, правка в заказе не двигает справочник. Здесь технолог осознанно
 * говорит «эта техкарта пригодится снова» — и уезжает СТРУКТУРА (строки +
 * определения параметров), но не значения.
 */
@Controller('orders/:id/tech-card')
export class OrderTechCardTemplateController {
  constructor(
    private readonly techCards: TechCardsService,
    private readonly orders: OrdersService,
  ) {}

  /**
   * «Обновить из шаблона» — обратный клапан к принципу «шаблон читается один
   * раз». Действие РАЗРУШИТЕЛЬНОЕ: структура строк перезаписывается шаблоном,
   * правки, сделанные в заказе, теряются. Значения параметров переживают.
   */
  @Post('reload-from-template')
  @Roles('ADMIN', 'SHOP_MANAGER')
  async reload(
    @Param('id') orderId: string,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<{ ok: true }> {
    await this.orders.reloadTechCardFromTemplate(orderId, user.employeeId);
    return { ok: true };
  }

  @Post('save-as-template')
  @Roles('ADMIN', 'SHOP_MANAGER')
  saveAsTemplate(
    @Param('id') orderId: string,
    @Body(new ZodValidationPipe(SaveOrderTechCardAsTemplateSchema))
    dto: SaveOrderTechCardAsTemplateDto,
  ): Promise<TechCardTemplateDetailDto> {
    return this.techCards.createFromOrderSnapshot(
      orderId,
      dto.orderVariantId ?? null,
      { code: dto.code, name: dto.name },
    );
  }
}
