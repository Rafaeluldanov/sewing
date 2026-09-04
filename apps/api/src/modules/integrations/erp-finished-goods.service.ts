import { Injectable, Logger } from '@nestjs/common';
import { PassportStatus, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * ОЧЕРЕДЬ ВЫПУСКА ГОТОВОЙ ПРОДУКЦИИ В ERP (§0.5).
 *
 * Готовая продукция швейного цеха приходуется на склад ERP; собственных складов — материалов,
 * готовой продукции, полок — у цеха нет (правило владельца §0.5,
 * `service/docs/kb/sewing.md`). Здесь — та же механика, что у очереди расхода материала:
 * цех отдаёт ФАКТ (упакованный паспорт: сколько годного, какое лекало, размер, цвет), ERP
 * приходует своим документом и отвечает, что именно встало на учёт.
 *
 * ⛔ ТРИ ОТЛИЧИЯ ОТ ОЧЕРЕДИ РАСХОДА, каждое обязательное:
 *   1. без даты отсечки очередь ПУСТА, а не «без фильтра»: упакованных паспортов больше тысячи,
 *      и первый же опрос оприходовал бы весь архив задним числом;
 *   2. паспорта ОТМЕНЁННЫХ заказов не отдаются: отмена заказа паспортов не трогает, а
 *      приходовать изделия отменённого заказа на склад нельзя;
 *   3. фильтра «у заказа есть строки под ERP» нет: приход готовой продукции не зависит от того,
 *      чей был материал.
 */
@Injectable()
export class ErpFinishedGoodsService {
  private readonly logger = new Logger(ErpFinishedGoodsService.name);

  constructor(private readonly prisma: PrismaService) {}

  private static readonly DEFAULT_LIMIT = 50;
  private static readonly MAX_LIMIT = 200;

  /** Состояния, которые ERP может прислать в `ack`. */
  private static readonly STATES = new Set(['POSTED', 'EMPTY', 'FAILED', 'REVERSED']);

  /** Дата отсечки: настройка компании, при её отсутствии — параметр запроса от ERP. */
  private async cutoff(packedFrom?: string): Promise<Date | null> {
    const settings = await this.prisma.companySettings.findUnique({
      where: { id: 'default' },
      select: { erpFinishedGoodsSince: true },
    });
    if (settings?.erpFinishedGoodsSince) return settings.erpFinishedGoodsSince;
    if (!packedFrom) return null;
    const parsed = new Date(packedFrom);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  /**
   * Что ERP осталось оприходовать: упакованные паспорта без её ответа, старейшие первыми.
   *
   * Порядок — по времени упаковки: приход на склад должен повторять порядок выпуска, иначе
   * при разборе расхождений «что за чем встало» не восстановить.
   */
  async listPending(
    limit?: number,
    packedFrom?: string,
  ): Promise<{ count: number; items: Array<Record<string, unknown>> }> {
    const take = Math.min(
      Math.max(1, limit ?? ErpFinishedGoodsService.DEFAULT_LIMIT),
      ErpFinishedGoodsService.MAX_LIMIT,
    );
    const since = await this.cutoff(packedFrom);
    // ⛔ Нет отсечки — пустая очередь. В Prisma `gte: undefined` молча исчезает из запроса, и
    // «фильтр по умолчанию» превратился бы в выдачу всего архива упаковки.
    if (!since) return { count: 0, items: [] };

    const events = await this.prisma.passportEvent.findMany({
      where: {
        type: 'PACKED',
        createdAt: { gte: since },
        passport: {
          status: PassportStatus.PACKED,
          qtyGood: { gt: 0 },
          erpFinishedGoods: { is: null },
          // ⛔ ТОЛЬКО заказы, рождённые заказом покупателя ERP (решение владельца 03.09.2026).
          // Отсечка обязана быть СТРУКТУРНОЙ и стоять у источника: ответ ERP необратим (он
          // создаёт здесь строку, и паспорт исчезает из очереди навсегда), а по чужому заказу
          // ей нечего ответить, кроме «не смогли» — то есть сжечь чужую продукцию, лежащую на
          // полке. Собственные заказы цеха в очередь не попадают вовсе.
          order: {
            status: { not: 'CANCELLED' },
            erpCustomerOrderId: { not: null },
          },
        },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      distinct: ['passportId'],
      take,
      select: {
        createdAt: true,
        passport: {
          select: {
            id: true,
            number: true,
            orderId: true,
            productId: true,
            sizeId: true,
            color: true,
            qtyPlan: true,
            qtyCut: true,
            qtyDefect: true,
            qtyGood: true,
            orderVariantId: true,
            sampleId: true,
            erpSeriesId: true,
            erpRollLabel: true,
            product: { select: { name: true } },
            size: { select: { code: true } },
            order: {
              select: {
                id: true,
                number: true,
                status: true,
                patternItemId: true,
                patternNameSnapshot: true,
                patternArticleSnapshot: true,
                finishedGoodsWarehouseId: true,
              },
            },
            boxItems: { select: { box: { select: { number: true } } }, take: 1 },
          },
        },
      },
    });

    const items = events
      .filter((e) => e.passport)
      .map((e) => {
        const p = e.passport!;
        return {
          passport_id: p.id,
          passport_number: p.number,
          order_id: p.orderId,
          order_number: p.order?.number ?? null,
          order_status: p.order?.status ?? null,
          packed_at: e.createdAt,
          qty_good: p.qtyGood,
          qty_cut: p.qtyCut,
          qty_defect: p.qtyDefect,
          qty_plan: p.qtyPlan,
          // Лекало — ЕДИНСТВЕННЫЙ стабильный ключ сопоставления: техническая карточка изделия
          // цеха заводится под заказ («Худи / заказ 02-00042») и не повторяется никогда.
          pattern_item_id: p.order?.patternItemId ?? null,
          pattern_article: p.order?.patternArticleSnapshot ?? null,
          pattern_name: p.order?.patternNameSnapshot ?? null,
          product_id: p.productId,
          product_name: p.product?.name ?? null,
          size_id: p.sizeId,
          size_code: p.size?.code ?? null,
          color: p.color,
          order_variant_id: p.orderVariantId,
          sample_id: p.sampleId,
          box_number: p.boxItems?.[0]?.box?.number ?? null,
          erp_series_id: p.erpSeriesId,
          erp_roll_label: p.erpRollLabel,
          teeon_warehouse_id: p.order?.finishedGoodsWarehouseId ?? null,
        };
      });
    return { count: items.length, items };
  }

  /**
   * Принять ответ ERP: чем стал выпуск на её складе (или почему не стал).
   *
   * ⛔ КАЖДЫЙ элемент в СВОЁМ try/catch: исключение по одному паспорту уходит в `skipped`, а не
   * роняет весь PUT. Иначе ERP не пометит доставленным НИ ОДИН ответ пакета и будет повторять
   * его вечно, а очередь встанет на первом же плохом паспорте.
   */
  async ack(items: FinishedGoodsAckItem[]): Promise<{
    accepted: number;
    skipped: Array<{ passport_id: string; reason: string }>;
  }> {
    let accepted = 0;
    const skipped: Array<{ passport_id: string; reason: string }> = [];
    for (const item of items) {
      const passportId = String(item?.passport_id ?? '');
      if (!passportId) {
        skipped.push({ passport_id: '', reason: 'passport_id_required' });
        continue;
      }
      const state = String(item?.state ?? 'POSTED').toUpperCase();
      if (!ErpFinishedGoodsService.STATES.has(state)) {
        skipped.push({ passport_id: passportId, reason: 'unknown_state' });
        continue;
      }
      try {
        const passport = await this.prisma.passport.findUnique({
          where: { id: passportId },
          select: { id: true, orderId: true },
        });
        if (!passport) {
          skipped.push({ passport_id: passportId, reason: 'passport_not_found' });
          continue;
        }
        const data = {
          orderId: passport.orderId,
          state,
          erpDocumentId: item.erp_document_id ?? null,
          erpDocumentNumber: item.erp_document_number ?? null,
          erpOrganizationId: item.erp_organization_id ?? null,
          erpOrganizationName: item.erp_organization_name ?? null,
          erpWarehouseId: item.erp_warehouse_id ?? null,
          erpWarehouseName: item.erp_warehouse_name ?? null,
          erpNomenclatureId: item.erp_nomenclature_id ?? null,
          erpNomenclatureName: item.erp_nomenclature_name ?? null,
          erpCharacteristicId: item.erp_characteristic_id ?? null,
          erpCharacteristicName: item.erp_characteristic_name ?? null,
          qty: item.qty == null ? null : Number(item.qty),
          postedAt: item.posted_at ? new Date(item.posted_at) : null,
          error: item.error ?? null,
          syncedAt: new Date(),
        };
        await this.prisma.erpFinishedGoodsReceipt.upsert({
          where: { passportId },
          create: { passportId, ...data },
          update: data,
        });
        accepted += 1;
        this.logger.log(
          `event=erp_finished_goods.ack passportId=${passportId} state=${state} ` +
            `doc=${data.erpDocumentNumber ?? '-'} qty=${data.qty ?? '-'}`,
        );
      } catch (e) {
        // Один паспорт не должен останавливать очередь: причина уходит в ответ, ERP пометит
        // строку доставленной и сохранит текст — человек увидит расхождение на её экране.
        this.logger.error(
          `event=erp_finished_goods.ack.failed passportId=${passportId} error=${String(e)}`,
        );
        skipped.push({ passport_id: passportId, reason: 'ack_failed' });
      }
    }
    return { accepted, skipped };
  }
}

/** Ответ ERP по одному паспорту — контракт в её терминах (переименовывать нельзя). */
export type FinishedGoodsAckItem = {
  passport_id: string;
  /** `POSTED` — оприходовано; `EMPTY` — приходовать нечего; `FAILED` — не смогла; `REVERSED` — сторно. */
  state?: string;
  erp_document_id?: string | null;
  erp_document_number?: string | null;
  erp_organization_id?: string | null;
  erp_organization_name?: string | null;
  erp_warehouse_id?: string | null;
  erp_warehouse_name?: string | null;
  erp_nomenclature_id?: string | null;
  erp_nomenclature_name?: string | null;
  erp_characteristic_id?: string | null;
  erp_characteristic_name?: string | null;
  qty?: number | string | null;
  posted_at?: string | null;
  error?: string | null;
};

void Prisma;
