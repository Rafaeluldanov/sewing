import { Body, Controller, Param, Post } from '@nestjs/common';
import {
  SaveOrderTechCardAsTemplateSchema,
  type OrderTechCardParametersDto,
  type SaveOrderTechCardAsTemplateDto,
} from '@sewing/shared/order-tech-cards';
import type { TechCardTemplateDetailDto } from '@sewing/shared/tech-cards';

import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { OrdersService } from '../orders/orders.service.js';
import { TechCardsService } from '../tech-cards/tech-cards.service.js';
import { OrderTechCardService } from './order-tech-card.service.js';

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
    private readonly orderTechCard: OrderTechCardService,
  ) {}

  /**
   * «Обновить нормы из номенклатуры» — мягкий брат «Обновить из шаблона».
   * Структуру строк не трогает: снимает отметку «норма правлена в заказе» и
   * перечитывает числа из карточки номенклатуры (нормы фурнитуры, погонные
   * метры, площади). Ручные строки остаются со своими числами.
   */
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
