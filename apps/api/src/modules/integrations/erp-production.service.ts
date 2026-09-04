import { Injectable, Logger } from '@nestjs/common';
import { OrderStatus, PassportStatus } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service.js';

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

  constructor(private readonly prisma: PrismaService) {}

  /** Отсечка: раньше неё сданные заказы в очередь не попадают. Без неё очередь ПУСТА. */
  private async cutoff(closedFrom?: string): Promise<Date | null> {
    if (closedFrom) {
      const parsed = new Date(closedFrom);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
    const settings = await this.prisma.companySettings.findFirst({
      select: { erpFinishedGoodsSince: true },
    });
    return settings?.erpFinishedGoodsSince ?? null;
  }

  /**
   * Сданные заказы, по которым ERP ещё не ответила: строки по цвету и размеру, собранные из
   * упакованных паспортов. Старейшие первыми — по дате закрытия.
   */
  async listPending(
    limit?: number,
    closedFrom?: string,
  ): Promise<{ count: number; items: Array<Record<string, unknown>> }> {
    const take = Math.min(
      Math.max(1, limit ?? ErpProductionService.DEFAULT_LIMIT),
      ErpProductionService.MAX_LIMIT,
    );
    const since = await this.cutoff(closedFrom);
    // ⛔ Нет отсечки — пустая очередь: `gte: undefined` в Prisma молча исчезает из запроса, и
    // «фильтр по умолчанию» отдал бы весь архив сданных заказов.
    if (!since) return { count: 0, items: [] };

    const orders = await this.prisma.order.findMany({
      where: {
        status: OrderStatus.DONE,
        completedAt: { gte: since },
        erpCustomerOrderId: { not: null },
        erpProduction: { is: null },
      },
      orderBy: [{ completedAt: 'asc' }, { id: 'asc' }],
      take,
      select: {
        id: true,
        number: true,
        erpCustomerOrderId: true,
        erpCustomerOrderNumber: true,
        completedAt: true,
        patternItemId: true,
        patternNameSnapshot: true,
        patternArticleSnapshot: true,
        customer: true,
        items: { select: { sizeId: true, qtyPlan: true, size: { select: { code: true } } } },
      },
    });
    if (orders.length === 0) return { count: 0, items: [] };

    // Паспорта сданных заказов: упакованные и с годным выпуском. Это и есть содержимое
    // документа производства — из них собираются строки «цвет + размер + количество».
    const passports = await this.prisma.passport.findMany({
      where: {
        orderId: { in: orders.map((o) => o.id) },
        status: PassportStatus.PACKED,
        qtyGood: { gt: 0 },
      },
      select: {
        id: true,
        number: true,
        orderId: true,
        orderVariantId: true,
        color: true,
        sizeId: true,
        qtyGood: true,
        qtyCut: true,
        qtyDefect: true,
        sampleId: true,
        size: { select: { code: true } },
      },
    });

    const byOrder = new Map<string, typeof passports>();
    for (const p of passports) {
      const list = byOrder.get(p.orderId) ?? [];
      list.push(p);
      byOrder.set(p.orderId, list);
    }

    const items = orders.map((order) => {
      const own = byOrder.get(order.id) ?? [];
      const lines = new Map<string, Record<string, unknown>>();
      for (const p of own) {
        const key = `${p.orderVariantId ?? ''}|${p.color ?? ''}|${p.sizeId}`;
        const line = lines.get(key) ?? {
          variant_id: p.orderVariantId,
          color: p.color,
          size_id: p.sizeId,
          size_code: p.size?.code ?? null,
          qty_good: 0,
          qty_cut: 0,
          qty_defect: 0,
          is_sample: !!p.sampleId,
          passports: [] as string[],
        };
        line.qty_good = Number(line.qty_good) + (p.qtyGood ?? 0);
        line.qty_cut = Number(line.qty_cut) + (p.qtyCut ?? 0);
        line.qty_defect = Number(line.qty_defect) + (p.qtyDefect ?? 0);
        (line.passports as string[]).push(p.number ?? p.id);
        lines.set(key, line);
      }
      const rows = [...lines.values()];
      return {
        order_id: order.id,
        order_number: order.number,
        erp_customer_order_id: order.erpCustomerOrderId,
        erp_customer_order_number: order.erpCustomerOrderNumber,
        customer: order.customer,
        closed_at: order.completedAt?.toISOString() ?? null,
        pattern_item_id: order.patternItemId,
        pattern_name: order.patternNameSnapshot,
        pattern_article: order.patternArticleSnapshot,
        qty_plan: order.items.reduce((sum, i) => sum + (i.qtyPlan ?? 0), 0),
        qty_good: rows.reduce((sum, r) => sum + Number(r.qty_good), 0),
        qty_defect: rows.reduce((sum, r) => sum + Number(r.qty_defect), 0),
        lines: rows,
      };
    });
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
