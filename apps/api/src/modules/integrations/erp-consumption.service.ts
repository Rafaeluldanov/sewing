import { Injectable, Logger } from '@nestjs/common';
import { PassportStatus, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service.js';
import {
  needDescription,
  resolvePassportNeedShares,
} from '../material-issues/passport-need-share.js';

/**
 * ОЧЕРЕДЬ СПИСАНИЯ МАТЕРИАЛА В ERP по факту выпуска цеха (лестница остатков, шаг 5).
 *
 * Материал списывается при выпуске и в ERP — склад один, её (правило владельца §0.3,
 * `service/docs/kb/sewing.md`). Разделение труда: цех считает, СКОЛЬКО ушло по каждой
 * потребности на упакованный паспорт (та же формула, что у его автосписания кроя —
 * `passport-need-share.ts`), ERP списывает КОНКРЕТНЫЙ рулон по цене его партии и присылает
 * результат обратно (`ack`) — он и есть факт материала в себестоимости цеха.
 *
 * Почему опрос со стороны ERP, а не вызов из упаковки:
 *   • упаковка паспорта — горячий путь терминала внутри одной транзакции; HTTP-вызов в ней
 *     добавил бы к каждой упаковке время ответа соседа, а недоступность ERP останавливала бы
 *     упаковку. Та же грабля уже стоила нам 11 секунд на завершении операции 03.09.2026;
 *   • очередь самовосстанавливается: пока ERP не ответила, паспорт просто остаётся в очереди.
 *     Потерянного вызова, о котором никто не знает, здесь возникнуть не может.
 *
 * Очередь без своего флага: «ещё не списано» = у упакованного паспорта нет строки
 * `ErpMaterialConsumption`. Флаг рядом с фактом разъехался бы с ним на первом же сбое.
 */
@Injectable()
export class ErpConsumptionService {
  private readonly logger = new Logger(ErpConsumptionService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Сколько паспортов отдаём за один опрос (у ERP на каждый — своя транзакция списания). */
  private static readonly DEFAULT_LIMIT = 50;
  private static readonly MAX_LIMIT = 200;

  /**
   * Состояния, которые ERP может прислать в `ack`.
   *
   * `FAILED` — тоже ответ: ERP не смогла списать (нет сопоставленной номенклатуры, закрыт
   * период) и разбирается с этим у себя. Без такого ответа паспорт остался бы в очереди и
   * держал бы за собой все следующие: очередь отдаёт старейшие первыми.
   */
  private static readonly STATES = new Set(['POSTED', 'REVERSED', 'EMPTY', 'FAILED']);

  /**
   * Что ERP осталось списать: упакованные паспорта без факта списания, старейшие первыми.
   *
   * Порядок — по времени упаковки (событие `PACKED`), чтобы очередь разбиралась в том же
   * порядке, в котором цех выпускал: при нехватке партий списание старейшего должно уйти
   * в старейший рулон, а не в тот, который попался.
   */
  async listPending(limit?: number): Promise<{
    count: number;
    items: Array<Record<string, unknown>>;
  }> {
    const take = Math.min(
      Math.max(1, limit ?? ErpConsumptionService.DEFAULT_LIMIT),
      ErpConsumptionService.MAX_LIMIT,
    );
    // Очередь — сами события упаковки: у паспорта их может быть несколько (перепаковка),
    // берём по одному на паспорт. Фильтр `erpConsumption is null` — «ERP ещё не ответила»;
    // фильтр по потребностям заказа отсекает заказы, где под ERP не заведено ничего, —
    // иначе они висели бы в очереди вечно, требуя пустого ответа на каждый опрос.
    const events = await this.prisma.passportEvent.findMany({
      where: {
        type: 'PACKED',
        passport: {
          status: PassportStatus.PACKED,
          erpConsumption: { is: null },
          order: {
            workshopNeeds: {
              some: {
                erpManagedAt: { not: null },
                erpNomenclatureId: { not: null },
                status: { not: 'CANCELLED' },
              },
            },
          },
        },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      distinct: ['passportId'],
      take,
      select: {
        createdAt: true,
        passportId: true,
        passport: {
          select: {
            id: true,
            number: true,
            orderId: true,
            qtyCut: true,
            qtyGood: true,
            erpSeriesId: true,
            erpRollLabel: true,
            order: { select: { id: true, number: true } },
          },
        },
      },
    });

    const items: Array<Record<string, unknown>> = [];
    for (const event of events) {
      const passport = event.passport;
      if (!passport) continue;
      const shares = await resolvePassportNeedShares(
        this.prisma,
        passport.id,
        this.logger,
      );
      // Паспорт без долей (нет потребностей активного варианта / всё в ноль) отдаём с пустыми
      // строками, а не прячем: ERP ответит «списывать нечего», и паспорт покинет очередь.
      const lines = !shares.ok
        ? []
        : shares.shares
            // Потребность должна была стать «под ERP» ДО упаковки. Иначе на заказе, часть
            // которого уже выпущена своей тканью, первая же закупка через ERP отправила бы в
            // списание все старые паспорта — материал, взятый со склада цеха ещё до перевода
            // склада в ERP, списался бы вторично. Строк не осталось — ответим «нечего списывать».
            .filter(
              (s) =>
                s.need.erpManagedAt &&
                s.need.erpNomenclatureId &&
                s.need.erpManagedAt <= event.createdAt,
            )
            .map((s) => ({
              workshop_need_id: s.need.id,
              description: needDescription(s.need),
              unit: s.need.unit,
              qty: s.qty.toString(),
              erp_nomenclature_id: s.need.erpNomenclatureId,
              erp_characteristic_id: s.need.erpCharacteristicId,
              erp_unit_id: s.need.erpUnitId,
              erp_unit_price_rub:
                s.need.erpUnitPriceRub != null ? s.need.erpUnitPriceRub.toString() : null,
            }));
      items.push({
        passport_id: passport.id,
        passport_number: passport.number,
        order_id: passport.orderId,
        order_number: passport.order?.number ?? null,
        packed_at: event.createdAt,
        qty_cut: passport.qtyCut,
        qty_good: passport.qtyGood,
        // Рулон ERP, с которого кроили этот паспорт (копия с настила, шаг 4).
        erp_series_id: passport.erpSeriesId,
        erp_roll_label: passport.erpRollLabel,
        skip_reason: shares.ok ? null : shares.reason,
        lines,
      });
    }
    return { count: items.length, items };
  }

  /**
   * Принять результат списания из ERP: факт по паспорту + разбивка по потребностям.
   *
   * Замена, а не слияние: повторный ответ по паспорту (сторно, повторное списание) заменяет
   * строки целиком — иначе после сторно рядом лежали бы старая и новая правда о расходе.
   * Неизвестный паспорт не роняет пакет: он мог быть удалён, пока ERP списывала.
   */
  async ack(items: AckItem[]): Promise<{
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
      if (!ErpConsumptionService.STATES.has(state)) {
        skipped.push({ passport_id: passportId, reason: 'unknown_state' });
        continue;
      }
      const passport = await this.prisma.passport.findUnique({
        where: { id: passportId },
        select: { id: true, orderId: true },
      });
      if (!passport) {
        skipped.push({ passport_id: passportId, reason: 'passport_not_found' });
        continue;
      }
      const lines = (Array.isArray(item.lines) ? item.lines : []).map((l) => ({
        workshopNeedId: l.workshop_need_id ?? null,
        description: String(l.description ?? 'Материал'),
        unit: l.unit ?? null,
        qty: new Prisma.Decimal(l.qty ?? 0),
        amountRub: new Prisma.Decimal(l.amount_rub ?? 0),
        erpSeriesId: l.erp_series_id ?? null,
        rollLabel: l.roll_label ?? null,
        uncoveredQty: l.uncovered_qty == null ? null : new Prisma.Decimal(l.uncovered_qty),
      }));
      const header = {
        orderId: passport.orderId,
        state,
        erpDocumentId: item.erp_document_id ?? null,
        erpDocumentRef: item.erp_document_ref ?? null,
        writtenOffAt: item.written_off_at ? new Date(item.written_off_at) : null,
        amountRub: item.amount_rub == null ? null : new Prisma.Decimal(item.amount_rub),
        uncoveredQty:
          item.uncovered_qty == null ? null : new Prisma.Decimal(item.uncovered_qty),
        syncedAt: new Date(),
      };
      await this.prisma.$transaction(async (tx) => {
        const existing = await tx.erpMaterialConsumption.findUnique({
          where: { passportId },
          select: { id: true },
        });
        if (existing) {
          await tx.erpMaterialConsumptionLine.deleteMany({
            where: { consumptionId: existing.id },
          });
          await tx.erpMaterialConsumption.update({
            where: { id: existing.id },
            data: { ...header, lines: { create: lines } },
          });
          return;
        }
        await tx.erpMaterialConsumption.create({
          data: { passportId, ...header, lines: { create: lines } },
        });
      });
      accepted += 1;
      this.logger.log(
        `event=erp_consumption.ack passportId=${passportId} state=${state} ` +
          `lines=${lines.length} amountRub=${header.amountRub?.toString() ?? '-'} ` +
          `doc=${header.erpDocumentRef ?? '-'}`,
      );
    }
    return { accepted, skipped };
  }
}

/** Ответ ERP по одному паспорту — контракт в её терминах (переименовывать нельзя). */
export type AckItem = {
  passport_id: string;
  /** `POSTED` — списано, `REVERSED` — списание сторнировано, `EMPTY` — списывать было нечего. */
  state?: string;
  erp_document_id?: string | null;
  erp_document_ref?: string | null;
  written_off_at?: string | null;
  amount_rub?: string | number | null;
  uncovered_qty?: string | number | null;
  lines?: Array<{
    workshop_need_id?: string | null;
    description?: string | null;
    unit?: string | null;
    qty?: string | number | null;
    amount_rub?: string | number | null;
    erp_series_id?: string | null;
    roll_label?: string | null;
    uncovered_qty?: string | number | null;
  }>;
};
