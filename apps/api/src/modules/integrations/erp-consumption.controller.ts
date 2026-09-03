import { Body, Controller, Get, Put, Query } from '@nestjs/common';

import { MachineScopes } from '../auth/auth.decorators.js';
import { ErpConsumptionService, type AckItem } from './erp-consumption.service.js';

/**
 * Очередь списания материала в ERP по выпуску цеха и приём её ответа
 * (лестница остатков, шаг 5; правило владельца §0.3 — материал списывается
 * при выпуске и на складе ERP).
 *
 * Обе ручки машинные: очередь и факт списания — служебный обмен, у человека
 * в цехе для них экрана нет. Скоупы — те же, что у зеркала остатка
 * (`stock:read`/`stock:write`): речь о том же складе, просто с другой стороны.
 */
@Controller('integrations/erp-consumption')
@MachineScopes('stock:read')
export class ErpConsumptionController {
  constructor(private readonly consumption: ErpConsumptionService) {}

  /** Что ERP осталось списать: упакованные паспорта без факта, старейшие первыми. */
  @Get()
  async pending(@Query('limit') limit?: string) {
    const parsed = limit == null ? undefined : Number(limit);
    return this.consumption.listPending(
      Number.isFinite(parsed) ? (parsed as number) : undefined,
    );
  }

  /** Результат списания из ERP: сумма, рулон и разбивка по потребностям. */
  @MachineScopes('stock:write')
  @Put()
  async ack(@Body() body: { items?: AckItem[] }) {
    const items = Array.isArray(body?.items) ? body.items : [];
    return this.consumption.ack(items);
  }
}
