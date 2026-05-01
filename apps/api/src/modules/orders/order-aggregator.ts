import type { OrderItem, Passport, Size } from '@prisma/client';
import { PassportStatus } from '@prisma/client';
import type {
  OrderSizeBreakdownRow,
  OrderSummary,
} from '@sewing/shared/orders';

/**
 * Серверный aggregation layer для заказа.
 *
 * Шаг 4 умел только план. На Шаге 5 подключили **факт раскроя** из
 * паспортов: `qtyCutFact` по размеру = `Σ passport.qtyCut` по тем
 * паспортам этого заказа, у которых статус не `CANCELLED`.
 *
 * Шаг 7 добавляет **брак**: `qtyDefect` по размеру = `Σ passport.qtyDefect`
 * по живым паспортам этого размера. Денормализованные `qtyDefect/qtyGood`
 * лежат в самом паспорте — их обновляет `QcService.recordDefect()` в
 * одной транзакции с записью `PassportDefect` и `PassportEvent`.
 * См. `docs/domain.md §13` и `docs/erd.md §2.17`.
 *
 * Шаг 8 добавляет **выпуск**: `qtyFinished` по размеру = `Σ passport.qtyGood`
 * по паспортам этого размера со статусом `PACKED`. Источник истины —
 * `Passport.status` и `Passport.qtyGood`, которые `PackingService`
 * атомарно проставляет при добавлении паспорта в коробку
 * (см. `docs/flows.md §F7` и ADR-0011).
 *
 * Остальные факт-показатели (`qtyInSewing`, `qtyQc`, `qtyWto`,
 * `qtyPacking`) пока остаются нулями — раздельный учёт «в шитье / в ОТК /
 * в ВТО / в упаковке» появится после ввода аналитики по событиям
 * (`PassportEvent`) и/или snapshot-витрины. На MVP шаг 8 ограничиваемся
 * терминальным `qtyFinished`.
 */

type SizeLike = Pick<Size, 'id' | 'code' | 'sortOrder'>;
type OrderItemLike = Pick<OrderItem, 'sizeId' | 'qtyPlan'>;
type PassportLike = Pick<
  Passport,
  'sizeId' | 'qtyCut' | 'qtyDefect' | 'qtyGood' | 'status'
>;

export interface OrderAggregationInput {
  items: OrderItemLike[];
  sizes: SizeLike[];
  passports: PassportLike[];
}

export interface OrderAggregationResult {
  summary: OrderSummary;
  sizeBreakdown: OrderSizeBreakdownRow[];
}

export function aggregateOrder(
  input: OrderAggregationInput,
): OrderAggregationResult {
  const sizeById = new Map<string, SizeLike>();
  for (const s of input.sizes) sizeById.set(s.id, s);

  const planBySize = new Map<string, number>();
  for (const it of input.items) {
    planBySize.set(it.sizeId, (planBySize.get(it.sizeId) ?? 0) + it.qtyPlan);
  }

  const cutBySize = new Map<string, number>();
  const defectBySize = new Map<string, number>();
  const finishedBySize = new Map<string, number>();
  for (const p of input.passports) {
    if (p.status === PassportStatus.CANCELLED) continue;
    cutBySize.set(p.sizeId, (cutBySize.get(p.sizeId) ?? 0) + p.qtyCut);
    defectBySize.set(p.sizeId, (defectBySize.get(p.sizeId) ?? 0) + p.qtyDefect);
    if (p.status === PassportStatus.PACKED) {
      finishedBySize.set(
        p.sizeId,
        (finishedBySize.get(p.sizeId) ?? 0) + p.qtyGood,
      );
    }
  }

  const rows: OrderSizeBreakdownRow[] = [];
  for (const [sizeId, qtyPlan] of planBySize) {
    const s = sizeById.get(sizeId);
    const qtyCutFact = cutBySize.get(sizeId) ?? 0;
    const qtyInSewing = 0;
    const qtyQc = 0;
    const qtyWto = 0;
    const qtyPacking = 0;
    const qtyFinished = finishedBySize.get(sizeId) ?? 0;
    const qtyDefect = defectBySize.get(sizeId) ?? 0;
    rows.push({
      sizeId,
      sizeCode: s?.code ?? '—',
      sizeSortOrder: s?.sortOrder ?? Number.MAX_SAFE_INTEGER,
      qtyPlan,
      qtyCutFact,
      qtyInSewing,
      qtyQc,
      qtyWto,
      qtyPacking,
      qtyFinished,
      qtyDefect,
      qtyRemaining: Math.max(qtyPlan - qtyCutFact, 0),
      qtyDelta: qtyCutFact - qtyPlan,
    });
  }
  rows.sort((a, b) => a.sizeSortOrder - b.sizeSortOrder);

  const summary: OrderSummary = rows.reduce<OrderSummary>(
    (acc, r) => {
      acc.qtyPlanTotal += r.qtyPlan;
      acc.qtyCutFactTotal += r.qtyCutFact;
      acc.qtyInSewingTotal += r.qtyInSewing;
      acc.qtyQcTotal += r.qtyQc;
      acc.qtyWtoTotal += r.qtyWto;
      acc.qtyPackingTotal += r.qtyPacking;
      acc.qtyFinishedTotal += r.qtyFinished;
      acc.qtyDefectTotal += r.qtyDefect;
      return acc;
    },
    {
      qtyPlanTotal: 0,
      qtyCutFactTotal: 0,
      qtyInSewingTotal: 0,
      qtyQcTotal: 0,
      qtyWtoTotal: 0,
      qtyPackingTotal: 0,
      qtyFinishedTotal: 0,
      qtyDefectTotal: 0,
      qtyDeltaTotal: 0,
    },
  );
  summary.qtyDeltaTotal = summary.qtyCutFactTotal - summary.qtyPlanTotal;

  return { summary, sizeBreakdown: rows };
}
