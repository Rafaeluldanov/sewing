import { Injectable, Logger } from '@nestjs/common';
import { OrderStatus, PassportStatus } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service.js';
import { OrderFactCostService } from '../costs/order-fact-cost.service.js';

/** Что ERP отвечает по сданному заказу. */
export type ProductionAckItem = {
  order_id?: string;
  state?: string;
  erp_document_id?: string | null;
  erp_document_number?: string | null;
  erp_organization_id?: string | null;
  erp_warehouse_id?: string | null;
  qty_good?: number | null;
  posted_at?: string | null;
  error?: string | null;
};

/**
 * Сдача заказа в ERP: ДОКУМЕНТ ПРОИЗВОДСТВА, а не паспорт (решение владельца 04.09.2026).
 *
 * Паспорт — документ ЦЕХА: он рождается на раскрое, живёт по операциям и закрывается упаковкой.
 * В учёте предприятия его место — основание, а не документ: паспорта собираются в документ
 * производства заказа, и уже он становится документом выпуска ERP и приходует продукцию на
 * склад. Раньше ERP заводила документ на каждый паспорт — на один заказ выходило три десятка.
 *
 * ⛔ В очередь попадают только ЗАКРЫТЫЕ заказы, рождённые заказом покупателя ERP. Закрытие —
 * это и есть момент, когда цех сдал работу: до него изделия ещё в производстве, и приходовать
 * нечего. Собственные заказы цеха здесь не появляются никогда: ERP нечего им ответить.
 *
 * ⛔ Ответ ERP НЕОБРАТИМ: он создаёт строку `ErpProductionDocument`, и заказ исчезает из очереди
 * навсегда. Поэтому отвечать надо только по тому, что действительно разложено.
 */
@Injectable()
export class ErpProductionService {
  private static readonly DEFAULT_LIMIT = 20;
  private static readonly MAX_LIMIT = 100;
  private readonly logger = new Logger(ErpProductionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cost: OrderFactCostService,
  ) {}

  /** Отсечка: документы, готовые раньше неё, в выгрузку не попадают. Без неё выгрузка ПУСТА. */
  private async cutoff(readyFrom?: string): Promise<Date | null> {
    if (readyFrom) {
      const parsed = new Date(readyFrom);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
    const settings = await this.prisma.companySettings.findFirst({
      select: { erpFinishedGoodsSince: true },
    });
    return settings?.erpFinishedGoodsSince ?? null;
  }

  /**
   * Готовые документы выпуска для ERP: она их ЧИТАЕТ и приходует у себя.
   *
   * ⛔ Согласования нет (решение владельца 08.09.2026): документ выпуска — наш, и его состояние
   * не зависит от того, ответила ERP или нет. Раньше очередь держалась на ответе (`ack` создавал
   * строку, и заказ уходил навсегда); теперь это КУРСОР — `?ready_from=` по дате готовности.
   * Повтор гасит ERP у себя по номеру нашего документа: он стабилен и не меняется.
   *
   * ⛔ Отсечка обязательна: без неё очередь ПУСТА, а не «без фильтра». `gte: undefined` в Prisma
   * молча исчезает из запроса, и первый же опрос отдал бы весь архив сдач.
   *
   * Документы, ПЕРЕСОБРАННЫЕ после фиксации (поздний факт — списание задним числом, правка
   * начисления), попадают в выборку повторно по `recalculatedAt`: у ERP должна быть возможность
   * увидеть исправленную сумму, иначе расхождение осталось бы только у нас.
   */
  async listPending(
    limit?: number,
    readyFrom?: string,
  ): Promise<{ count: number; items: Array<Record<string, unknown>> }> {
    const take = Math.min(
      Math.max(1, limit ?? ErpProductionService.DEFAULT_LIMIT),
      ErpProductionService.MAX_LIMIT,
    );
    const since = await this.cutoff(readyFrom);
    if (!since) return { count: 0, items: [] };

    const docs = await this.prisma.productionDocument.findMany({
      where: {
        status: 'READY',
        OR: [{ readyAt: { gte: since } }, { recalculatedAt: { gte: since } }],
        // Собственный заказ цеха ERP не касается: приходовать его ей некуда.
        order: { erpCustomerOrderId: { not: null } },
      },
      orderBy: [{ readyAt: 'asc' }, { number: 'asc' }],
      take,
      select: {
        id: true,
        number: true,
        orderId: true,
        readyAt: true,
        recalculatedAt: true,
        recalcReason: true,
        closedAt: true,
        qtyPlan: true,
        qtyGood: true,
        qtyDefect: true,
        materialsOwnRub: true,
        materialsErpRub: true,
        pieceworkRub: true,
        pieceworkPendingRub: true,
        recutRub: true,
        salaryRub: true,
        otherRub: true,
        totalRub: true,
        perUnitRub: true,
        planTotalRub: true,
        planPerUnitRub: true,
        costWarnings: true,
        order: {
          select: {
            number: true,
            customer: true,
            erpCustomerOrderId: true,
            erpCustomerOrderNumber: true,
            patternItemId: true,
            patternNameSnapshot: true,
            patternArticleSnapshot: true,
          },
        },
        lines: {
          select: {
            orderVariantId: true,
            color: true,
            sizeId: true,
            qtyGood: true,
            qtyCut: true,
            qtyDefect: true,
            isSample: true,
            passportNumbers: true,
            size: { select: { code: true } },
          },
        },
      },
    });
    if (docs.length === 0) return { count: 0, items: [] };

    // Брак ПО ПРИЧИНАМ: в ERP до сих пор ехала только сумма, и «почему недосдали» не отвечал
    // никто. Причина — свойство паспорта, поэтому берётся живой выборкой по паспортам строки:
    // в документе хранится состав выпуска, а не разбор брака.
    const passportNumbers = docs.flatMap((d) =>
      d.lines.flatMap((l) => l.passportNumbers),
    );
    const defects = passportNumbers.length
      ? await this.prisma.passportDefect.findMany({
          where: { passport: { number: { in: passportNumbers } } },
          select: {
            qty: true,
            comment: true,
            passport: { select: { number: true } },
            defectType: { select: { code: true, name: true } },
          },
        })
      : [];
    const defectsByPassport = new Map<string, Array<Record<string, unknown>>>();
    for (const d of defects) {
      const key = d.passport?.number ?? '';
      const list = defectsByPassport.get(key) ?? [];
      list.push({
        passport: key,
        code: d.defectType?.code ?? null,
        name: d.defectType?.name ?? null,
        qty: d.qty,
        comment: d.comment,
      });
      defectsByPassport.set(key, list);
    }

    const items = docs.map((doc) => ({
      document_id: doc.id,
      // Номер НАШЕГО документа — ключ идемпотентности на стороне ERP: он стабилен и переживает
      // пересборку, поэтому повторное чтение не заводит второй приход.
      document_number: doc.number,
      order_id: doc.orderId,
      order_number: doc.order.number,
      erp_customer_order_id: doc.order.erpCustomerOrderId,
      erp_customer_order_number: doc.order.erpCustomerOrderNumber,
      customer: doc.order.customer,
      closed_at: doc.closedAt.toISOString(),
      ready_at: doc.readyAt?.toISOString() ?? null,
      recalculated_at: doc.recalculatedAt?.toISOString() ?? null,
      recalc_reason: doc.recalcReason,
      pattern_item_id: doc.order.patternItemId,
      pattern_name: doc.order.patternNameSnapshot,
      pattern_article: doc.order.patternArticleSnapshot,
      qty_plan: doc.qtyPlan,
      qty_good: doc.qtyGood,
      qty_defect: doc.qtyDefect,
      lines: doc.lines.map((l) => ({
        variant_id: l.orderVariantId,
        color: l.color,
        size_id: l.sizeId,
        size_code: l.size?.code ?? null,
        qty_good: l.qtyGood,
        qty_cut: l.qtyCut,
        qty_defect: l.qtyDefect,
        is_sample: l.isSample,
        passports: l.passportNumbers,
        defects: l.passportNumbers.flatMap(
          (numberValue) => defectsByPassport.get(numberValue) ?? [],
        ),
      })),
      // Себестоимость — снимок документа, а не пересчёт на каждый опрос: у одной цифры один
      // хозяин, и ERP должна видеть ровно то, что видит цех.
      cost: {
        materials_own_rub: Number(doc.materialsOwnRub),
        materials_erp_rub: Number(doc.materialsErpRub),
        piecework_rub: Number(doc.pieceworkRub),
        piecework_pending_rub: Number(doc.pieceworkPendingRub),
        recut_rub: Number(doc.recutRub),
        salary_rub: Number(doc.salaryRub),
        other_rub: Number(doc.otherRub),
        total_rub: Number(doc.totalRub),
        per_unit_rub: Number(doc.perUnitRub),
        plan_total_rub: doc.planTotalRub == null ? null : Number(doc.planTotalRub),
        plan_per_unit_rub:
          doc.planPerUnitRub == null ? null : Number(doc.planPerUnitRub),
        warnings: doc.costWarnings,
      },
    }));
    return { count: items.length, items };
  }

  /**
   * Записать ответ ERP: чем сдача стала у неё (документ выпуска) — или почему не стала.
   *
   * ⛔ Каждый элемент в своём try/catch: один кривой ответ не должен отменять остальные, иначе
   * заказы, которые ERP уже оприходовала, останутся в очереди и приедут к ней второй раз.
   */
  async ack(items: ProductionAckItem[]): Promise<{
    accepted: number;
    skipped: Array<{ order_id: string; reason: string }>;
  }> {
    const skipped: Array<{ order_id: string; reason: string }> = [];
    let accepted = 0;
    for (const item of items) {
      const orderId = String(item?.order_id ?? '');
      if (!orderId) {
        skipped.push({ order_id: '', reason: 'нет order_id' });
        continue;
      }
      try {
        const order = await this.prisma.order.findUnique({
          where: { id: orderId },
          select: { id: true, erpCustomerOrderId: true },
        });
        if (!order) {
          skipped.push({ order_id: orderId, reason: 'заказ не найден' });
          continue;
        }
        if (!order.erpCustomerOrderId) {
          // Собственный заказ цеха: ERP по нему ничего не решает.
          skipped.push({ order_id: orderId, reason: 'заказ не из ERP' });
          continue;
        }
        const data = {
          state: String(item.state ?? 'POSTED').toUpperCase(),
          erpDocumentId: item.erp_document_id ?? null,
          erpDocumentNumber: item.erp_document_number ?? null,
          erpOrganizationId: item.erp_organization_id ?? null,
          erpWarehouseId: item.erp_warehouse_id ?? null,
          qtyGood: item.qty_good ?? null,
          postedAt: item.posted_at ? new Date(item.posted_at) : null,
          error: item.error ?? null,
          payload: (item as Record<string, unknown>).payload ?? undefined,
          syncedAt: new Date(),
        };
        await this.prisma.erpProductionDocument.upsert({
          where: { orderId },
          create: { orderId, ...data },
          update: data,
        });
        accepted += 1;
      } catch (error) {
        this.logger.warn(
          `event=erp-production.ack.failed orderId=${orderId} error=${String(error)}`,
        );
        skipped.push({ order_id: orderId, reason: String(error) });
      }
    }
    return { accepted, skipped };
  }
}
