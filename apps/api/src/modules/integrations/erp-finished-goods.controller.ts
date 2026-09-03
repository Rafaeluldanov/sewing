import { Body, Controller, Get, Put, Query } from '@nestjs/common';

import { MachineScopes } from '../auth/auth.decorators.js';
import {
  ErpFinishedGoodsService,
  type FinishedGoodsAckItem,
} from './erp-finished-goods.service.js';

/**
 * Очередь выпуска готовой продукции для ERP и приём её ответа (§0.5: готовая продукция цеха
 * приходуется на склад ERP, своих складов у цеха нет).
 *
 * Обе ручки машинные: очередь и факт прихода — служебный обмен, экрана для человека в цехе у
 * них нет. Скоупы те же, что у зеркала остатка и очереди расхода: речь об одном складе.
 */
@Controller('integrations/erp-finished-goods')
@MachineScopes('stock:read')
export class ErpFinishedGoodsController {
  constructor(private readonly finishedGoods: ErpFinishedGoodsService) {}

  /** Что ERP осталось оприходовать: упакованные паспорта без её ответа, старейшие первыми. */
  @Get()
  async pending(@Query('limit') limit?: string, @Query('packed_from') packedFrom?: string) {
    const parsed = limit == null ? undefined : Number(limit);
    return this.finishedGoods.listPending(
      Number.isFinite(parsed) ? (parsed as number) : undefined,
      packedFrom,
    );
  }

  /** Чем выпуск стал на складе ERP: документ, склад, номенклатура — или почему не стал. */
  @MachineScopes('stock:write')
  @Put()
  async ack(@Body() body: { items?: FinishedGoodsAckItem[] }) {
    const items = Array.isArray(body?.items) ? body.items : [];
    return this.finishedGoods.ack(items);
  }
}
