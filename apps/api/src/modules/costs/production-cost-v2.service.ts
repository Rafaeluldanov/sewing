import { Injectable } from '@nestjs/common';
import {
  EntryStatus,
  PassportEventType,
  PassportStatus,
  Prisma,
} from '@prisma/client';
import {
  PRODUCTION_COST_MATERIAL_SOURCE_LABELS,
  type ProductionCostEmployeeAggregateDto,
  type ProductionCostFilterOptionsDto,
  type ProductionCostMatrixCellDto,
  type ProductionCostMatrixEmployeeRowDto,
  type ProductionCostMatrixOperationRowDto,
  type ProductionCostMatrixSizeColumnDto,
  type ProductionCostMaterialSource,
  type ProductionCostNomenclatureGroupDto,
  type ProductionCostOperationAggregateDto,
  type ProductionCostOperationLineDto,
  type ProductionCostOrderGroupDto,
  type ProductionCostReportDto,
  type ProductionCostSalaryOperationDto,
  type ProductionCostSizeAggregateDto,
  type ProductionCostTotalsDto,
  type ProductionCostV2EntryStatus,
  type ProductionCostV2Query,
} from '@sewing/shared/production-cost';
import { SHIFT_MINUTES } from '@sewing/shared/costs';
import { getWorkshopNeedKind } from '@sewing/shared/workshop-needs';
import { PrismaService } from '../../prisma/prisma.service.js';
import { TIRAGE_NEED_WHERE } from '../workshop-needs/workshop-need-scope.js';
import { ACTIVE_CALCULATION_ESTIMATE_WHERE } from '../orders/cost-estimate-scope.js';
import { isSalaryEligible } from '../employees/compensation.js';
import {
  effectiveHourlyRateWithNorm,
  resolveMonthNormHours,
} from '../salary/salary-rate.js';
import { PassportRealCostService } from './passport-real-cost.service.js';

/**
 * Сервис управленческого отчёта «Себестоимость производства v2»
 * (`GET /api/admin/production-cost/v2`).
 *
 * См. recon `docs/production-cost-v2-recon.md`.
 *
 * Главные принципы:
 *
 *   - **Паспорт — не основная сущность**. Используется только как
 *     технический join `OperationEntry → Passport → Order →
 *     PatternItem`.
 *   - **Главный разрез** — номенклатура / лекало
 *     (`PatternItem` + snapshot полей `Order.patternNameSnapshot` /
 *     `patternArticleSnapshot` / `patternPreviewSnapshotUrl`, с
 *     legacy-fallback на `Product.name` через `OrderItem`).
 *   - **Выпуск считается в единицах изделий**: `Σ Passport.qtyGood`
 *     для паспортов в финальном статусе `PACKED`. Источник даты —
 *     `PassportEvent.PACKED.createdAt` в окне периода.
 *   - **Факт операций** — `OperationEntry` (`APPROVED` по умолчанию).
 *   - **Материалы / фурнитура / нанесение** — расчётная основа из
 *     `Order.currentCostEstimate.lines` (или fallback из
 *     `WorkshopNeed`), пропорциональная аллокация по выпуску.
 *
 * Сервис **read-only**, не пишет в БД, не вызывает payroll.
 */
@Injectable()
export class ProductionCostV2Service {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passportRealCost: PassportRealCostService,
  ) {}

  async getReport(
    query: ProductionCostV2Query,
  ): Promise<ProductionCostReportDto> {
    const { from, to, dateFromIso, dateToIso } = resolvePeriod(query);
    const entryStatus: ProductionCostV2EntryStatus =
      query.status ?? 'APPROVED';

    // Разнесённый оклад окладников по паспортам за период — для
    // `salaryAllocatedCostRub` (по выпущенным паспортам, см. шаг 4).
    // Источник — реальные интервалы `ISSUED_TO_EMPLOYEE →
    // OPERATION_FINISHED` с делением нахлёстов (см. `PassportRealCostService`).
    const apportionedSalary =
      await this.passportRealCost.apportionedSalaryForPeriod(from, to);
    const salaryByOrderId = new Map<string, Prisma.Decimal>();

    // -------------------------------------------------------------------
    // 1. OperationEntry в окне периода с фильтрами
    // -------------------------------------------------------------------
    //
    // Дата для управленческого отчёта = `approvedAt ?? createdAt`. Так
    // как Prisma не умеет coalesce в OR-ветке без costly raw, мы строим
    // композитный фильтр:
    //
    //   (status = APPROVED AND approvedAt BETWEEN [from, to])
    //   OR (status = ... AND approvedAt IS NULL AND createdAt BETWEEN ...)
    //
    // На практике для `APPROVED` `approvedAt` всегда заполнен в момент
    // approve (см. EarningsService.approvePendingForPassport). Для
    // PENDING/PENDING_RELEASE он null — берём createdAt. Это даёт нам
    // одну выборку без пост-фильтрации.
    const baseEntryWhere: Prisma.OperationEntryWhereInput = {
      status: entryStatus as EntryStatus,
    };
    if (query.operationId) baseEntryWhere.operationId = query.operationId;
    if (query.employeeId) baseEntryWhere.employeeId = query.employeeId;

    const passportWhereForEntry: Prisma.PassportWhereInput = {};
    if (query.orderId) passportWhereForEntry.orderId = query.orderId;
    if (query.clientId || query.patternItemId) {
      passportWhereForEntry.order = {};
      if (query.clientId)
        passportWhereForEntry.order.clientId = query.clientId;
      if (query.patternItemId)
        passportWhereForEntry.order.patternItemId = query.patternItemId;
    }
    if (Object.keys(passportWhereForEntry).length > 0) {
      baseEntryWhere.passport = passportWhereForEntry;
    }

    const dateRange = { gte: from, lte: to };
    const entryWhere: Prisma.OperationEntryWhereInput = {
      AND: [
        baseEntryWhere,
        {
          OR: [
            { approvedAt: dateRange },
            { approvedAt: null, createdAt: dateRange },
          ],
        },
      ],
    };

    const entries = await this.prisma.operationEntry.findMany({
      where: entryWhere,
      orderBy: [{ approvedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      include: {
        operation: {
          select: {
            id: true,
            name: true,
            category: true,
          },
        },
        employee: {
          select: { id: true, fullName: true },
        },
        passport: {
          select: {
            id: true,
            number: true,
            sizeId: true,
            color: true,
            order: {
              select: {
                id: true,
                number: true,
                color: true,
                clientId: true,
                patternItemId: true,
                patternNameSnapshot: true,
                patternArticleSnapshot: true,
                patternPreviewSnapshotUrl: true,
                materialsAndHardwareCostPolicy: true,
                client: { select: { id: true, name: true } },
                patternItem: {
                  select: {
                    id: true,
                    name: true,
                    article: true,
                    previewImageUrl: true,
                    category: { select: { id: true, name: true } },
                  },
                },
              },
            },
            size: { select: { id: true, code: true } },
          },
        },
      },
    });

    // Аккумулятор объединённой матрицы «операции · сотрудники · размеры»
    // по ключу номенклатуры. Сдельные строки заполняются из `entries`
    // (шаг 6), окладные — из разнесённого оклада PACKED-паспортов (шаг 4).
    const matrixByNom = new Map<string, NomMatrixAcc>();
    const ensureMatrix = (nomKey: string): NomMatrixAcc => {
      let m = matrixByNom.get(nomKey);
      if (!m) {
        m = { pieceOps: new Map(), salaryOps: new Map(), sizeMeta: new Map() };
        matrixByNom.set(nomKey, m);
      }
      return m;
    };

    // -------------------------------------------------------------------
    // 2. Финализированные паспорта (`PACKED`) в окне периода
    // -------------------------------------------------------------------
    //
    // Для расчёта `releasedQty` берём `PassportEvent.PACKED` в окне.
    // Это совпадает с подходом старого `CostsService` — дата выпуска
    // = дата реальной упаковки, а не `Passport.updatedAt`.
    const packedEvents = await this.prisma.passportEvent.findMany({
      where: {
        type: PassportEventType.PACKED,
        createdAt: dateRange,
        passport: passportFilterForReleased(query),
      },
      select: {
        passportId: true,
        createdAt: true,
        passport: {
          select: {
            id: true,
            qtyGood: true,
            sizeId: true,
            color: true,
            status: true,
            orderId: true,
            order: {
              select: {
                id: true,
                number: true,
                color: true,
                customer: true,
                clientId: true,
                patternItemId: true,
                patternNameSnapshot: true,
                patternArticleSnapshot: true,
                patternPreviewSnapshotUrl: true,
                materialsAndHardwareCostPolicy: true,
                customerUnitPrice: true,
                customerCurrency: true,
                client: { select: { id: true, name: true } },
                items: { select: { qtyPlan: true, productId: true } },
                patternItem: {
                  select: {
                    id: true,
                    name: true,
                    article: true,
                    previewImageUrl: true,
                    category: { select: { id: true, name: true } },
                  },
                },
              },
            },
            size: { select: { id: true, code: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    // -------------------------------------------------------------------
    // 3. Достаём currentCostEstimate (или WorkshopNeed) для всех
    //    задействованных заказов одним батч-запросом, чтобы не делать
    //    N+1.
    // -------------------------------------------------------------------
    const orderIdSet = new Set<string>();
    for (const e of entries) {
      if (e.passport?.order?.id) orderIdSet.add(e.passport.order.id);
    }
    for (const ev of packedEvents) {
      if (ev.passport.orderId) orderIdSet.add(ev.passport.orderId);
    }
    const orderIds = Array.from(orderIdSet);

    const costEstimates = orderIds.length
      ? await this.prisma.orderCostEstimate.findMany({
          // Смета — по варианту просчёта: только активный (см.
          // `apps/api/src/modules/orders/cost-estimate-scope.ts`).
          where: {
            orderId: { in: orderIds },
            status: 'COMPLETED',
            AND: [ACTIVE_CALCULATION_ESTIMATE_WHERE],
          },
          orderBy: { version: 'desc' },
          include: {
            lines: {
              select: { kind: true, lineTotalRub: true, quotedCurrency: true },
            },
          },
        })
      : [];
    const estimateByOrderId = new Map<
      string,
      (typeof costEstimates)[number]
    >();
    for (const est of costEstimates) {
      // Берём только активный (latest COMPLETED) расчёт по заказу.
      if (!estimateByOrderId.has(est.orderId)) {
        estimateByOrderId.set(est.orderId, est);
      }
    }

    const ordersWithoutEstimate = orderIds.filter(
      (id) => !estimateByOrderId.has(id),
    );
    const workshopNeeds = ordersWithoutEstimate.length
      ? await this.prisma.workshopNeed.findMany({
          where: {
            orderId: { in: ordersWithoutEstimate },
            NOT: { status: 'CANCELLED' },
            // Фича «Варианты просчёта»: fallback-план без сметы — только
            // активный вариант, иначе двойной счёт.
            AND: [TIRAGE_NEED_WHERE],
          },
          select: {
            orderId: true,
            sourceType: true,
            calculationMethod: true,
            materialRole: true,
            quotedPrice: true,
            quotedCurrency: true,
            purchaseQty: true,
            calculatedQty: true,
            erpManagedAt: true,
            erpUnitPriceRub: true,
          },
        })
      : [];

    // Достаём заказы целиком для ordersWithoutEstimate по одному select
    // (нам нужен qtyPlanTotal даже для заказов без cost estimate).
    // qtyPlanTotal у нас уже посчитается из items, которые мы и так
    // достали в packedEvents.passport.order.items. Если заказ
    // присутствует только в entries (без packed), items могут не быть
    // загружены — значит, releasedQty этого заказа = 0, и материалы
    // тоже = 0 (прорайт по 0 даёт 0). Так что отдельный fetch не нужен.

    // -------------------------------------------------------------------
    // 4. Считаем releasedQty + passportsCount по каждому заказу
    // -------------------------------------------------------------------
    const releasedByOrderId = new Map<
      string,
      {
        releasedQty: number;
        passportsCount: number;
        sizes: Map<string, { sizeCode: string; releasedQty: number }>;
      }
    >();
    // Уникализируем по passportId — у одного паспорта может быть
    // несколько PACKED-событий (теоретически — повторная упаковка), мы
    // берём первое в окне.
    const seenPackedPassports = new Set<string>();
    for (const ev of packedEvents) {
      if (seenPackedPassports.has(ev.passportId)) continue;
      // Финальный статус — `PACKED`. На MVP считаем выпуском только то,
      // что **сейчас** в `PACKED` (не было отменено после упаковки).
      if (ev.passport.status !== PassportStatus.PACKED) continue;
      seenPackedPassports.add(ev.passportId);
      const orderId = ev.passport.orderId;
      // Оклад этого выпущенного паспорта → заказу.
      const salRub = apportionedSalary.rubByPassport.get(ev.passportId);
      if (salRub) {
        salaryByOrderId.set(
          orderId,
          (salaryByOrderId.get(orderId) ?? new Prisma.Decimal(0)).add(salRub),
        );
      }
      const qty = ev.passport.qtyGood ?? 0;
      const ord =
        releasedByOrderId.get(orderId) ??
        (() => {
          const fresh = {
            releasedQty: 0,
            passportsCount: 0,
            sizes: new Map<
              string,
              { sizeCode: string; releasedQty: number }
            >(),
          };
          releasedByOrderId.set(orderId, fresh);
          return fresh;
        })();
      ord.releasedQty += qty;
      ord.passportsCount += 1;
      const sizeKey = ev.passport.sizeId ?? 'unknown';
      const sizeCode = ev.passport.size?.code ?? '—';
      const sizeAgg =
        ord.sizes.get(sizeKey) ??
        (() => {
          const fresh = { sizeCode, releasedQty: 0 };
          ord.sizes.set(sizeKey, fresh);
          return fresh;
        })();
      sizeAgg.releasedQty += qty;

      // Матрица: окладные операции этого PACKED-паспорта раскладываем по
      // лекалу × размеру (разнесённое реальное время × оклад/480).
      const salaryLines = apportionedSalary.linesByPassport.get(ev.passportId);
      const ordOfPassport = ev.passport.order;
      if (salaryLines && salaryLines.length > 0 && ordOfPassport) {
        const nomKey = nomenclatureKeyFor({
          patternItemId: ordOfPassport.patternItemId,
          patternNameSnapshot: ordOfPassport.patternNameSnapshot,
          patternArticleSnapshot: ordOfPassport.patternArticleSnapshot,
          patternItemName: ordOfPassport.patternItem?.name ?? null,
          patternItemArticle: ordOfPassport.patternItem?.article ?? null,
        });
        const m = ensureMatrix(nomKey);
        m.sizeMeta.set(sizeKey, {
          sizeId: ev.passport.sizeId ?? null,
          sizeCode,
        });
        for (const ln of salaryLines) {
          if (!ln.operationId) continue;
          const meta = apportionedSalary.salaryByOperation.get(ln.operationId);
          const op =
            m.salaryOps.get(ln.operationId) ??
            ({
              operationName:
                ln.operationName ?? meta?.operationName ?? ln.operationId,
              operationCategory: meta?.operationCategory ?? '',
              minutes: 0,
              rub: 0,
              bySize: new Map<string, MatrixSalaryCellAcc>(),
              byEmp: new Map<string, MatrixSalaryEmpAcc>(),
            } satisfies MatrixSalaryOpAcc);
          op.minutes += ln.minutes;
          op.rub += ln.rub;
          const cell =
            op.bySize.get(sizeKey) ??
            ({
              sizeId: ev.passport.sizeId ?? null,
              sizeCode,
              minutes: 0,
              rub: 0,
            } satisfies MatrixSalaryCellAcc);
          cell.minutes += ln.minutes;
          cell.rub += ln.rub;
          op.bySize.set(sizeKey, cell);

          // Окладные операции тоже раскрываются в сотрудников (как сдельные).
          const emp =
            op.byEmp.get(ln.employeeId) ??
            ({
              employeeName: ln.employeeName ?? ln.employeeId,
              minutes: 0,
              rub: 0,
              bySize: new Map<string, MatrixSalaryCellAcc>(),
            } satisfies MatrixSalaryEmpAcc);
          emp.minutes += ln.minutes;
          emp.rub += ln.rub;
          const empCell =
            emp.bySize.get(sizeKey) ??
            ({
              sizeId: ev.passport.sizeId ?? null,
              sizeCode,
              minutes: 0,
              rub: 0,
            } satisfies MatrixSalaryCellAcc);
          empCell.minutes += ln.minutes;
          empCell.rub += ln.rub;
          emp.bySize.set(sizeKey, empCell);
          op.byEmp.set(ln.employeeId, emp);

          m.salaryOps.set(ln.operationId, op);
        }
      }
    }

    // Метаданные заказа (orderNumber/clientName/nomenclature) могут
    // прийти как из packedEvents, так и из entries.passport.order.
    // Складываем в единую map, чтобы строить группы стабильно.
    type OrderMeta = {
      orderId: string;
      orderNumber: string;
      clientId: string | null;
      clientName: string | null;
      patternItemId: string | null;
      patternNameSnapshot: string | null;
      patternArticleSnapshot: string | null;
      patternPreviewSnapshotUrl: string | null;
      patternItemName: string | null;
      patternItemArticle: string | null;
      patternItemPreviewUrl: string | null;
      patternCategoryName: string | null;
      color: string | null;
      qtyPlanTotal: number;
      customerUnitPriceRub: Prisma.Decimal | null;
      customerCurrency: string | null;
      /**
       * Политика материалов/фурнитуры: `EXCLUDE` = давальческое сырьё
       * заказчика, стоимость MATERIAL/HARDWARE НЕ входит в себестоимость
       * (зеркалит `CostsService`/`OrderCostEstimatesService`).
       */
      materialsAndHardwareCostPolicy: string;
    };
    const orderMetaById = new Map<string, OrderMeta>();
    const upsertOrderMeta = (
      o: {
        id: string;
        number: string;
        color?: string | null;
        clientId: string | null;
        client: { id: string; name: string } | null;
        patternItemId: string | null;
        patternNameSnapshot: string | null;
        patternArticleSnapshot: string | null;
        patternPreviewSnapshotUrl: string | null;
        patternItem: {
          id: string;
          name: string;
          article: string;
          previewImageUrl: string | null;
          category: { id: string; name: string } | null;
        } | null;
        items?: { qtyPlan: number; productId: string }[];
        customerUnitPrice?: Prisma.Decimal | null;
        customerCurrency?: string | null;
        materialsAndHardwareCostPolicy?: string;
      },
    ) => {
      const existing = orderMetaById.get(o.id);
      const qtyPlanTotal =
        o.items?.reduce((sum, it) => sum + (it.qtyPlan ?? 0), 0) ?? 0;
      const meta: OrderMeta = existing ?? {
        orderId: o.id,
        orderNumber: o.number,
        clientId: o.clientId,
        clientName: o.client?.name ?? null,
        patternItemId: o.patternItemId,
        patternNameSnapshot: o.patternNameSnapshot,
        patternArticleSnapshot: o.patternArticleSnapshot,
        patternPreviewSnapshotUrl: o.patternPreviewSnapshotUrl,
        patternItemName: o.patternItem?.name ?? null,
        patternItemArticle: o.patternItem?.article ?? null,
        patternItemPreviewUrl: o.patternItem?.previewImageUrl ?? null,
        patternCategoryName: o.patternItem?.category?.name ?? null,
        color: o.color ?? null,
        qtyPlanTotal,
        customerUnitPriceRub: o.customerUnitPrice ?? null,
        customerCurrency: o.customerCurrency ?? null,
        materialsAndHardwareCostPolicy:
          o.materialsAndHardwareCostPolicy ?? 'INCLUDE',
      };
      // Если уже было — обновим только то, что могло отсутствовать.
      if (existing) {
        if (existing.qtyPlanTotal === 0 && qtyPlanTotal > 0)
          existing.qtyPlanTotal = qtyPlanTotal;
        if (
          existing.customerUnitPriceRub === null &&
          o.customerUnitPrice !== undefined &&
          o.customerUnitPrice !== null
        ) {
          existing.customerUnitPriceRub = o.customerUnitPrice;
          existing.customerCurrency = o.customerCurrency ?? null;
        }
        return;
      }
      orderMetaById.set(o.id, meta);
    };

    for (const ev of packedEvents) {
      const o = ev.passport.order;
      if (!o) continue;
      upsertOrderMeta({ ...o });
    }
    for (const e of entries) {
      const o = e.passport?.order;
      if (!o) continue;
      // entries.passport.order не имеет items/customerUnitPrice — они
      // не нужны для DTO операций, поэтому upsertOrderMeta получит их
      // позже из packedEvents (если заказ что-то выпустил в периоде).
      upsertOrderMeta({ ...o });
    }

    // -------------------------------------------------------------------
    // 5. Маппим OperationEntry → operationLines DTO
    // -------------------------------------------------------------------
    const warnings = new Set<string>();
    const operationLines: ProductionCostOperationLineDto[] = entries.map((e) =>
      mapOperationEntryToLine(e),
    );

    // -------------------------------------------------------------------
    // 6. Группируем по заказу — сначала операции и метрики, потом
    //    привязываем материалы / выручку / маржу.
    // -------------------------------------------------------------------
    type OrderGroupAcc = {
      meta: OrderMeta;
      operationPieceworkCostRub: Prisma.Decimal;
      operationEntriesCount: number;
      operationLinesByEmployee: Map<
        string,
        { employeeName: string; qty: number; amount: Prisma.Decimal }
      >;
      operationLinesByOperation: Map<
        string,
        {
          operationName: string;
          operationCategory: string;
          qty: number;
          amount: Prisma.Decimal;
        }
      >;
      operationLinesBySize: Map<
        string,
        { sizeCode: string; qty: number; amount: Prisma.Decimal }
      >;
    };
    const orderAcc = new Map<string, OrderGroupAcc>();
    const ensureOrderAcc = (orderId: string): OrderGroupAcc | null => {
      const meta = orderMetaById.get(orderId);
      if (!meta) return null;
      let acc = orderAcc.get(orderId);
      if (!acc) {
        acc = {
          meta,
          operationPieceworkCostRub: new Prisma.Decimal(0),
          operationEntriesCount: 0,
          operationLinesByEmployee: new Map(),
          operationLinesByOperation: new Map(),
          operationLinesBySize: new Map(),
        };
        orderAcc.set(orderId, acc);
      }
      return acc;
    };
    // Все заказы, у которых есть PACKED в периоде, обязательно
    // присутствуют в orderAcc, даже если у них нет OperationEntry в
    // выборке (выпуск был, начислений в этом окне нет).
    for (const orderId of releasedByOrderId.keys()) ensureOrderAcc(orderId);

    for (const e of entries) {
      const orderId = e.passport?.order?.id;
      if (!orderId) continue;
      const acc = ensureOrderAcc(orderId);
      if (!acc) continue;
      const amount = new Prisma.Decimal(e.amount);
      acc.operationPieceworkCostRub = acc.operationPieceworkCostRub.add(amount);
      acc.operationEntriesCount += 1;
      const empKey = e.employeeId;
      const empAgg = acc.operationLinesByEmployee.get(empKey) ?? {
        employeeName: e.employee?.fullName ?? '—',
        qty: 0,
        amount: new Prisma.Decimal(0),
      };
      empAgg.qty += e.qty;
      empAgg.amount = empAgg.amount.add(amount);
      acc.operationLinesByEmployee.set(empKey, empAgg);

      const opKey = e.operationId;
      const opAgg = acc.operationLinesByOperation.get(opKey) ?? {
        operationName: e.operation?.name ?? '—',
        operationCategory: e.operation?.category ?? 'OTHER',
        qty: 0,
        amount: new Prisma.Decimal(0),
      };
      opAgg.qty += e.qty;
      opAgg.amount = opAgg.amount.add(amount);
      acc.operationLinesByOperation.set(opKey, opAgg);

      const sizeKey = e.passport?.sizeId ?? 'unknown';
      const sizeCode = e.passport?.size?.code ?? '—';
      const szAgg = acc.operationLinesBySize.get(sizeKey) ?? {
        sizeCode,
        qty: 0,
        amount: new Prisma.Decimal(0),
      };
      szAgg.qty += e.qty;
      szAgg.amount = szAgg.amount.add(amount);
      acc.operationLinesBySize.set(sizeKey, szAgg);

      // Матрица: сдельная операция × сотрудник × размер по лекалу.
      const orderForMatrix = e.passport?.order;
      if (orderForMatrix) {
        const nomKey = nomenclatureKeyFor({
          patternItemId: orderForMatrix.patternItemId,
          patternNameSnapshot: orderForMatrix.patternNameSnapshot,
          patternArticleSnapshot: orderForMatrix.patternArticleSnapshot,
          patternItemName: orderForMatrix.patternItem?.name ?? null,
          patternItemArticle: orderForMatrix.patternItem?.article ?? null,
        });
        const m = ensureMatrix(nomKey);
        const sizeIdForCell = e.passport?.sizeId ?? null;
        m.sizeMeta.set(sizeKey, { sizeId: sizeIdForCell, sizeCode });
        const mop =
          m.pieceOps.get(e.operationId) ??
          ({
            operationName: e.operation?.name ?? '—',
            operationCategory: e.operation?.category ?? 'OTHER',
            qty: 0,
            amount: new Prisma.Decimal(0),
            bySize: new Map<string, MatrixCellAcc>(),
            byEmp: new Map<string, MatrixPieceEmpAcc>(),
          } satisfies MatrixPieceOpAcc);
        mop.qty += e.qty;
        mop.amount = mop.amount.add(amount);
        const opCell =
          mop.bySize.get(sizeKey) ??
          ({
            sizeId: sizeIdForCell,
            sizeCode,
            qty: 0,
            amount: new Prisma.Decimal(0),
          } satisfies MatrixCellAcc);
        opCell.qty += e.qty;
        opCell.amount = opCell.amount.add(amount);
        mop.bySize.set(sizeKey, opCell);
        const memp =
          mop.byEmp.get(e.employeeId) ??
          ({
            employeeName: e.employee?.fullName ?? '—',
            qty: 0,
            amount: new Prisma.Decimal(0),
            bySize: new Map<string, MatrixCellAcc>(),
          } satisfies MatrixPieceEmpAcc);
        memp.qty += e.qty;
        memp.amount = memp.amount.add(amount);
        const empCell =
          memp.bySize.get(sizeKey) ??
          ({
            sizeId: sizeIdForCell,
            sizeCode,
            qty: 0,
            amount: new Prisma.Decimal(0),
          } satisfies MatrixCellAcc);
        empCell.qty += e.qty;
        empCell.amount = empCell.amount.add(amount);
        memp.bySize.set(sizeKey, empCell);
        mop.byEmp.set(e.employeeId, memp);
        m.pieceOps.set(e.operationId, mop);
      }
    }

    // -------------------------------------------------------------------
    // 7. Материалы по заказу: cost-estimate proпорция или WorkshopNeed
    // -------------------------------------------------------------------
    const orderMaterials = new Map<
      string,
      {
        materialCostRub: Prisma.Decimal;
        hardwareCostRub: Prisma.Decimal;
        applicationCostRub: Prisma.Decimal;
        otherCostRub: Prisma.Decimal;
        source: ProductionCostMaterialSource;
      }
    >();

    const wnByOrderId = new Map<string, typeof workshopNeeds>();
    for (const wn of workshopNeeds) {
      const arr = wnByOrderId.get(wn.orderId) ?? [];
      arr.push(wn);
      wnByOrderId.set(wn.orderId, arr);
    }

    const zeroRub = () => new Prisma.Decimal(0);
    for (const orderId of orderIds) {
      const meta = orderMetaById.get(orderId);
      const released = releasedByOrderId.get(orderId)?.releasedQty ?? 0;
      const qtyPlan = meta?.qtyPlanTotal ?? 0;
      const ratio =
        qtyPlan > 0
          ? new Prisma.Decimal(released).div(new Prisma.Decimal(qtyPlan))
          : new Prisma.Decimal(0);
      // Давальческое сырьё/фурнитура: стоимость MATERIAL/HARDWARE не входит
      // в себестоимость. Смета/WorkshopNeed по-прежнему хранят полную
      // стоимость строк (исключение живёт только на агрегате сметы), поэтому
      // гейтим здесь — как CostsService/passport-real-cost. APPLICATION и
      // OTHER (нанесение/прочее) остаются: их платит цех.
      const excludeMatHw =
        meta?.materialsAndHardwareCostPolicy === 'EXCLUDE';

      const est = estimateByOrderId.get(orderId);
      if (est && ratio.greaterThan(0)) {
        const sums = sumEstimateLinesByKind(est.lines);
        orderMaterials.set(orderId, {
          materialCostRub: excludeMatHw
            ? zeroRub()
            : round2(sums.MATERIAL.mul(ratio)),
          hardwareCostRub: excludeMatHw
            ? zeroRub()
            : round2(sums.HARDWARE.mul(ratio)),
          applicationCostRub: round2(sums.APPLICATION.mul(ratio)),
          otherCostRub: round2(sums.OTHER.mul(ratio)),
          source: 'COST_ESTIMATE',
        });
        continue;
      }

      // Fallback на WorkshopNeed: только RUB-строки с positive
      // quotedPrice. Для USD-строк добавляем warning.
      const wns = wnByOrderId.get(orderId) ?? [];
      if (wns.length > 0 && ratio.greaterThan(0)) {
        let materialRub = new Prisma.Decimal(0);
        let hardwareRub = new Prisma.Decimal(0);
        let applicationRub = new Prisma.Decimal(0);
        let otherRub = new Prisma.Decimal(0);
        let hasUsdWarning = false;
        for (const wn of wns) {
          // Материал под ERP без цены закупщика цеха — цена заказа ERP, рубли.
          const erpPrice =
            wn.erpManagedAt && wn.erpUnitPriceRub && !wn.quotedPrice ? wn.erpUnitPriceRub : null;
          const currency = erpPrice ? 'RUB' : (wn.quotedCurrency ?? '').toUpperCase();
          if (!wn.quotedPrice && !erpPrice) continue;
          const purchaseQty = wn.purchaseQty ?? wn.calculatedQty;
          if (!purchaseQty) continue;
          if (currency === 'USD') {
            hasUsdWarning = true;
            continue;
          }
          if (currency !== 'RUB') continue;
          const lineTotal = new Prisma.Decimal(purchaseQty).mul(
            new Prisma.Decimal(wn.quotedPrice ?? erpPrice!),
          );
          // Каноническая классификация (роль-aware), как в смете
          // (`OrderCostEstimatesService` через line.kind) и в документе
          // план→факт. Прежний sourceType-only `classifyWorkshopNeed`
          // ронял основную ткань (PATTERN_MATERIAL_AREA/…) в OTHER, и гейт
          // EXCLUDE её не занулял (утечка давальческого материала).
          const kind = getWorkshopNeedKind({
            sourceType: wn.sourceType,
            calculationMethod: wn.calculationMethod,
            materialRole: wn.materialRole,
          });
          if (kind === 'MATERIAL') materialRub = materialRub.add(lineTotal);
          else if (kind === 'HARDWARE')
            hardwareRub = hardwareRub.add(lineTotal);
          else if (kind === 'APPLICATION')
            applicationRub = applicationRub.add(lineTotal);
          else otherRub = otherRub.add(lineTotal);
        }
        if (hasUsdWarning) {
          warnings.add(
            `Заказ ${meta?.orderNumber ?? orderId}: USD-строки потребности цеха не учтены без курса`,
          );
        }
        orderMaterials.set(orderId, {
          materialCostRub: excludeMatHw
            ? zeroRub()
            : round2(materialRub.mul(ratio)),
          hardwareCostRub: excludeMatHw
            ? zeroRub()
            : round2(hardwareRub.mul(ratio)),
          applicationCostRub: round2(applicationRub.mul(ratio)),
          otherCostRub: round2(otherRub.mul(ratio)),
          source: 'WORKSHOP_NEED',
        });
      } else {
        orderMaterials.set(orderId, {
          materialCostRub: new Prisma.Decimal(0),
          hardwareCostRub: new Prisma.Decimal(0),
          applicationCostRub: new Prisma.Decimal(0),
          otherCostRub: new Prisma.Decimal(0),
          source: 'NONE',
        });
        if (released > 0 && meta) {
          warnings.add(
            `Заказ ${meta.orderNumber}: нет источника материалов (нет завершённого расчёта и активной потребности)`,
          );
        }
      }
    }

    // -------------------------------------------------------------------
    // 8. Сборка orderGroups
    // -------------------------------------------------------------------
    const orderGroups: ProductionCostOrderGroupDto[] = [];
    for (const acc of orderAcc.values()) {
      const released = releasedByOrderId.get(acc.meta.orderId);
      const releasedQty = released?.releasedQty ?? 0;
      const passportsCount = released?.passportsCount ?? 0;
      const mat = orderMaterials.get(acc.meta.orderId) ?? {
        materialCostRub: new Prisma.Decimal(0),
        hardwareCostRub: new Prisma.Decimal(0),
        applicationCostRub: new Prisma.Decimal(0),
        otherCostRub: new Prisma.Decimal(0),
        source: 'NONE' as const,
      };

      // Выручка: только RUB. USD без курса — warning + revenueRub = 0.
      const customerCurrency =
        (acc.meta.customerCurrency ?? '').toUpperCase() || null;
      let revenueRub = new Prisma.Decimal(0);
      if (
        acc.meta.customerUnitPriceRub &&
        customerCurrency === 'RUB' &&
        releasedQty > 0
      ) {
        revenueRub = round2(
          new Prisma.Decimal(acc.meta.customerUnitPriceRub).mul(releasedQty),
        );
      } else if (
        acc.meta.customerUnitPriceRub &&
        customerCurrency === 'USD' &&
        releasedQty > 0
      ) {
        warnings.add(
          `Заказ ${acc.meta.orderNumber}: цена в USD, выручка в рублях не рассчитана (нет курса)`,
        );
      }

      const operationPieceworkCostRub = round2(
        acc.operationPieceworkCostRub,
      );
      const salaryAllocatedCostRub = round2(
        salaryByOrderId.get(acc.meta.orderId) ?? new Prisma.Decimal(0),
      );
      const totalCostRub = round2(
        operationPieceworkCostRub
          .add(mat.materialCostRub)
          .add(mat.hardwareCostRub)
          .add(mat.applicationCostRub)
          .add(mat.otherCostRub)
          .add(salaryAllocatedCostRub),
      );
      const unitCostRub =
        releasedQty > 0
          ? round2(totalCostRub.div(new Prisma.Decimal(releasedQty)))
          : null;
      const marginRub = round2(revenueRub.sub(totalCostRub));
      const marginPercent =
        revenueRub.greaterThan(0)
          ? round2(marginRub.div(revenueRub).mul(100))
          : null;

      orderGroups.push({
        orderId: acc.meta.orderId,
        orderNumber: acc.meta.orderNumber,
        clientId: acc.meta.clientId,
        clientName: acc.meta.clientName,
        patternItemId: acc.meta.patternItemId,
        nomenclatureName:
          acc.meta.patternNameSnapshot ?? acc.meta.patternItemName ?? null,
        nomenclatureArticle:
          acc.meta.patternArticleSnapshot ??
          acc.meta.patternItemArticle ??
          null,
        color: acc.meta.color,
        releasedQty,
        passportsCount,
        qtyPlanTotal: acc.meta.qtyPlanTotal,
        operationEntriesCount: acc.operationEntriesCount,
        revenueRub: revenueRub.toFixed(2),
        materialCostRub: mat.materialCostRub.toFixed(2),
        hardwareCostRub: mat.hardwareCostRub.toFixed(2),
        applicationCostRub: mat.applicationCostRub.toFixed(2),
        operationPieceworkCostRub: operationPieceworkCostRub.toFixed(2),
        salaryAllocatedCostRub: salaryAllocatedCostRub.toFixed(2),
        otherCostRub: mat.otherCostRub.toFixed(2),
        totalCostRub: totalCostRub.toFixed(2),
        unitCostRub: unitCostRub ? unitCostRub.toFixed(2) : null,
        marginRub: marginRub.toFixed(2),
        marginPercent: marginPercent ? marginPercent.toFixed(2) : null,
        materialSource: mat.source,
        customerCurrency: customerCurrency,
        customerUnitPrice: acc.meta.customerUnitPriceRub
          ? new Prisma.Decimal(acc.meta.customerUnitPriceRub).toFixed(2)
          : null,
      });
    }
    orderGroups.sort((a, b) => a.orderNumber.localeCompare(b.orderNumber));

    // -------------------------------------------------------------------
    // 9. Группируем заказы → номенклатура
    // -------------------------------------------------------------------
    type NomenclatureAcc = {
      key: string;
      patternItemId: string | null;
      nomenclatureName: string | null;
      nomenclatureArticle: string | null;
      previewImageUrl: string | null;
      categoryName: string | null;

      releasedQty: number;
      passportsCount: number;
      ordersCount: number;
      operationEntriesCount: number;

      revenueRub: Prisma.Decimal;
      materialCostRub: Prisma.Decimal;
      hardwareCostRub: Prisma.Decimal;
      applicationCostRub: Prisma.Decimal;
      operationPieceworkCostRub: Prisma.Decimal;
      salaryAllocatedCostRub: Prisma.Decimal;
      otherCostRub: Prisma.Decimal;

      operationByOpId: Map<
        string,
        {
          operationName: string;
          operationCategory: string;
          qty: number;
          amount: Prisma.Decimal;
        }
      >;
      employeeByEmpId: Map<
        string,
        { employeeName: string; qty: number; amount: Prisma.Decimal }
      >;
      sizeByKey: Map<
        string,
        {
          sizeId: string | null;
          sizeCode: string;
          releasedQty: number;
          operationCostRub: Prisma.Decimal;
        }
      >;
    };
    const nomAcc = new Map<string, NomenclatureAcc>();
    const ensureNom = (
      key: string,
      meta: OrderMeta,
    ): NomenclatureAcc => {
      let acc = nomAcc.get(key);
      if (acc) return acc;
      acc = {
        key,
        patternItemId: meta.patternItemId,
        nomenclatureName:
          meta.patternNameSnapshot ?? meta.patternItemName ?? null,
        nomenclatureArticle:
          meta.patternArticleSnapshot ?? meta.patternItemArticle ?? null,
        previewImageUrl:
          meta.patternPreviewSnapshotUrl ?? meta.patternItemPreviewUrl ?? null,
        categoryName: meta.patternCategoryName,
        releasedQty: 0,
        passportsCount: 0,
        ordersCount: 0,
        operationEntriesCount: 0,
        revenueRub: new Prisma.Decimal(0),
        materialCostRub: new Prisma.Decimal(0),
        hardwareCostRub: new Prisma.Decimal(0),
        applicationCostRub: new Prisma.Decimal(0),
        operationPieceworkCostRub: new Prisma.Decimal(0),
        salaryAllocatedCostRub: new Prisma.Decimal(0),
        otherCostRub: new Prisma.Decimal(0),
        operationByOpId: new Map(),
        employeeByEmpId: new Map(),
        sizeByKey: new Map(),
      };
      nomAcc.set(key, acc);
      return acc;
    };

    for (const og of orderGroups) {
      const meta = orderMetaById.get(og.orderId);
      if (!meta) continue;
      const key = nomenclatureKeyFor(meta);
      const acc = ensureNom(key, meta);
      acc.ordersCount += 1;
      acc.releasedQty += og.releasedQty;
      acc.passportsCount += og.passportsCount;
      acc.operationEntriesCount += og.operationEntriesCount;
      acc.revenueRub = acc.revenueRub.add(new Prisma.Decimal(og.revenueRub));
      acc.materialCostRub = acc.materialCostRub.add(
        new Prisma.Decimal(og.materialCostRub),
      );
      acc.hardwareCostRub = acc.hardwareCostRub.add(
        new Prisma.Decimal(og.hardwareCostRub),
      );
      acc.applicationCostRub = acc.applicationCostRub.add(
        new Prisma.Decimal(og.applicationCostRub),
      );
      acc.operationPieceworkCostRub = acc.operationPieceworkCostRub.add(
        new Prisma.Decimal(og.operationPieceworkCostRub),
      );
      acc.salaryAllocatedCostRub = acc.salaryAllocatedCostRub.add(
        new Prisma.Decimal(og.salaryAllocatedCostRub),
      );
      acc.otherCostRub = acc.otherCostRub.add(
        new Prisma.Decimal(og.otherCostRub),
      );
    }

    // Breakdown'ы заполняем из orderAcc (operations/employees) и
    // releasedByOrderId (sizes для releasedQty).
    for (const acc of orderAcc.values()) {
      const meta = acc.meta;
      const key = nomenclatureKeyFor(meta);
      const nom = nomAcc.get(key);
      if (!nom) continue;
      for (const [opId, opAgg] of acc.operationLinesByOperation) {
        const cur = nom.operationByOpId.get(opId) ?? {
          operationName: opAgg.operationName,
          operationCategory: opAgg.operationCategory,
          qty: 0,
          amount: new Prisma.Decimal(0),
        };
        cur.qty += opAgg.qty;
        cur.amount = cur.amount.add(opAgg.amount);
        nom.operationByOpId.set(opId, cur);
      }
      for (const [empId, empAgg] of acc.operationLinesByEmployee) {
        const cur = nom.employeeByEmpId.get(empId) ?? {
          employeeName: empAgg.employeeName,
          qty: 0,
          amount: new Prisma.Decimal(0),
        };
        cur.qty += empAgg.qty;
        cur.amount = cur.amount.add(empAgg.amount);
        nom.employeeByEmpId.set(empId, cur);
      }
      // Sizes from operations (operationCostRub per size).
      for (const [sizeKey, szAgg] of acc.operationLinesBySize) {
        const cur = nom.sizeByKey.get(sizeKey) ?? {
          sizeId: sizeKey === 'unknown' ? null : sizeKey,
          sizeCode: szAgg.sizeCode,
          releasedQty: 0,
          operationCostRub: new Prisma.Decimal(0),
        };
        cur.operationCostRub = cur.operationCostRub.add(szAgg.amount);
        nom.sizeByKey.set(sizeKey, cur);
      }
    }
    // Sizes — releasedQty из releasedByOrderId.
    for (const [orderId, rel] of releasedByOrderId) {
      const meta = orderMetaById.get(orderId);
      if (!meta) continue;
      const nom = nomAcc.get(nomenclatureKeyFor(meta));
      if (!nom) continue;
      for (const [sizeKey, szRel] of rel.sizes) {
        const cur = nom.sizeByKey.get(sizeKey) ?? {
          sizeId: sizeKey === 'unknown' ? null : sizeKey,
          sizeCode: szRel.sizeCode,
          releasedQty: 0,
          operationCostRub: new Prisma.Decimal(0),
        };
        cur.releasedQty += szRel.releasedQty;
        nom.sizeByKey.set(sizeKey, cur);
      }
    }

    const nomenclatureGroups: ProductionCostNomenclatureGroupDto[] = [];
    for (const acc of nomAcc.values()) {
      const totalCostRub = round2(
        acc.materialCostRub
          .add(acc.hardwareCostRub)
          .add(acc.applicationCostRub)
          .add(acc.operationPieceworkCostRub)
          .add(acc.salaryAllocatedCostRub)
          .add(acc.otherCostRub),
      );
      const unitCostRub =
        acc.releasedQty > 0
          ? round2(totalCostRub.div(new Prisma.Decimal(acc.releasedQty)))
          : null;
      const marginRub = round2(round2(acc.revenueRub).sub(totalCostRub));
      const marginPercent =
        acc.revenueRub.greaterThan(0)
          ? round2(marginRub.div(acc.revenueRub).mul(100))
          : null;

      const operationBreakdown: ProductionCostOperationAggregateDto[] = [];
      for (const [opId, agg] of acc.operationByOpId) {
        const unitAvg =
          agg.qty > 0
            ? round2(agg.amount.div(new Prisma.Decimal(agg.qty)))
            : new Prisma.Decimal(0);
        operationBreakdown.push({
          operationId: opId,
          operationName: agg.operationName,
          operationCategory: agg.operationCategory,
          qty: agg.qty,
          amount: round2(agg.amount).toFixed(2),
          unitCostAvg: unitAvg.toFixed(2),
        });
      }
      operationBreakdown.sort((a, b) =>
        a.operationName.localeCompare(b.operationName),
      );

      const employeeBreakdown: ProductionCostEmployeeAggregateDto[] = [];
      for (const [empId, agg] of acc.employeeByEmpId) {
        employeeBreakdown.push({
          employeeId: empId,
          employeeName: agg.employeeName,
          qty: agg.qty,
          amount: round2(agg.amount).toFixed(2),
        });
      }
      employeeBreakdown.sort((a, b) =>
        a.employeeName.localeCompare(b.employeeName),
      );

      const sizeBreakdown: ProductionCostSizeAggregateDto[] = [];
      for (const agg of acc.sizeByKey.values()) {
        sizeBreakdown.push({
          sizeId: agg.sizeId,
          sizeCode: agg.sizeCode,
          releasedQty: agg.releasedQty,
          operationCostRub: round2(agg.operationCostRub).toFixed(2),
        });
      }
      sizeBreakdown.sort((a, b) => a.sizeCode.localeCompare(b.sizeCode));

      const { sizeColumns, operationMatrix } = buildOperationMatrix(
        matrixByNom.get(acc.key),
        acc.sizeByKey,
      );

      nomenclatureGroups.push({
        nomenclatureKey: acc.key,
        patternItemId: acc.patternItemId,
        nomenclatureName: acc.nomenclatureName,
        nomenclatureArticle: acc.nomenclatureArticle,
        previewImageUrl: acc.previewImageUrl,
        categoryName: acc.categoryName,
        releasedQty: acc.releasedQty,
        passportsCount: acc.passportsCount,
        ordersCount: acc.ordersCount,
        operationEntriesCount: acc.operationEntriesCount,
        revenueRub: round2(acc.revenueRub).toFixed(2),
        materialCostRub: round2(acc.materialCostRub).toFixed(2),
        hardwareCostRub: round2(acc.hardwareCostRub).toFixed(2),
        applicationCostRub: round2(acc.applicationCostRub).toFixed(2),
        operationPieceworkCostRub: round2(
          acc.operationPieceworkCostRub,
        ).toFixed(2),
        salaryAllocatedCostRub: round2(acc.salaryAllocatedCostRub).toFixed(
          2,
        ),
        otherCostRub: round2(acc.otherCostRub).toFixed(2),
        totalCostRub: totalCostRub.toFixed(2),
        unitCostRub: unitCostRub ? unitCostRub.toFixed(2) : null,
        marginRub: marginRub.toFixed(2),
        marginPercent: marginPercent ? marginPercent.toFixed(2) : null,
        operationBreakdown,
        employeeBreakdown,
        sizeBreakdown,
        sizeColumns,
        operationMatrix,
      });
    }
    nomenclatureGroups.sort((a, b) => {
      const an = a.nomenclatureName ?? '';
      const bn = b.nomenclatureName ?? '';
      return an.localeCompare(bn);
    });

    // -------------------------------------------------------------------
    // 10. Totals
    // -------------------------------------------------------------------
    // Окладная часть за период: «рабочая» (разнесённое время × ставка) и
    // «простой» (max(0, 480 − разнесённое) × ставка) — для мини-отчёта
    // «Себестоимость / Простой» в шапке. В `totalCostRub` оклад не входит
    // (он не распределяется по номенклатуре), поэтому считаем отдельно.
    const salarySplit = await this.computeSalarySplit(
      from,
      to,
      apportionedSalary.rubByPassport,
      apportionedSalary.trackedMinutesByEmpDay,
    );
    const totals = computeTotals(nomenclatureGroups, salarySplit);

    // Honest disclosure об оклaде (всегда в MVP):
    if (totals.operationPieceworkCostRub !== '0.00') {
      warnings.add(
        'Окладная составляющая не распределена по номенклатуре в этом отчёте',
      );
    }

    // Окладные операции (ОТК/ВТО/Упаковка/Деление кроя) — отдельная
    // таблица из разнесённого реального времени (у них нет OperationEntry).
    const salaryOperationBreakdown: ProductionCostSalaryOperationDto[] =
      Array.from(apportionedSalary.salaryByOperation.entries())
        .map(([operationId, agg]) => ({
          operationId,
          operationName: agg.operationName,
          operationCategory: agg.operationCategory,
          minutes: agg.minutes,
          rub: agg.rub.toFixed(2),
          rubPerMinute:
            agg.minutes > 0 ? (agg.rub / agg.minutes).toFixed(2) : null,
        }))
        .sort((a, b) => Number(b.rub) - Number(a.rub));

    return {
      dateFrom: dateFromIso,
      dateTo: dateToIso,
      entryStatus,
      totals,
      nomenclatureGroups,
      orderGroups,
      operationLines,
      salaryOperationBreakdown,
      warnings: Array.from(warnings).sort(),
    };
  }

  /**
   * Разбивает окладную часть периода на «рабочую» и «простой».
   *
   *   - рабочая часть = Σ разнесённого оклада по паспортам
   *     (= Σ учтённых минут × ставка); это реально потраченное на
   *     изготовление время окладников;
   *   - простой = Σ max(0, 480 − учтённые минуты) × ставка по окладникам,
   *     у которых за этот день есть `SalaryEntry` (был на смене).
   *
   * Формула простоя — та же, что в дневном отчёте
   * (`CostsService.getProductionCost`, шаги 7–8): держим обе реализации в
   * синхроне. `trackedMinutesByEmpDay` берём из уже посчитанного разноса,
   * чтобы не гонять апортионмент второй раз.
   */
  private async computeSalarySplit(
    from: Date,
    to: Date,
    rubByPassport: Map<string, number>,
    trackedMinutesByEmpDay: Map<string, number>,
  ): Promise<{
    workingRub: number;
    workingMinutes: number;
    idleRub: number;
    idleMinutes: number;
  }> {
    let workingRub = 0;
    for (const v of rubByPassport.values()) workingRub += v;
    let workingMinutes = 0;
    for (const m of trackedMinutesByEmpDay.values()) workingMinutes += m;

    // Окладники, у кого за день есть `SalaryEntry` — «был на смене»
    // (ровно этот источник использует CostsService, см. ADR-0021).
    const salaryEntries = await this.prisma.salaryEntry.findMany({
      where: { date: { gte: from, lte: to } },
      select: { employeeId: true, date: true },
    });
    if (salaryEntries.length === 0) {
      return {
        workingRub,
        workingMinutes: round1Number(workingMinutes),
        idleRub: 0,
        idleMinutes: 0,
      };
    }

    const employeeIds = Array.from(
      new Set(salaryEntries.map((s) => s.employeeId)),
    );
    const employees = await this.prisma.employee.findMany({
      where: { id: { in: employeeIds } },
      select: {
        id: true,
        compensationType: true,
        salaryRateMode: true,
        salaryPerHour: true,
        salaryPerMonth: true,
      },
    });
    // Ставка ₽/час — тем же способом, что и разнос рабочего времени в
    // этом же отчёте (`PassportRealCostService.apportionSalary`):
    // `effectiveHourlyRateWithNorm` знает про `SalaryRateMode.MONTHLY`,
    // где ставка = оклад за месяц ÷ норма часов.
    //
    // Раньше здесь брали `salaryPerHour` напрямую. У месячника это поле
    // пустое (`requiresHourlyRate` его не требует), ставка выходила
    // нулевой, и он выпадал из простоя и по деньгам, и по минутам — при
    // том что рабочая часть по нему считалась. Отчёт противоречил сам
    // себе: время разнесено, а простоя как будто нет.
    const normHours = await resolveMonthNormHours(this.prisma, from);
    const minuteRate = new Map<string, number>();
    for (const e of employees) {
      const perHourDec = effectiveHourlyRateWithNorm(e, normHours);
      const perHour = perHourDec ? Number(perHourDec) : 0;
      const perMinute = perHour > 0 ? perHour / 60 : 0;
      if (perMinute > 0 && isSalaryEligible(e.compensationType)) {
        minuteRate.set(e.id, perMinute);
      }
    }

    // Уникальные пары «сотрудник × день на смене».
    const onShift = new Set<string>();
    for (const s of salaryEntries) {
      onShift.add(`${s.employeeId}|${toDateKey(s.date)}`);
    }

    let idleMinutes = 0;
    let idleRub = 0;
    for (const key of onShift) {
      const sep = key.lastIndexOf('|');
      const employeeId = key.slice(0, sep);
      const rate = minuteRate.get(employeeId) ?? 0;
      if (rate <= 0) continue;
      const tracked = trackedMinutesByEmpDay.get(key) ?? 0;
      const idle = Math.max(0, SHIFT_MINUTES - tracked);
      idleMinutes += idle;
      idleRub += idle * rate;
    }

    return {
      workingRub,
      workingMinutes: round1Number(workingMinutes),
      idleRub,
      idleMinutes: round1Number(idleMinutes),
    };
  }

  /**
   * Справочники для выпадающих фильтров отчёта (лекало / заказ / клиент /
   * сотрудник / операция). Лёгкие проекции `id + label`, read-only.
   * Заказы ограничиваем последними 1000 (для combobox с клиентским
   * поиском этого с запасом; самые свежие — вверху).
   */
  async getFilterOptions(): Promise<ProductionCostFilterOptionsDto> {
    const [patterns, clients, employees, orders, operations] =
      await Promise.all([
        this.prisma.patternItem.findMany({
          select: { id: true, name: true, article: true },
          orderBy: { name: 'asc' },
        }),
        this.prisma.client.findMany({
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        }),
        this.prisma.employee.findMany({
          select: { id: true, fullName: true },
          orderBy: { fullName: 'asc' },
        }),
        this.prisma.order.findMany({
          select: {
            id: true,
            number: true,
            client: { select: { name: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: 1000,
        }),
        this.prisma.operation.findMany({
          select: { id: true, name: true, code: true },
          orderBy: { name: 'asc' },
        }),
      ]);

    return {
      patterns: patterns.map((p) => ({
        id: p.id,
        label: p.name ?? '—',
        sublabel: p.article ?? null,
      })),
      orders: orders.map((o) => ({
        id: o.id,
        label: o.number,
        sublabel: o.client?.name ?? null,
      })),
      clients: clients.map((c) => ({ id: c.id, label: c.name })),
      employees: employees.map((e) => ({ id: e.id, label: e.fullName })),
      operations: operations.map((o) => ({
        id: o.id,
        label: o.name,
        sublabel: o.code ?? null,
      })),
    };
  }
}

// =============================================================================
// helpers
// =============================================================================

function passportFilterForReleased(
  query: ProductionCostV2Query,
): Prisma.PassportWhereInput | undefined {
  const where: Prisma.PassportWhereInput = {};
  if (query.orderId) where.orderId = query.orderId;
  if (query.clientId || query.patternItemId) {
    where.order = {};
    if (query.clientId) where.order.clientId = query.clientId;
    if (query.patternItemId)
      where.order.patternItemId = query.patternItemId;
  }
  return Object.keys(where).length > 0 ? where : undefined;
}

type EntryRow = Prisma.OperationEntryGetPayload<{
  include: {
    operation: { select: { id: true; name: true; category: true } };
    employee: { select: { id: true; fullName: true } };
    passport: {
      select: {
        id: true;
        number: true;
        sizeId: true;
        color: true;
        order: {
          select: {
            id: true;
            number: true;
            color: true;
            clientId: true;
            patternItemId: true;
            patternNameSnapshot: true;
            patternArticleSnapshot: true;
            patternPreviewSnapshotUrl: true;
            client: { select: { id: true; name: true } };
            patternItem: {
              select: {
                id: true;
                name: true;
                article: true;
                previewImageUrl: true;
                category: { select: { id: true; name: true } };
              };
            };
          };
        };
        size: { select: { id: true; code: true } };
      };
    };
  };
}>;

function mapOperationEntryToLine(
  e: EntryRow,
): ProductionCostOperationLineDto {
  const order = e.passport?.order;
  const dateBase = e.approvedAt ?? e.createdAt;
  const qty = e.qty;
  const amount = new Prisma.Decimal(e.amount);
  const ratePerUnit = new Prisma.Decimal(e.ratePerUnit);
  const unitCost =
    qty > 0 ? amount.div(new Prisma.Decimal(qty)) : null;
  const nomenclatureName =
    order?.patternNameSnapshot ?? order?.patternItem?.name ?? null;
  const nomenclatureArticle =
    order?.patternArticleSnapshot ?? order?.patternItem?.article ?? null;

  const line: ProductionCostOperationLineDto = {
    operationEntryId: e.id,
    date: dateBase.toISOString(),
    orderId: order?.id ?? '',
    orderNumber: order?.number ?? '—',
    clientName: order?.client?.name ?? null,
    patternItemId: order?.patternItemId ?? null,
    nomenclatureName,
    nomenclatureArticle,
    sizeId: e.passport?.sizeId ?? null,
    sizeCode: e.passport?.size?.code ?? '—',
    color: e.passport?.color ?? order?.color ?? null,
    operationId: e.operationId,
    operationName: e.operation?.name ?? '—',
    operationCategory: e.operation?.category ?? 'OTHER',
    employeeId: e.employeeId,
    employeeName: e.employee?.fullName ?? '—',
    qty,
    ratePerUnit: ratePerUnit.toFixed(2),
    amount: amount.toFixed(2),
    unitCost: unitCost ? round2(unitCost).toFixed(2) : null,
    status: e.status,
    sourceEventType: e.sourceEventType,
    approvalMode: e.approvalMode,
  };

  // Optional technical: passport id/number — нужны для будущего
  // drill-down и отладки. UI основной таблицы их **не показывает**
  // как колонку «Паспорт».
  if (e.passport?.id) line.passportId = e.passport.id;
  if (e.passport?.number) line.passportNumber = e.passport.number;
  return line;
}

function nomenclatureKeyFor(meta: {
  patternItemId: string | null;
  patternNameSnapshot: string | null;
  patternArticleSnapshot: string | null;
  patternItemName: string | null;
  patternItemArticle: string | null;
}): string {
  if (meta.patternItemId) return `pattern:${meta.patternItemId}`;
  const name = meta.patternNameSnapshot ?? meta.patternItemName ?? '';
  const article =
    meta.patternArticleSnapshot ?? meta.patternItemArticle ?? '';
  if (name || article) return `legacy:${name}|${article}`;
  return 'unknown';
}

type EstimateLineLite = {
  kind: string;
  lineTotalRub: Prisma.Decimal;
  quotedCurrency: string;
};

function sumEstimateLinesByKind(lines: EstimateLineLite[]): {
  MATERIAL: Prisma.Decimal;
  HARDWARE: Prisma.Decimal;
  APPLICATION: Prisma.Decimal;
  OTHER: Prisma.Decimal;
} {
  const result = {
    MATERIAL: new Prisma.Decimal(0),
    HARDWARE: new Prisma.Decimal(0),
    APPLICATION: new Prisma.Decimal(0),
    OTHER: new Prisma.Decimal(0),
  };
  for (const l of lines) {
    const kind = l.kind as keyof typeof result;
    const amount = new Prisma.Decimal(l.lineTotalRub);
    if (kind === 'MATERIAL') result.MATERIAL = result.MATERIAL.add(amount);
    else if (kind === 'HARDWARE')
      result.HARDWARE = result.HARDWARE.add(amount);
    else if (kind === 'APPLICATION')
      result.APPLICATION = result.APPLICATION.add(amount);
    else result.OTHER = result.OTHER.add(amount);
  }
  return result;
}

function computeTotals(
  groups: ProductionCostNomenclatureGroupDto[],
  salarySplit: {
    workingRub: number;
    workingMinutes: number;
    idleRub: number;
    idleMinutes: number;
  },
): ProductionCostTotalsDto {
  let releasedQty = 0;
  let passportsCount = 0;
  let ordersCount = 0;
  let operationEntriesCount = 0;
  let revenueRub = new Prisma.Decimal(0);
  let materialCostRub = new Prisma.Decimal(0);
  let hardwareCostRub = new Prisma.Decimal(0);
  let applicationCostRub = new Prisma.Decimal(0);
  let operationPieceworkCostRub = new Prisma.Decimal(0);
  let salaryAllocatedCostRub = new Prisma.Decimal(0);
  let otherCostRub = new Prisma.Decimal(0);

  for (const g of groups) {
    releasedQty += g.releasedQty;
    passportsCount += g.passportsCount;
    ordersCount += g.ordersCount;
    operationEntriesCount += g.operationEntriesCount;
    revenueRub = revenueRub.add(new Prisma.Decimal(g.revenueRub));
    materialCostRub = materialCostRub.add(
      new Prisma.Decimal(g.materialCostRub),
    );
    hardwareCostRub = hardwareCostRub.add(
      new Prisma.Decimal(g.hardwareCostRub),
    );
    applicationCostRub = applicationCostRub.add(
      new Prisma.Decimal(g.applicationCostRub),
    );
    operationPieceworkCostRub = operationPieceworkCostRub.add(
      new Prisma.Decimal(g.operationPieceworkCostRub),
    );
    salaryAllocatedCostRub = salaryAllocatedCostRub.add(
      new Prisma.Decimal(g.salaryAllocatedCostRub),
    );
    otherCostRub = otherCostRub.add(new Prisma.Decimal(g.otherCostRub));
  }
  const totalCostRub = round2(
    materialCostRub
      .add(hardwareCostRub)
      .add(applicationCostRub)
      .add(operationPieceworkCostRub)
      .add(salaryAllocatedCostRub)
      .add(otherCostRub),
  );
  const unitCostRub =
    releasedQty > 0
      ? round2(totalCostRub.div(new Prisma.Decimal(releasedQty)))
      : null;
  const marginRub = round2(round2(revenueRub).sub(totalCostRub));
  const marginPercent = revenueRub.greaterThan(0)
    ? round2(marginRub.div(revenueRub).mul(100))
    : null;

  return {
    releasedQty,
    passportsCount,
    ordersCount,
    operationEntriesCount,
    revenueRub: round2(revenueRub).toFixed(2),
    materialCostRub: round2(materialCostRub).toFixed(2),
    hardwareCostRub: round2(hardwareCostRub).toFixed(2),
    applicationCostRub: round2(applicationCostRub).toFixed(2),
    operationPieceworkCostRub: round2(operationPieceworkCostRub).toFixed(2),
    salaryAllocatedCostRub: round2(salaryAllocatedCostRub).toFixed(2),
    otherCostRub: round2(otherCostRub).toFixed(2),
    totalCostRub: totalCostRub.toFixed(2),
    unitCostRub: unitCostRub ? unitCostRub.toFixed(2) : null,
    marginRub: marginRub.toFixed(2),
    marginPercent: marginPercent ? marginPercent.toFixed(2) : null,
    salaryWorkingCostRub: num2(salarySplit.workingRub),
    salaryWorkingMinutes: salarySplit.workingMinutes,
    idleSalaryCostRub: num2(salarySplit.idleRub),
    idleSalaryMinutes: salarySplit.idleMinutes,
  };
}

function round2(d: Prisma.Decimal): Prisma.Decimal {
  return d.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

function num2(n: number): string {
  return round2(new Prisma.Decimal(Number.isFinite(n) ? n : 0)).toFixed(2);
}

function round1Number(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : 0;
}

// ---------------------------------------------------------------------------
// Объединённая матрица «операции · сотрудники · размеры»
// ---------------------------------------------------------------------------

type MatrixCellAcc = {
  sizeId: string | null;
  sizeCode: string;
  qty: number;
  amount: Prisma.Decimal;
};
type MatrixPieceEmpAcc = {
  employeeName: string;
  qty: number;
  amount: Prisma.Decimal;
  bySize: Map<string, MatrixCellAcc>;
};
type MatrixPieceOpAcc = {
  operationName: string;
  operationCategory: string;
  qty: number;
  amount: Prisma.Decimal;
  bySize: Map<string, MatrixCellAcc>;
  byEmp: Map<string, MatrixPieceEmpAcc>;
};
type MatrixSalaryCellAcc = {
  sizeId: string | null;
  sizeCode: string;
  minutes: number;
  rub: number;
};
type MatrixSalaryEmpAcc = {
  employeeName: string;
  minutes: number;
  rub: number;
  bySize: Map<string, MatrixSalaryCellAcc>;
};
type MatrixSalaryOpAcc = {
  operationName: string;
  operationCategory: string;
  minutes: number;
  rub: number;
  bySize: Map<string, MatrixSalaryCellAcc>;
  byEmp: Map<string, MatrixSalaryEmpAcc>;
};
type NomMatrixAcc = {
  pieceOps: Map<string, MatrixPieceOpAcc>;
  salaryOps: Map<string, MatrixSalaryOpAcc>;
  sizeMeta: Map<string, { sizeId: string | null; sizeCode: string }>;
};

type NomSizeAcc = {
  sizeId: string | null;
  sizeCode: string;
  releasedQty: number;
  operationCostRub: Prisma.Decimal;
};

/**
 * Сворачивает аккумулятор матрицы (`NomMatrixAcc`) + выпуск по размерам
 * (`sizeByKey`) в DTO: упорядоченные колонки-размеры и строки-операции
 * (сдельные — с сотрудниками-подстроками, затем окладные). Колонки =
 * объединение размеров, встреченных в операциях и в выпуске; порядок —
 * по `sizeCode`.
 */
function buildOperationMatrix(
  m: NomMatrixAcc | undefined,
  sizeByKey: Map<string, NomSizeAcc>,
): {
  sizeColumns: ProductionCostMatrixSizeColumnDto[];
  operationMatrix: ProductionCostMatrixOperationRowDto[];
} {
  const sizeKeys = new Map<string, { sizeId: string | null; sizeCode: string }>();
  if (m) for (const [k, v] of m.sizeMeta) sizeKeys.set(k, v);
  for (const [k, v] of sizeByKey) {
    if (!sizeKeys.has(k))
      sizeKeys.set(k, { sizeId: v.sizeId, sizeCode: v.sizeCode });
  }
  const ordered = Array.from(sizeKeys.entries())
    .map(([key, v]) => ({
      key,
      sizeId: v.sizeId,
      sizeCode: v.sizeCode,
      releasedQty: sizeByKey.get(key)?.releasedQty ?? 0,
    }))
    .sort((a, b) => a.sizeCode.localeCompare(b.sizeCode));

  const sizeColumns: ProductionCostMatrixSizeColumnDto[] = ordered.map((s) => ({
    sizeId: s.sizeId,
    sizeCode: s.sizeCode,
    releasedQty: s.releasedQty,
  }));

  const pieceCells = (
    bySize: Map<string, MatrixCellAcc>,
  ): ProductionCostMatrixCellDto[] =>
    ordered.map((s) => {
      const c = bySize.get(s.key);
      return {
        sizeId: s.sizeId,
        sizeCode: s.sizeCode,
        qty: c?.qty ?? 0,
        rub: c ? round2(c.amount).toFixed(2) : '0.00',
      };
    });
  const salaryCells = (
    bySize: Map<string, MatrixSalaryCellAcc>,
  ): ProductionCostMatrixCellDto[] =>
    ordered.map((s) => {
      const c = bySize.get(s.key);
      return {
        sizeId: s.sizeId,
        sizeCode: s.sizeCode,
        qty: 0,
        rub: c ? num2(c.rub) : '0.00',
      };
    });

  const operationMatrix: ProductionCostMatrixOperationRowDto[] = [];
  if (m) {
    const pieceRows = Array.from(m.pieceOps.entries())
      .map(([opId, op]) => {
        const employees: ProductionCostMatrixEmployeeRowDto[] = Array.from(
          op.byEmp.entries(),
        )
          .map(([empId, emp]) => ({
            employeeId: empId,
            employeeName: emp.employeeName,
            qty: emp.qty,
            rub: round2(emp.amount).toFixed(2),
            unitCostAvg:
              emp.qty > 0
                ? round2(emp.amount.div(new Prisma.Decimal(emp.qty))).toFixed(2)
                : null,
            minutes: 0,
            cells: pieceCells(emp.bySize),
          }))
          .sort((a, b) => a.employeeName.localeCompare(b.employeeName));
        return {
          operationId: opId,
          operationName: op.operationName,
          operationCategory: op.operationCategory,
          kind: 'PIECEWORK' as const,
          qty: op.qty,
          rub: round2(op.amount).toFixed(2),
          unitCostAvg:
            op.qty > 0
              ? round2(op.amount.div(new Prisma.Decimal(op.qty))).toFixed(2)
              : null,
          minutes: 0,
          cells: pieceCells(op.bySize),
          employees,
        };
      })
      .sort((a, b) => a.operationName.localeCompare(b.operationName));

    const salaryRows = Array.from(m.salaryOps.entries())
      .map(([opId, op]) => {
        const employees: ProductionCostMatrixEmployeeRowDto[] = Array.from(
          op.byEmp.entries(),
        )
          .map(([empId, emp]) => ({
            employeeId: empId,
            employeeName: emp.employeeName,
            qty: 0,
            rub: num2(emp.rub),
            unitCostAvg: null,
            minutes: round1Number(emp.minutes),
            cells: salaryCells(emp.bySize),
          }))
          .sort((a, b) => a.employeeName.localeCompare(b.employeeName));
        return {
          operationId: opId,
          operationName: op.operationName,
          operationCategory: op.operationCategory,
          kind: 'SALARY' as const,
          qty: 0,
          rub: num2(op.rub),
          unitCostAvg: null,
          minutes: round1Number(op.minutes),
          cells: salaryCells(op.bySize),
          employees,
        };
      })
      .sort((a, b) => a.operationName.localeCompare(b.operationName));

    operationMatrix.push(...pieceRows, ...salaryRows);
  }

  return { sizeColumns, operationMatrix };
}

function startOfUtcDay(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
}

function endOfUtcDay(d: Date): Date {
  return new Date(
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate(),
      23,
      59,
      59,
      999,
    ),
  );
}

function toDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function resolvePeriod(query: ProductionCostV2Query): {
  from: Date;
  to: Date;
  dateFromIso: string;
  dateToIso: string;
} {
  const now = new Date();
  const defaultTo = startOfUtcDay(now);
  const defaultFrom = new Date(defaultTo);
  defaultFrom.setUTCDate(defaultFrom.getUTCDate() - 29);
  const fromDay = query.dateFrom
    ? startOfUtcDay(new Date(`${query.dateFrom}T00:00:00Z`))
    : defaultFrom;
  const toDay = query.dateTo
    ? startOfUtcDay(new Date(`${query.dateTo}T00:00:00Z`))
    : defaultTo;
  const [lo, hi] =
    fromDay.getTime() <= toDay.getTime() ? [fromDay, toDay] : [toDay, fromDay];
  return {
    from: lo,
    to: endOfUtcDay(hi),
    dateFromIso: toDateKey(lo),
    dateToIso: toDateKey(hi),
  };
}

// Unused export marker — keeps the SOURCE_LABELS reachable for tooling /
// downstream UI imports without affecting tree-shake.
void PRODUCTION_COST_MATERIAL_SOURCE_LABELS;
