import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  OperationCategory,
  PassportEventType,
  PassportStatus,
  type Role as PrismaRole,
} from '@prisma/client';
import type {
  OrderStandBoxDto,
  OrderStandCellDto,
  OrderStandDto,
  OrderStandPassportDto,
  OrderStandPlace,
  OrderStandStepDto,
  OrderStandWorkplaceDto,
} from '@sewing/shared/order-stand';
import type { ShopfloorStage } from '@sewing/shared/shopfloor';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CutReadinessService } from '../cut-readiness/cut-readiness.service.js';
import { bucketOf, type ProjectionPassport } from './shopfloor-projection.js';

/**
 * «Схема стенда» по заказу — read-only проекция `GET /api/orders/:id/stand`
 * (контракт — `@sewing/shared/order-stand`, UI — `/admin/orders/[id]/stand`).
 *
 * Собирает одним проходом: шаги маршрута заказа с рабочим местом под
 * каждую операцию и счётчиками, паспорта с текущим положением
 * (ячейка / исполнитель / буфер / коробка), ячейки и коробки. Стадию
 * паспорта считает та же `bucketOf`, что и монитор цеха, — чтобы
 * «сшито 12» на схеме и на `/shopfloor/display` не расходились.
 *
 * Свежесть `QC_PASSED` / `WTO_PASSED` / `OPERATION_FINISHED` считается
 * так же, как в `ShopfloorService.getState` (там же описано, зачем),
 * но по паспортам одного заказа — набор маленький, отдельный узкий
 * запрос дешевле, чем тащить весь цех.
 */
@Injectable()
export class OrderStandService {
  private readonly logger = new Logger(OrderStandService.name);

  private static readonly CATEGORY_TO_ROLE: Record<OperationCategory, PrismaRole> = {
    CUTTING: 'CUTTER',
    SEWING: 'SEAMSTRESS',
    QC: 'QC',
    IRONING: 'IRONING',
    PACKING: 'PACKING',
  };

  private static readonly CATEGORY_ACTOR: Record<OperationCategory, string> = {
    CUTTING: 'раскройщик',
    SEWING: 'швея',
    QC: 'контролёр ОТК',
    IRONING: 'ВТО',
    PACKING: 'упаковщик',
  };

  private static readonly DONE_STAGES: ReadonlySet<ShopfloorStage> = new Set([
    'SEWING_DONE',
    'QC_DONE',
    'WTO_DONE',
  ]);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cutReadiness: CutReadinessService,
  ) {}

  async getForOrder(orderId: string): Promise<OrderStandDto> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        number: true,
        status: true,
        orderDate: true,
        dueDate: true,
        createdAt: true,
        inProductionAt: true,
        completedAt: true,
        patternNameSnapshot: true,
        costEstimateTotalRub: true,
        costEstimateCompletedAt: true,
        client: { select: { name: true } },
        patternItem: { select: { name: true } },
        routeTemplate: { select: { code: true, name: true } },
        variants: { select: { color: true }, orderBy: { ordinal: 'asc' } },
        items: {
          select: {
            qtyPlan: true,
            size: { select: { id: true, code: true, sortOrder: true } },
          },
        },
        routeSteps: {
          orderBy: { index: 'asc' },
          select: {
            index: true,
            operationId: true,
            parallelGroup: true,
            outsourced: true,
            operation: {
              select: { id: true, code: true, name: true, category: true },
            },
          },
        },
        cuttingTask: { select: { status: true } },
      },
    });
    if (!order) {
      throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Заказ не найден' });
    }

    const [passports, equipment, cells] = await Promise.all([
      this.prisma.passport.findMany({
        where: { orderId: order.id },
        orderBy: [{ size: { sortOrder: 'asc' } }, { number: 'asc' }],
        select: {
          id: true,
          number: true,
          qrCode: true,
          sizeId: true,
          color: true,
          qtyCut: true,
          qtyGood: true,
          qtyDefect: true,
          rollNumber: true,
          status: true,
          currentEmployeeId: true,
          currentRouteStepIndex: true,
          updatedAt: true,
          size: { select: { code: true, sortOrder: true } },
          currentOperation: { select: { id: true, name: true, category: true } },
          currentEmployee: { select: { id: true, fullName: true } },
          currentCell: { select: { id: true, code: true } },
          boxItems: {
            select: {
              box: {
                select: {
                  id: true,
                  number: true,
                  qrCode: true,
                  totalQty: true,
                  closedAt: true,
                },
              },
            },
          },
        },
      }),
      this.prisma.equipment.findMany({
        where: { active: true },
        orderBy: [{ displayNumber: 'asc' }, { code: 'asc' }],
        select: {
          id: true,
          code: true,
          name: true,
          role: true,
          displayNumber: true,
          allowedOperations: {
            where: { isActive: true },
            select: { operationId: true, operation: { select: { category: true } } },
          },
        },
      }),
      this.prisma.cell.findMany({
        where: { active: true },
        orderBy: { code: 'asc' },
        select: { id: true, code: true, qrCode: true },
      }),
    ]);

    // --- derived-флаги монитора (см. ShopfloorService.getState) -----------
    const stageById = await this.computeStages(
      passports.map((p) => ({
        id: p.id,
        sizeId: p.sizeId,
        qtyCut: p.qtyCut,
        qtyGood: p.qtyGood,
        qtyDefect: p.qtyDefect,
        status: p.status,
        currentEmployeeId: p.currentEmployeeId,
        currentOperationId: p.currentOperation?.id ?? null,
        currentOperationCategory: p.currentOperation?.category ?? null,
        hasOpenBox: p.boxItems.some((bi) => bi.box.closedAt === null),
      })),
    );

    // --- рабочие места под операции -------------------------------------
    const workplacesFor = (operationId: string, category: OperationCategory) => {
      const wanted = OrderStandService.CATEGORY_TO_ROLE[category];
      const fits = equipment.filter((e) =>
        e.allowedOperations.some((l) => l.operationId === operationId),
      );
      // Станок с ролью участка операции — первым: именно его QR открывает
      // нужный кабинет через «Сменить место».
      fits.sort((a, b) => Number(b.role === wanted) - Number(a.role === wanted));
      return fits.map(toWorkplace);
    };
    const cuttingWorkplaces = (() => {
      const byRole = equipment.filter((e) => e.role === 'CUTTER');
      const byCategory = equipment.filter(
        (e) =>
          e.role !== 'CUTTER' &&
          e.allowedOperations.some((l) => l.operation.category === OperationCategory.CUTTING),
      );
      return [...byRole, ...byCategory].map(toWorkplace);
    })();

    // --- шаги маршрута со счётчиками ------------------------------------
    const steps: OrderStandStepDto[] = order.routeSteps.map((s) => {
      const places = workplacesFor(s.operationId, s.operation.category);
      const inWork: OrderStandStepDto['inWork'] = [];
      let qtyInWork = 0;
      let qtyWaiting = 0;
      let qtyDone = 0;
      let passportsDone = 0;
      for (const p of passports) {
        if (p.status === PassportStatus.CANCELLED) continue;
        const stage = stageById.get(p.id) ?? null;
        const isPackingStep = s.operation.category === OperationCategory.PACKING;
        if (p.status === PassportStatus.PACKED) {
          // упаковка = все шаги пройдены; для шага PACKING считаем годное
          qtyDone += isPackingStep ? p.qtyGood : p.qtyCut;
          passportsDone += 1;
          continue;
        }
        const idx = p.currentRouteStepIndex;
        if (idx === null || idx < s.index) continue;
        if (idx > s.index) {
          qtyDone += p.qtyCut;
          passportsDone += 1;
          continue;
        }
        // idx === s.index — паспорт на этом шаге
        if (p.status === PassportStatus.IN_PROGRESS && p.currentEmployee) {
          inWork.push({ passportNumber: p.number, employeeName: p.currentEmployee.fullName });
          qtyInWork += p.qtyCut;
        } else if (stage && OrderStandService.DONE_STAGES.has(stage)) {
          qtyDone += p.qtyCut;
          passportsDone += 1;
        } else {
          qtyWaiting += p.qtyCut;
        }
      }
      return {
        index: s.index,
        operationId: s.operation.id,
        operationCode: s.operation.code,
        operationName: s.operation.name,
        category: s.operation.category,
        parallelGroup: s.parallelGroup,
        outsourced: s.outsourced,
        workplace: places[0] ?? null,
        otherWorkplaces: places.slice(1).map((w) => w.name),
        inWork,
        qtyInWork,
        qtyWaiting,
        qtyDone,
        passportsDone,
      };
    });

    // --- паспорта ---------------------------------------------------------
    const stepByIndex = new Map(steps.map((s) => [s.index, s]));
    const passportDtos: OrderStandPassportDto[] = passports.map((p) => {
      const stage = stageById.get(p.id) ?? null;
      const openBox = p.boxItems.find((bi) => bi.box.closedAt === null)?.box;
      const anyBox = openBox ?? p.boxItems[0]?.box ?? null;
      const place = this.placeOf(p.status, Boolean(p.currentEmployee), Boolean(p.currentCell), stage);
      return {
        id: p.id,
        number: p.number,
        qrPayload: p.qrCode,
        sizeId: p.sizeId,
        sizeCode: p.size.code,
        sizeSortOrder: p.size.sortOrder,
        color: p.color,
        qtyCut: p.qtyCut,
        qtyGood: p.qtyGood,
        qtyDefect: p.qtyDefect,
        rollNumber: p.rollNumber,
        status: p.status,
        place,
        stage,
        stepIndex: p.currentRouteStepIndex,
        operationName: p.currentOperation?.name ?? null,
        cell: p.currentCell ? { id: p.currentCell.id, code: p.currentCell.code } : null,
        employee: p.currentEmployee
          ? { id: p.currentEmployee.id, fullName: p.currentEmployee.fullName }
          : null,
        box: anyBox
          ? { id: anyBox.id, number: anyBox.number, closedAt: anyBox.closedAt?.toISOString() ?? null }
          : null,
        updatedAt: p.updatedAt.toISOString(),
        nextHint: this.nextHint(place, p.currentRouteStepIndex, stepByIndex, p.currentEmployee?.fullName ?? null, anyBox),
      };
    });

    // --- ячейки и коробки -------------------------------------------------
    const cellDtos: OrderStandCellDto[] = cells.map((c) => {
      const here = passports.filter(
        (p) => p.currentCell?.id === c.id && p.status !== PassportStatus.CANCELLED,
      );
      return {
        id: c.id,
        code: c.code,
        qrPayload: c.qrCode,
        passports: here.length,
        qty: here.reduce((s, p) => s + p.qtyCut, 0),
      };
    });
    const boxMap = new Map<string, OrderStandBoxDto>();
    for (const p of passports) {
      for (const bi of p.boxItems) {
        const b = bi.box;
        const dto = boxMap.get(b.id) ?? {
          id: b.id,
          number: b.number,
          qrPayload: b.qrCode,
          totalQty: b.totalQty,
          closedAt: b.closedAt?.toISOString() ?? null,
          passports: 0,
        };
        dto.passports += 1;
        boxMap.set(b.id, dto);
      }
    }

    // --- размеры и итоги --------------------------------------------------
    const live = passports.filter((p) => p.status !== PassportStatus.CANCELLED);
    const sizes = order.items
      .map((i) => {
        const mine = live.filter((p) => p.sizeId === i.size.id);
        return {
          id: i.size.id,
          code: i.size.code,
          sortOrder: i.size.sortOrder,
          qtyPlan: i.qtyPlan,
          qtyCut: mine.reduce((s, p) => s + p.qtyCut, 0),
          qtyPacked: mine
            .filter((p) => p.status === PassportStatus.PACKED)
            .reduce((s, p) => s + p.qtyGood, 0),
        };
      })
      .sort((a, b) => a.sortOrder - b.sortOrder);
    const totals = {
      qtyPlan: order.items.reduce((s, i) => s + i.qtyPlan, 0),
      qtyCut: live.reduce((s, p) => s + p.qtyCut, 0),
      qtyGood: live.reduce((s, p) => s + p.qtyGood, 0),
      qtyDefect: live.reduce((s, p) => s + p.qtyDefect, 0),
      qtyPacking: live
        .filter((p) => stageById.get(p.id) === 'PACKING')
        .reduce((s, p) => s + p.qtyGood, 0),
      qtyFinished: live
        .filter((p) => stageById.get(p.id) === 'FINISHED')
        .reduce((s, p) => s + p.qtyGood, 0),
    };

    // --- готовность к крою (fail-soft: схема важнее, чем этот блок) ------
    let readiness: OrderStandDto['readiness'] = null;
    try {
      const r = await this.cutReadiness.getForOrder(order.id);
      readiness = {
        status: r.status,
        ready: r.ready,
        blockersCount: r.blockersCount,
        warningsCount: r.warningsCount,
        materials: r.sections.materials.map((m) => ({
          description: m.description,
          unit: m.unit,
          targetQty: m.targetQty,
          receivedQty: m.receivedQty,
          status: m.status,
        })),
      };
    } catch (e) {
      this.logger.warn(
        `event=order-stand.readiness.failed orderId=${order.id} err=${e instanceof Error ? e.message : String(e)}`,
      );
    }

    return {
      order: {
        id: order.id,
        number: order.number,
        status: order.status,
        clientName: order.client?.name ?? null,
        patternName: order.patternNameSnapshot ?? order.patternItem?.name ?? null,
        colors: order.variants.map((v) => v.color),
        qtyPlanTotal: totals.qtyPlan,
        orderDate: order.orderDate.toISOString(),
        dueDate: order.dueDate?.toISOString() ?? null,
        createdAt: order.createdAt.toISOString(),
        inProductionAt: order.inProductionAt?.toISOString() ?? null,
        completedAt: order.completedAt?.toISOString() ?? null,
        routeTemplateCode: order.routeTemplate?.code ?? null,
        routeTemplateName: order.routeTemplate?.name ?? null,
        costEstimateTotalRub: order.costEstimateTotalRub?.toString() ?? null,
        costEstimateCompletedAt: order.costEstimateCompletedAt?.toISOString() ?? null,
      },
      sizes,
      readiness,
      cutting: {
        taskStatus: order.cuttingTask?.status ?? null,
        passports: live.length,
        qtyCut: totals.qtyCut,
        sizesCut: sizes.filter((s) => s.qtyCut > 0).length,
        sizesTotal: sizes.length,
        workplace: cuttingWorkplaces[0] ?? null,
        otherWorkplaces: cuttingWorkplaces.slice(1).map((w) => w.name),
      },
      steps,
      cells: cellDtos,
      passports: passportDtos,
      boxes: [...boxMap.values()].sort((a, b) => a.number.localeCompare(b.number)),
      totals,
      updatedAt: new Date().toISOString(),
    };
  }

  // -------------------------------------------------------------------------

  private placeOf(
    status: PassportStatus,
    hasEmployee: boolean,
    hasCell: boolean,
    stage: ShopfloorStage | null,
  ): OrderStandPlace {
    if (status === PassportStatus.CANCELLED) return 'CANCELLED';
    if (status === PassportStatus.PACKED) return 'PACKED';
    if (status === PassportStatus.IN_PROGRESS) {
      if (hasEmployee) return 'IN_WORK';
      if (stage && OrderStandService.DONE_STAGES.has(stage)) return 'STEP_DONE';
      return hasCell ? 'IN_CELL' : 'WAITING';
    }
    return hasCell ? 'IN_CELL' : 'UNPLACED';
  }

  private nextHint(
    place: OrderStandPlace,
    stepIndex: number | null,
    stepByIndex: ReadonlyMap<number, OrderStandStepDto>,
    employeeName: string | null,
    box: { number: string; closedAt: Date | null } | null,
  ): string {
    const stepAt = (i: number | null) => (i === null ? undefined : stepByIndex.get(i));
    const scanOn = (s: OrderStandStepDto | undefined, verb: string) =>
      s
        ? `${OrderStandService.CATEGORY_ACTOR[s.category]} на «${s.operationName}» — ${verb}`
        : `следующий участок — скан паспорта`;
    switch (place) {
      case 'UNPLACED':
        return 'раскройщик: скан ячейки, скан паспорта — на стеллаж';
      case 'IN_CELL':
      case 'WAITING': {
        const s = stepAt(stepIndex);
        return s && s.category === OperationCategory.SEWING
          ? scanOn(s, '«взять крой»')
          : scanOn(s, 'скан паспорта');
      }
      case 'IN_WORK':
        return `${employeeName ?? 'исполнитель'} закрывает операцию`;
      case 'STEP_DONE': {
        const next = stepAt(stepIndex === null ? null : stepIndex + 1);
        return scanOn(next, 'скан паспорта');
      }
      case 'PACKED':
        return box
          ? box.closedAt
            ? `коробка ${box.number} закрыта`
            : `упаковщик: закрыть коробку ${box.number}`
          : 'в коробке';
      case 'CANCELLED':
        return '';
    }
  }

  /**
   * Стадия монитора для каждого паспорта заказа. Свежесть терминальных
   * событий — как в `ShopfloorService.getState` / `getDisplaySummary`
   * (ADR-0013): `QC_PASSED` / `WTO_PASSED` свежее последнего
   * `OPERATION_SCAN`; `OPERATION_FINISHED` по ТЕКУЩЕЙ операции свежее
   * последних `ISSUED_TO_EMPLOYEE` / `OPERATION_SCAN`.
   */
  private async computeStages(
    rows: (Omit<ProjectionPassport, 'hasFreshQcPassed' | 'hasFreshWtoPassed' | 'hasFreshSewingFinished'> & {
      id: string;
      currentOperationId: string | null;
    })[],
  ): Promise<Map<string, ShopfloorStage | null>> {
    const qcIds: string[] = [];
    const wtoIds: string[] = [];
    const sewingOps = new Map<string, string>();
    for (const p of rows) {
      if (p.status !== PassportStatus.IN_PROGRESS) continue;
      const cat = p.currentOperationCategory;
      if (cat === OperationCategory.QC) qcIds.push(p.id);
      else if (cat === OperationCategory.IRONING) wtoIds.push(p.id);
      else if (
        cat === OperationCategory.SEWING &&
        p.currentEmployeeId === null &&
        p.currentOperationId
      ) {
        sewingOps.set(p.id, p.currentOperationId);
      }
    }

    const freshQc = new Set<string>();
    const freshWto = new Set<string>();
    const freshSewing = new Set<string>();
    const termIds = [...qcIds, ...wtoIds];
    const [termRows, sewRows] = await Promise.all([
      termIds.length > 0
        ? this.prisma.passportEvent.groupBy({
            by: ['passportId', 'type'],
            where: {
              passportId: { in: termIds },
              type: {
                in: [
                  PassportEventType.QC_PASSED,
                  PassportEventType.WTO_PASSED,
                  PassportEventType.OPERATION_SCAN,
                ],
              },
            },
            _max: { createdAt: true },
          })
        : Promise.resolve([]),
      sewingOps.size > 0
        ? this.prisma.passportEvent.groupBy({
            by: ['passportId', 'type', 'operationId'],
            where: {
              passportId: { in: [...sewingOps.keys()] },
              type: {
                in: [
                  PassportEventType.OPERATION_FINISHED,
                  PassportEventType.ISSUED_TO_EMPLOYEE,
                  PassportEventType.OPERATION_SCAN,
                ],
              },
            },
            _max: { createdAt: true },
          })
        : Promise.resolve([]),
    ]);

    const lastQc = new Map<string, Date>();
    const lastWto = new Map<string, Date>();
    const lastScan = new Map<string, Date>();
    for (const r of termRows) {
      const at = r._max.createdAt;
      if (!at) continue;
      if (r.type === PassportEventType.QC_PASSED) lastQc.set(r.passportId, at);
      else if (r.type === PassportEventType.WTO_PASSED) lastWto.set(r.passportId, at);
      else lastScan.set(r.passportId, at);
    }
    for (const id of qcIds) {
      const at = lastQc.get(id);
      const scan = lastScan.get(id);
      if (at && (!scan || at > scan)) freshQc.add(id);
    }
    for (const id of wtoIds) {
      const at = lastWto.get(id);
      const scan = lastScan.get(id);
      if (at && (!scan || at > scan)) freshWto.add(id);
    }

    const lastFinished = new Map<string, Date>();
    const lastTaken = new Map<string, Date>();
    for (const r of sewRows) {
      const at = r._max.createdAt;
      if (!at) continue;
      if (r.type === PassportEventType.OPERATION_FINISHED) {
        if (r.operationId !== sewingOps.get(r.passportId)) continue;
        const prev = lastFinished.get(r.passportId);
        if (!prev || at > prev) lastFinished.set(r.passportId, at);
      } else {
        const prev = lastTaken.get(r.passportId);
        if (!prev || at > prev) lastTaken.set(r.passportId, at);
      }
    }
    for (const id of sewingOps.keys()) {
      const fin = lastFinished.get(id);
      const taken = lastTaken.get(id);
      if (fin && (!taken || fin > taken)) freshSewing.add(id);
    }

    const out = new Map<string, ShopfloorStage | null>();
    for (const p of rows) {
      out.set(
        p.id,
        bucketOf({
          sizeId: p.sizeId,
          qtyCut: p.qtyCut,
          qtyGood: p.qtyGood,
          qtyDefect: p.qtyDefect,
          status: p.status,
          currentOperationCategory: p.currentOperationCategory,
          currentEmployeeId: p.currentEmployeeId,
          hasOpenBox: p.hasOpenBox,
          hasFreshQcPassed: freshQc.has(p.id),
          hasFreshWtoPassed: freshWto.has(p.id),
          hasFreshSewingFinished: freshSewing.has(p.id),
        }),
      );
    }
    return out;
  }
}

function toWorkplace(e: {
  id: string;
  code: string;
  name: string;
  displayNumber: string | null;
}): OrderStandWorkplaceDto {
  return {
    id: e.id,
    code: e.code,
    name: e.name,
    displayNumber: e.displayNumber,
    qrPayload: `equipment:${e.id}`,
  };
}
