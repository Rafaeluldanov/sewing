import { Body, Controller, Param, Post } from '@nestjs/common';
import {
  SaveOrderTechCardAsTemplateSchema,
  type SaveOrderTechCardAsTemplateDto,
} from '@sewing/shared/order-tech-cards';
import type { TechCardTemplateDetailDto } from '@sewing/shared/tech-cards';

import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { Roles } from '../auth/auth.decorators.js';
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
  constructor(private readonly techCards: TechCardsService) {}

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
