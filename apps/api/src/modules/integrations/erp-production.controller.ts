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

  /**
   * Что ERP осталось приходовать: готовые документы выпуска, старейшие первыми.
   *
   * Курсор — `?ready_from=` по дате готовности документа. `closed_from` принимается как
   * синоним: так ручка называлась, пока очередь держалась на ответе ERP, и ломать её опрос
   * ради переименования параметра — плохой обмен.
   */
  @Get()
  async pending(
    @Query('limit') limit?: string,
    @Query('ready_from') readyFrom?: string,
    @Query('closed_from') closedFrom?: string,
  ) {
    const parsed = limit == null ? undefined : Number(limit);
    return this.production.listPending(
      Number.isFinite(parsed) ? (parsed as number) : undefined,
      readyFrom ?? closedFrom,
    );
  }

  /**
   * ЖУРНАЛ ответа ERP: чем сдача стала у неё — документ, склад, количество.
   *
   * ⛔ Ни на что не влияет и очередь больше не гейтит (согласования нет): выгрузка идёт по
   * курсору готовности. Оставлено как след для разбора расхождений — «мы отдали, она завела вот
   * это». Если ERP перестанет его слать, цех ничего не заметит.
   */
  @MachineScopes('stock:write')
  @Put()
  async ack(@Body() body: { items?: ProductionAckItem[] }) {
    const items = Array.isArray(body?.items) ? body.items : [];
    return this.production.ack(items);
  }
}
