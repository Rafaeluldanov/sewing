/**
 * Норма времени операции на ОДНО изделие — для нормативной ветки разноса
 * оклада (решение владельца 14.09.2026: там, где хронометража нет —
 * ОТК, ВТО, упаковка, — работа окладника = норма × выполненный объём).
 *
 * Правило чтения — то же, что у плана в документе заказа
 * (`OrderProductionDocumentService.buildOperations`) и у плановой
 * себестоимости (`OrderOperationPlanService`), чтобы план и факт по
 * окладной операции считались от одной нормы:
 *
 *   - `timeNormMode = FIXED`   → `OrderRouteStep.timeNormSecOverride`
 *                                 ?? `Operation.timeNormSec`;
 *   - `timeNormMode = BY_SIZE` → `OrderRouteStepSizeOverride.seconds`
 *                                 ?? `OperationTimeNormBySize.seconds`
 *                                 по размеру паспорта.
 *
 * Шаг заказа — первый по `index` с этой операцией (повтор операции в
 * маршруте нормы не меняет). `null` — норма не задана: вызывающий код
 * обязан не считать это нулём молча, а поднять предупреждение (иначе
 * незаполненный справочник читался бы как «ОТК бесплатна»).
 */
import type { PrismaService } from '../../prisma/prisma.service.js';

export interface TimeNormOperation {
  id: string;
  code: string;
  name: string;
  timeNormMode: string;
  timeNormSec: number | null;
  timeNormsBySize: { sizeId: string; seconds: number }[];
}

export interface TimeNormOrderStep {
  timeNormSecOverride: number | null;
  sizeOverrides: { sizeId: string; seconds: number | null }[];
}

/** Секунды на изделие или `null`, если норма не задана. */
export function resolveTimeNormSec(
  op: TimeNormOperation,
  step: TimeNormOrderStep | null,
  sizeId: string | null,
): number | null {
  if (op.timeNormMode === 'FIXED') {
    const sec = step?.timeNormSecOverride ?? op.timeNormSec ?? null;
    return sec != null && sec > 0 ? sec : null;
  }
  if (sizeId === null) return null;
  const ov = step?.sizeOverrides.find((o) => o.sizeId === sizeId)?.seconds;
  if (ov != null && ov > 0) return ov;
  const base = op.timeNormsBySize.find((t) => t.sizeId === sizeId)?.seconds;
  return base != null && base > 0 ? base : null;
}

export interface TimeNormResolver {
  /** Секунды на изделие или `null` (норма не задана). */
  secondsFor(operationId: string, orderId: string | null, sizeId: string | null): number | null;
  /** Подпись операции для предупреждений/строк. */
  operation(operationId: string): TimeNormOperation | null;
}

/**
 * Загружает нормы операций и переопределения по заказам одним махом
 * (две выборки) и отдаёт резолвер. `pairs` — какие (операция, заказ)
 * понадобятся; заказы без снимка маршрута читаются по норме операции.
 */
export async function loadTimeNormResolver(
  prisma: PrismaService,
  pairs: { operationId: string; orderId: string | null }[],
): Promise<TimeNormResolver> {
  const operationIds = Array.from(new Set(pairs.map((p) => p.operationId)));
  const orderIds = Array.from(
    new Set(pairs.map((p) => p.orderId).filter((x): x is string => x !== null)),
  );
  const [ops, steps] = await Promise.all([
    operationIds.length === 0
      ? Promise.resolve([])
      : prisma.operation.findMany({
          where: { id: { in: operationIds } },
          select: {
            id: true,
            code: true,
            name: true,
            timeNormMode: true,
            timeNormSec: true,
            timeNormsBySize: { select: { sizeId: true, seconds: true } },
          },
        }),
    orderIds.length === 0 || operationIds.length === 0
      ? Promise.resolve([])
      : prisma.orderRouteStep.findMany({
          where: { orderId: { in: orderIds }, operationId: { in: operationIds } },
          orderBy: { index: 'asc' },
          select: {
            orderId: true,
            operationId: true,
            timeNormSecOverride: true,
            sizeOverrides: { select: { sizeId: true, seconds: true } },
          },
        }),
  ]);
  const opById = new Map<string, TimeNormOperation>(ops.map((o) => [o.id, o]));
  // Первый шаг по index на пару (orderId, operationId).
  const stepByKey = new Map<string, TimeNormOrderStep>();
  for (const s of steps) {
    const key = `${s.orderId}|${s.operationId}`;
    if (!stepByKey.has(key)) stepByKey.set(key, s);
  }
  return {
    secondsFor(operationId, orderId, sizeId) {
      const op = opById.get(operationId);
      if (!op) return null;
      const step = orderId ? stepByKey.get(`${orderId}|${operationId}`) ?? null : null;
      return resolveTimeNormSec(op, step, sizeId);
    },
    operation(operationId) {
      return opById.get(operationId) ?? null;
    },
  };
}
