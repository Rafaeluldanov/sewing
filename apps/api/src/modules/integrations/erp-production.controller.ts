import { Body, Controller, Get, Put, Query } from '@nestjs/common';

import { MachineScopes } from '../auth/auth.decorators.js';
import {
  ErpProductionService,
  type ProductionAckItem,
} from './erp-production.service.js';

/**
 * Сдача заказа в ERP: очередь закрытых заказов и приём ответа.
 *
 * ⛔ Единица учёта — ДОКУМЕНТ ПРОИЗВОДСТВА, а не паспорт (решение владельца 04.09.2026): паспорт
 * это документ цеха, он собирается в документ производства заказа, и уже документ приходуется
 * на склад ERP. Обе ручки машинные: экрана для человека в цехе у них нет.
 */
@Controller('integrations/erp-production')
@MachineScopes('stock:read')
export class ErpProductionController {
  constructor(private readonly production: ErpProductionService) {}

  /** Что ERP осталось принять: сданные заказы без её ответа, старейшие первыми. */
  @Get()
  async pending(@Query('limit') limit?: string, @Query('closed_from') closedFrom?: string) {
    const parsed = limit == null ? undefined : Number(limit);
    return this.production.listPending(
      Number.isFinite(parsed) ? (parsed as number) : undefined,
      closedFrom,
    );
  }

  /** Чем сдача стала в ERP: документ выпуска, склад, количество — или почему не стала. */
  @MachineScopes('stock:write')
  @Put()
  async ack(@Body() body: { items?: ProductionAckItem[] }) {
    const items = Array.isArray(body?.items) ? body.items : [];
    return this.production.ack(items);
  }
}
