import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EntryStatus, PassportStatus, Prisma } from '@prisma/client';
import type {
  ProductionDocumentDto,
  ProductionDocumentFactKind,
  ProductionDocumentLineDto,
  ProductionDocumentListDto,
  ProductionDocumentListItemDto,
  ProductionDocumentPendingReasonDto,
  ProductionDocumentStatus,
} from '@sewing/shared/production-documents';

import {
  ProductionDocumentNothingReleasedException,
  ProductionDocumentOrderNotClosedException,
} from '../../common/errors.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OrderFactCostService } from '../costs/order-fact-cost.service.js';
import { ProductionDocumentNumberService } from './production-document-number.service.js';

const FORMING: ProductionDocumentStatus = 'FORMING';
const READY: ProductionDocumentStatus = 'READY';

const num = (v: Prisma.Decimal | number | null | undefined): number =>
  v == null ? 0 : Number(v);
const money = (v: number): Prisma.Decimal =>
  new Prisma.Decimal(v.toFixed(2));

/** Заготовка строки выпуска до записи: ключ группировки → количества и основания. */
type LineDraft = {
  orderVariantId: string | null;
  color: string | null;
  sizeId: string;
  qtyGood: number;
  qtyCut: number;
  qtyDefect: number;
  isSample: boolean;
  passportNumbers: string[];
};

/**
 * ДОКУМЕНТ ВЫПУСКА ПО ЗАКАЗУ: рождается закрытием заказа и дособирается сам.
 *
 * ⛔ Никакого «провести»: человек документ не заводит и не подтверждает. Он появляется в той же
 * транзакции, что и `Order.status = DONE` (ручное закрытие и авто-закрытие при полной упаковке —
 * обе точки зовут `createOnOrderClose`), и переходит в `READY`, когда лёг ПОСЛЕДНИЙ ФАКТ:
 * закрыты все коробки заказа и подтверждены начисления по его паспортам.
 *
 * ⛔ ПОЧЕМУ ДВА МОМЕНТА, А НЕ ОДИН. Физика замерзает раньше денег: после `PACKED` количество
 * паспорта не правится (`QTY_CORRECTION_PASSPORT_NOT_EDITABLE`), а сдельная становится
 * `APPROVED` только на закрытии коробки — то есть ПОЗЖЕ авто-закрытия заказа, которое случается
 * при добавлении последнего паспорта в коробку. Снимок себестоимости в транзакции закрытия
 * недосчитал бы всю последнюю коробку.
 *
 * ⛔ ПОЗДНИЙ ФАКТ (списание задним числом, правка начисления) документ ПЕРЕСОБИРАЕТ и помечает
 * `recalculatedAt`/`recalcReason`. Учёт обязан сходиться с цехом, а не с моментом фиксации;
 * ERP видит такой документ повторно — она читает по курсору готовности.
 */
@Injectable()
export class ProductionDocumentsService {
  private readonly logger = new Logger(ProductionDocumentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly numbers: ProductionDocumentNumberService,
    private readonly cost: OrderFactCostService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // РОЖДЕНИЕ — в транзакции закрытия заказа
  // ---------------------------------------------------------------------------

  /**
   * Завести документ выпуска по закрытому заказу. Зовётся ВНУТРИ транзакции закрытия, чтобы
   * документ и статус заказа появлялись атомарно: заказ не может быть закрыт без документа.
   *
   * Идемпотентно: повторный вызов (ретрай, гонка ручного и авто-закрытия) документ не задваивает —
   * сначала проверка, а поверх неё `orderId @unique` в БД.
   *
   * Себестоимость здесь НЕ считается: на этот момент деньги ещё не окончательны, а лишний
   * тяжёлый расчёт в транзакции закрытия удлинял бы блокировку. Её положит `refresh`.
   */
  async createOnOrderClose(
    tx: Prisma.TransactionClient,
    orderId: string,
    closedAt: Date,
    actorEmployeeId?: string | null,
  ): Promise<string | null> {
    const existing = await tx.productionDocument.findUnique({
      where: { orderId },
      select: { id: true },
    });
    if (existing) return existing.id;

    const [passports, items] = await Promise.all([
      tx.passport.findMany({
        where: { orderId, status: PassportStatus.PACKED },
        select: {
          number: true,
          orderVariantId: true,
          color: true,
          sizeId: true,
          qtyGood: true,
          qtyCut: true,
          qtyDefect: true,
          sampleId: true,
        },
        orderBy: { number: 'asc' },
      }),
      tx.orderItem.aggregate({ where: { orderId }, _sum: { qtyPlan: true } }),
    ]);

    const lines = this.groupLines(passports);
    const number = await this.numbers.nextNumber(tx, closedAt);
    const doc = await tx.productionDocument.create({
      data: {
        number,
        orderId,
        status: FORMING,
        closedAt,
        qtyPlan: items._sum.qtyPlan ?? 0,
        qtyGood: lines.reduce((s, l) => s + l.qtyGood, 0),
        qtyCut: lines.reduce((s, l) => s + l.qtyCut, 0),
        qtyDefect: lines.reduce((s, l) => s + l.qtyDefect, 0),
        costWarnings: [],
        lines: { create: lines },
      },
      select: { id: true, number: true },
    });

    await this.audit.log(
      {
        event: 'PRODUCTION_DOCUMENT_CREATED',
        entityType: 'PRODUCTION_DOCUMENT',
        entityId: doc.id,
        employeeId: actorEmployeeId ?? null,
        payload: { orderId, number: doc.number, lines: lines.length },
      },
      tx,
    );
    this.logger.log(
      `event=production_document.created orderId=${orderId} number=${doc.number} lines=${lines.length}`,
    );
    return doc.id;
  }

  /** Паспорта → строки «расцветка + размер»: два паспорта одного размера дают ОДНУ строку. */
  private groupLines(
    passports: Array<{
      number: string;
      orderVariantId: string | null;
      color: string | null;
      sizeId: string;
      qtyGood: number;
      qtyCut: number;
      qtyDefect: number;
      sampleId: string | null;
    }>,
  ): LineDraft[] {
    const byKey = new Map<string, LineDraft>();
    for (const p of passports) {
      const key = `${p.orderVariantId ?? ''}|${p.color ?? ''}|${p.sizeId}|${p.sampleId ? 'S' : 'T'}`;
      const line = byKey.get(key) ?? {
        orderVariantId: p.orderVariantId,
        color: p.color,
        sizeId: p.sizeId,
        qtyGood: 0,
        qtyCut: 0,
        qtyDefect: 0,
        isSample: !!p.sampleId,
        passportNumbers: [],
      };
      line.qtyGood += p.qtyGood ?? 0;
      line.qtyCut += p.qtyCut ?? 0;
      line.qtyDefect += p.qtyDefect ?? 0;
      line.passportNumbers.push(p.number);
      byKey.set(key, line);
    }
    return [...byKey.values()];
  }

  /**
   * ПОДТЯНУТЬ документ по кнопке: собрать, если его нет, и пересобрать, если есть.
   *
   * Два случая, для человека — одно действие «покажи правду сейчас»:
   *   • документа нет — заказ закрывали до появления раздела, рождаться было нечему;
   *   • документ есть — пересобираем состав и себестоимость, не дожидаясь события
   *     (закрытие коробки, чтение изменившегося документа).
   *
   * ⛔ Это НЕ проведение: провести или подтвердить выпуск нельзя, таких переходов у документа
   * нет. Кнопка лишь заставляет перечитать факты цеха. Придумать выпуск ею тоже нельзя — все
   * входы исторические (упакованные паспорта, списания, начисления, подкрой, события паспортов
   * для разноски оклада), поэтому документ ВОССТАНАВЛИВАЕТСЯ, а не сочиняется.
   *
   * ⛔ Номер берёт дату ЗАКРЫТИЯ заказа, а не сегодняшнюю: иначе прошлогодняя сдача встала бы в
   * сегодняшний суточный счётчик, и порядок номеров разошёлся бы с порядком выпуска.
   *
   * ⛔ Отмечаем `backfilledAt`: строка появилась позже события, которое описывает. Без отметки
   * достроенный документ неотличим от оформленного задним числом.
   *
   * Идемпотентно: у заказа уже есть документ — возвращаем его, второй не заводим.
   */
  async backfillForClosedOrder(
    orderId: string,
    actorEmployeeId?: string | null,
  ): Promise<ProductionDocumentDto> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, status: true, completedAt: true },
    });
    if (!order) {
      throw new NotFoundException({
        code: 'ORDER_NOT_FOUND',
        message: 'Заказ не найден',
      });
    }
    const existing = await this.prisma.productionDocument.findUnique({
      where: { orderId },
      select: { id: true },
    });
    if (!existing) {
      // Отменённый заказ сюда не проходит: приходовать выпуск отменённого тиража нельзя.
      if (order.status !== 'DONE') {
        throw new ProductionDocumentOrderNotClosedException();
      }
      const packed = await this.prisma.passport.count({
        where: { orderId, status: PassportStatus.PACKED, qtyGood: { gt: 0 } },
      });
      if (packed === 0) throw new ProductionDocumentNothingReleasedException();

      const closedAt = order.completedAt ?? new Date();
      await this.prisma.$transaction(async (tx) => {
        const id = await this.createOnOrderClose(tx, orderId, closedAt, actorEmployeeId);
        if (id) {
          await tx.productionDocument.update({
            where: { id },
            data: { backfilledAt: new Date() },
          });
          await this.audit.log(
            {
              event: 'PRODUCTION_DOCUMENT_BACKFILLED',
              entityType: 'PRODUCTION_DOCUMENT',
              entityId: id,
              employeeId: actorEmployeeId ?? null,
              payload: { orderId, closedAt: closedAt.toISOString() },
            },
            tx,
          );
        }
      });
    }
    // Пересборка — всегда, а не только при создании: ради неё кнопку и жмут на существующем
    // документе. Считает её общий движок, второго расчёта тех же денег не заводим.
    await this.refresh(orderId, 'ORDER_CLOSED');
    if (existing) {
      // Ручная синхронизация существующего документа — след в журнале: у учётного документа
      // «почему цифры вдруг другие» обязано иметь ответ, и «человек нажал обновить» — ответ.
      await this.audit.log({
        event: 'PRODUCTION_DOCUMENT_SYNCED',
        entityType: 'PRODUCTION_DOCUMENT',
        entityId: existing.id,
        employeeId: actorEmployeeId ?? null,
        payload: { orderId, manual: true },
      });
    }
    const dto = await this.forOrder(orderId);
    if (!dto) {
      throw new NotFoundException({
        code: 'PRODUCTION_DOCUMENT_NOT_FOUND',
        message: 'Документ выпуска не найден',
      });
    }
    return dto;
  }

  // ---------------------------------------------------------------------------
  // ПЕРЕСБОРКА — «исходя из реалий производства»
  // ---------------------------------------------------------------------------

  /**
   * Пересобрать документ по фактам: строки, количества, себестоимость, состояние.
   *
   * Зовётся событиями цеха (закрытие коробки) и лениво при чтении документа, который ещё
   * формируется. Тихо выходит, если документа нет: заказы, закрытые до появления фичи, задним
   * числом не восстанавливаются — «реконструированный» выпуск был бы выдумкой.
   */
  async refresh(orderId: string, factKind?: ProductionDocumentFactKind): Promise<void> {
    const doc = await this.prisma.productionDocument.findUnique({
      where: { orderId },
      select: {
        id: true,
        status: true,
        totalRub: true,
        qtyGood: true,
        readyAt: true,
      },
    });
    if (!doc) return;

    const [passports, items, pending] = await Promise.all([
      this.prisma.passport.findMany({
        where: { orderId, status: PassportStatus.PACKED },
        select: {
          number: true,
          orderVariantId: true,
          color: true,
          sizeId: true,
          qtyGood: true,
          qtyCut: true,
          qtyDefect: true,
          sampleId: true,
        },
        orderBy: { number: 'asc' },
      }),
      this.prisma.orderItem.aggregate({ where: { orderId }, _sum: { qtyPlan: true } }),
      this.pendingReasons(orderId),
    ]);

    const lines = this.groupLines(passports);
    const qtyGood = lines.reduce((s, l) => s + l.qtyGood, 0);
    const [cost, signature] = await Promise.all([
      this.cost.factCostForOrder(orderId, qtyGood),
      this.factSignature(orderId),
    ]);

    const isReady = pending.length === 0;
    const totalChanged = Math.abs(num(doc.totalRub) - cost.total_rub) >= 0.01;
    const qtyChanged = doc.qtyGood !== qtyGood;
    const wasReady = doc.status === READY;
    const now = new Date();

    // Поздний факт по уже сформированному документу — не тихая правка: помечаем, чем и когда.
    const recalculated = wasReady && (totalChanged || qtyChanged);

    await this.prisma.$transaction(async (tx) => {
      await tx.productionDocumentLine.deleteMany({
        where: { productionDocumentId: doc.id },
      });
      await tx.productionDocument.update({
        where: { id: doc.id },
        data: {
          status: isReady ? READY : FORMING,
          readyAt: isReady ? (doc.readyAt ?? now) : null,
          lastFactAt: isReady ? (doc.readyAt ?? now) : null,
          lastFactKind: isReady ? (factKind ?? 'EARNINGS_APPROVED') : null,
          recalculatedAt: recalculated ? now : undefined,
          recalcReason: recalculated
            ? qtyChanged
              ? 'Изменился выпуск по паспортам'
              : 'Факт расхода или начислений пришёл после фиксации'
            : undefined,
          qtyPlan: items._sum.qtyPlan ?? 0,
          qtyGood,
          qtyCut: lines.reduce((s, l) => s + l.qtyCut, 0),
          qtyDefect: lines.reduce((s, l) => s + l.qtyDefect, 0),
          materialsOwnRub: money(cost.materials_own_rub),
          materialsErpRub: money(cost.materials_erp_rub),
          pieceworkRub: money(cost.piecework_rub),
          pieceworkPendingRub: money(cost.piecework_pending_rub),
          recutRub: money(cost.recut_rub),
          salaryRub: money(cost.salary_rub),
          otherRub: money(cost.other_rub),
          totalRub: money(cost.total_rub),
          perUnitRub: money(cost.per_unit_rub),
          planTotalRub: cost.plan_total_rub == null ? null : money(cost.plan_total_rub),
          planPerUnitRub:
            cost.plan_per_unit_rub == null ? null : money(cost.plan_per_unit_rub),
          costWarnings: cost.warnings,
          factSignature: signature,
          lines: { create: lines },
        },
      });

      if (isReady && !wasReady) {
        await this.audit.log(
          {
            event: 'PRODUCTION_DOCUMENT_READY',
            entityType: 'PRODUCTION_DOCUMENT',
            entityId: doc.id,
            payload: { orderId, totalRub: cost.total_rub, qtyGood },
          },
          tx,
        );
      }
      if (recalculated) {
        await this.audit.log(
          {
            event: 'PRODUCTION_DOCUMENT_RECALCULATED',
            entityType: 'PRODUCTION_DOCUMENT',
            entityId: doc.id,
            payload: {
              orderId,
              wasTotalRub: num(doc.totalRub),
              totalRub: cost.total_rub,
              wasQtyGood: doc.qtyGood,
              qtyGood,
            },
          },
          tx,
        );
      }
    });
  }

  /**
   * Отпечаток фактов заказа — дешёвые агрегаты, по которым видно, изменилось ли что-нибудь.
   *
   * ⛔ Полный пересчёт тянет разноску оклада по окну производства — это дорого, и делать его на
   * каждое открытие карточки нельзя. Отпечаток стоит копейки и отвечает на единственный нужный
   * вопрос: «факты те же?». Совпал — показываем снимок, разошёлся — пересобираем.
   */
  private async factSignature(orderId: string): Promise<string> {
    const [issues, returns, approved, pending, recut, extras, packed, events] =
      await Promise.all([
        this.prisma.materialIssue.aggregate({
          where: { orderId, status: 'POSTED' },
          _sum: { totalCost: true },
        }),
        this.prisma.materialIssueReturn.aggregate({
          where: { orderId, status: 'POSTED' },
          _sum: { totalCost: true },
        }),
        this.prisma.operationEntry.aggregate({
          where: { passport: { orderId }, status: EntryStatus.APPROVED },
          _sum: { amount: true },
        }),
        this.prisma.operationEntry.aggregate({
          where: {
            passport: { orderId },
            status: { in: [EntryStatus.PENDING_RELEASE, EntryStatus.PENDING] },
          },
          _sum: { amount: true },
        }),
        this.prisma.recutSession.aggregate({
          where: { orderId, status: 'DONE' },
          _sum: { amount: true },
        }),
        this.prisma.orderExtraCost.aggregate({
          where: { orderId, includeInCostPrice: true },
          _sum: { amount: true },
        }),
        this.prisma.passport.aggregate({
          where: { orderId, status: PassportStatus.PACKED },
          _sum: { qtyGood: true },
          _count: true,
        }),
        // Оклад разносится по событиям паспортов: их количество ловит поздние правки смен.
        this.prisma.passportEvent.count({ where: { passport: { orderId } } }),
      ]);
    return [
      num(issues._sum.totalCost),
      num(returns._sum.totalCost),
      num(approved._sum.amount),
      num(pending._sum.amount),
      num(recut._sum.amount),
      num(extras._sum.amount),
      packed._sum.qtyGood ?? 0,
      packed._count,
      events,
    ].join('|');
  }

  /**
   * Пересобрать, если факты изменились. Формирующийся документ пересобираем всегда: он для того
   * и формируется.
   */
  private async refreshIfStale(
    orderId: string,
    status: string,
    storedSignature: string | null,
  ): Promise<void> {
    if (status === FORMING) {
      await this.refresh(orderId);
      return;
    }
    const signature = await this.factSignature(orderId);
    if (signature !== storedSignature) await this.refresh(orderId);
  }

  /**
   * Чего документ ещё ждёт. Пусто — значит все факты легли.
   *
   * Два источника, оба про деньги: незакрытая коробка (сдельная по ней ещё не подтверждена) и
   * начисления в ожидании. Материал сюда не входит намеренно: списание может прийти когда
   * угодно, и держать документ незакрытым из-за него значило бы не закрывать его никогда.
   */
  private async pendingReasons(
    orderId: string,
  ): Promise<ProductionDocumentPendingReasonDto[]> {
    const [openBoxes, pendingEarnings] = await Promise.all([
      this.prisma.box.findMany({
        where: { closedAt: null, items: { some: { passport: { orderId } } } },
        select: { number: true, totalQty: true },
      }),
      this.prisma.operationEntry.aggregate({
        where: {
          passport: { orderId },
          status: { in: [EntryStatus.PENDING_RELEASE, EntryStatus.PENDING] },
        },
        _sum: { amount: true },
      }),
    ]);

    const reasons: ProductionDocumentPendingReasonDto[] = [];
    if (openBoxes.length > 0) {
      reasons.push({
        code: 'OPEN_BOX',
        text:
          openBoxes.length === 1
            ? 'Открыта коробка — упаковщик ещё не закрыл её'
            : `Открыты коробки (${openBoxes.length}) — упаковщик ещё не закрыл их`,
        detail: openBoxes
          .map((b) => `${b.number} · ${b.totalQty} шт`)
          .join(', '),
      });
    }
    const pendingRub = num(pendingEarnings._sum.amount);
    if (pendingRub > 0) {
      reasons.push({
        code: 'PENDING_EARNINGS',
        text: 'Начисления ждут подтверждения — сдельная пока не в сумме',
        detail: `${pendingRub.toFixed(2)} ₽`,
      });
    }
    return reasons;
  }

  // ---------------------------------------------------------------------------
  // ЧТЕНИЕ
  // ---------------------------------------------------------------------------

  async list(query: {
    status?: string;
    search?: string;
    page?: number;
    pageSize?: number;
  }): Promise<ProductionDocumentListDto> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 25));
    const status =
      query.status === FORMING || query.status === READY ? query.status : undefined;
    const search = query.search?.trim();

    const where: Prisma.ProductionDocumentWhereInput = {
      ...(status ? { status } : {}),
      ...(search
        ? {
            OR: [
              { number: { contains: search, mode: 'insensitive' as const } },
              { order: { number: { contains: search, mode: 'insensitive' as const } } },
              { order: { customer: { contains: search, mode: 'insensitive' as const } } },
            ],
          }
        : {}),
    };

    // Документы, которые ещё формируются, дособираем перед показом — иначе список показывал бы
    // вчерашнее состояние цеха. Ограничение бережёт страницу от каскада тяжёлых пересчётов.
    const stale = await this.prisma.productionDocument.findMany({
      where: { ...where, status: FORMING },
      select: { orderId: true },
      orderBy: { closedAt: 'desc' },
      take: 10,
    });
    for (const s of stale) await this.refresh(s.orderId);

    const [rows, total, formingCount] = await Promise.all([
      this.prisma.productionDocument.findMany({
        where,
        orderBy: [{ closedAt: 'desc' }, { number: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: this.listSelect(),
      }),
      this.prisma.productionDocument.count({ where }),
      this.prisma.productionDocument.count({ where: { status: FORMING } }),
    ]);

    return {
      items: rows.map((r) => this.toListItem(r)),
      total,
      page,
      pageSize,
      formingCount,
    };
  }

  async getOne(id: string): Promise<ProductionDocumentDto> {
    const found = await this.prisma.productionDocument.findUnique({
      where: { id },
      select: { orderId: true, status: true, factSignature: true },
    });
    if (!found) {
      throw new NotFoundException({
        code: 'PRODUCTION_DOCUMENT_NOT_FOUND',
        message: 'Документ выпуска не найден',
      });
    }
    await this.refreshIfStale(found.orderId, found.status, found.factSignature);
    return this.buildDto(found.orderId);
  }

  /** Документ заказа — для блока в карточке заказа. `null`, если заказ ещё не закрыт. */
  async forOrder(orderId: string): Promise<ProductionDocumentDto | null> {
    const found = await this.prisma.productionDocument.findUnique({
      where: { orderId },
      select: { status: true, factSignature: true },
    });
    if (!found) return null;
    await this.refreshIfStale(orderId, found.status, found.factSignature);
    return this.buildDto(orderId);
  }

  private listSelect() {
    return {
      id: true,
      number: true,
      status: true,
      orderId: true,
      qtyGood: true,
      qtyPlan: true,
      totalRub: true,
      perUnitRub: true,
      closedAt: true,
      readyAt: true,
      lastFactAt: true,
      lastFactKind: true,
      recalculatedAt: true,
      order: {
        select: {
          number: true,
          customer: true,
          patternNameSnapshot: true,
        },
      },
    } satisfies Prisma.ProductionDocumentSelect;
  }

  private toListItem(row: {
    id: string;
    number: string;
    status: string;
    orderId: string;
    qtyGood: number;
    qtyPlan: number;
    totalRub: Prisma.Decimal;
    perUnitRub: Prisma.Decimal;
    closedAt: Date;
    readyAt: Date | null;
    lastFactAt: Date | null;
    lastFactKind: string | null;
    recalculatedAt: Date | null;
    order: { number: string; customer: string | null; patternNameSnapshot: string | null };
  }): ProductionDocumentListItemDto {
    return {
      id: row.id,
      number: row.number,
      status: row.status as ProductionDocumentStatus,
      orderId: row.orderId,
      orderNumber: row.order.number,
      customer: row.order.customer,
      patternName: row.order.patternNameSnapshot,
      qtyGood: row.qtyGood,
      qtyPlan: row.qtyPlan,
      totalRub: num(row.totalRub),
      perUnitRub: num(row.perUnitRub),
      closedAt: row.closedAt.toISOString(),
      readyAt: row.readyAt?.toISOString() ?? null,
      lastFactAt: row.lastFactAt?.toISOString() ?? null,
      lastFactKind: (row.lastFactKind as ProductionDocumentFactKind | null) ?? null,
      recalculatedAt: row.recalculatedAt?.toISOString() ?? null,
    };
  }

  private async buildDto(orderId: string): Promise<ProductionDocumentDto> {
    const row = await this.prisma.productionDocument.findUnique({
      where: { orderId },
      select: {
        ...this.listSelect(),
        qtyCut: true,
        qtyDefect: true,
        materialsOwnRub: true,
        materialsErpRub: true,
        pieceworkRub: true,
        pieceworkPendingRub: true,
        recutRub: true,
        salaryRub: true,
        otherRub: true,
        planTotalRub: true,
        planPerUnitRub: true,
        costWarnings: true,
        recalcReason: true,
        backfilledAt: true,
        order: {
          select: {
            number: true,
            customer: true,
            patternNameSnapshot: true,
            erpCustomerOrderId: true,
            erpCustomerOrderNumber: true,
          },
        },
        lines: {
          select: {
            id: true,
            orderVariantId: true,
            color: true,
            sizeId: true,
            qtyGood: true,
            qtyCut: true,
            qtyDefect: true,
            isSample: true,
            passportNumbers: true,
            size: { select: { code: true, sortOrder: true } },
          },
        },
      },
    });
    if (!row) {
      throw new NotFoundException({
        code: 'PRODUCTION_DOCUMENT_NOT_FOUND',
        message: 'Документ выпуска не найден',
      });
    }

    const lines: ProductionDocumentLineDto[] = row.lines
      .slice()
      .sort(
        (a, b) =>
          (a.color ?? '').localeCompare(b.color ?? '') ||
          (a.size?.sortOrder ?? 0) - (b.size?.sortOrder ?? 0),
      )
      .map((l) => ({
        id: l.id,
        orderVariantId: l.orderVariantId,
        color: l.color,
        sizeId: l.sizeId,
        sizeCode: l.size?.code ?? null,
        qtyGood: l.qtyGood,
        qtyCut: l.qtyCut,
        qtyDefect: l.qtyDefect,
        isSample: l.isSample,
        passportNumbers: l.passportNumbers,
      }));

    const base = this.toListItem(row as never);
    return {
      ...base,
      erpCustomerOrderId: row.order.erpCustomerOrderId,
      erpCustomerOrderNumber: row.order.erpCustomerOrderNumber,
      qtyCut: row.qtyCut,
      qtyDefect: row.qtyDefect,
      recalcReason: row.recalcReason,
      backfilledAt: row.backfilledAt?.toISOString() ?? null,
      cost: {
        materialsOwnRub: num(row.materialsOwnRub),
        materialsErpRub: num(row.materialsErpRub),
        pieceworkRub: num(row.pieceworkRub),
        pieceworkPendingRub: num(row.pieceworkPendingRub),
        recutRub: num(row.recutRub),
        salaryRub: num(row.salaryRub),
        otherRub: num(row.otherRub),
        totalRub: num(row.totalRub),
        perUnitRub: num(row.perUnitRub),
        planTotalRub: row.planTotalRub == null ? null : num(row.planTotalRub),
        planPerUnitRub: row.planPerUnitRub == null ? null : num(row.planPerUnitRub),
        warnings: row.costWarnings,
      },
      lines,
      pendingReasons:
        row.status === FORMING ? await this.pendingReasons(orderId) : [],
    };
  }
}
