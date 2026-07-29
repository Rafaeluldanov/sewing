/**
 * Чтение действующих нарядов-допусков (`RouteWorkPermit`).
 *
 * Главная идея модели: допуск — это ПРАВИЛО ЗАМЕНЫ, ограниченное одним
 * заказом и сроком. Поэтому он отдаётся ровно в том же виде, что строки
 * `OperationSubstitution` (`{satisfiesOpId, substituteOpId}`), и просто
 * подмешивается к ним во всех местах, где те читаются:
 *
 *   - `PassportsService.evaluateRouteOrder` — маршрутный гейт: операция
 *     под допуском перестаёт быть «вне маршрута» и корректно
 *     позиционирует паспорт на замещаемом шаге;
 *   - `QcService.assertParallelGroupCompleteForQc` — AND-гейт перед ОТК
 *     засчитывает работу, сделанную под допуском;
 *   - расчёт расхождений (`computeRouteDivergences`) — работа под
 *     допуском не считается расхождением.
 *
 * Без подмешивания ВО ВСЕ ТРИ точки допуск был бы бумажкой: швея
 * дошила бы, а паспорт всё равно не закрыл бы шаг «03 КИПЕРКА», и
 * AND-гейт перед ОТК всё равно бы упал — ровно инцидент 28.07.2026,
 * просто неделей позже и с формальным разрешением на руках.
 *
 * Функция, а не сервис: её зовут три модуля (passports, qc,
 * production-board), и тащить ради этого DI-зависимость в каждый —
 * дороже, чем передать `prisma` аргументом. Тот же приём, что у
 * `route-collapse.ts` / `route-mode.ts`.
 */
import type { PrismaClient } from '@prisma/client';

/** Минимальный клиент: подходит и `PrismaService`, и `tx`. */
type Db = Pick<PrismaClient, 'routeWorkPermit' | 'passportEvent'>;

export interface PermitSubstitution {
  satisfiesOpId: string;
  substituteOpId: string;
}

/**
 * Действующие допуски заказа, приведённые к виду правил замены.
 *
 * Допуск действует, если он: не отозван, не просрочен и не исчерпан по
 * лимиту штук. Лимит считается по фактически закрытым под ним изделиям
 * (`OPERATION_FINISHED` на разрешённой операции ПОСЛЕ выдачи допуска,
 * сумма `Passport.qtyGood`) — иначе «лимит 50 штук» ничего не
 * ограничивает и превращается в декорацию.
 *
 * @param now — для тестируемости; по умолчанию текущее время.
 */
export async function loadActivePermitSubstitutions(
  db: Db,
  orderId: string | null,
  now: Date = new Date(),
): Promise<PermitSubstitution[]> {
  if (!orderId) return [];
  const permits = await db.routeWorkPermit.findMany({
    where: {
      orderId,
      revokedAt: null,
      expiresAt: { gt: now },
    },
    select: {
      id: true,
      operationId: true,
      satisfiesStepOperationId: true,
      qtyLimit: true,
      createdAt: true,
    },
  });
  if (permits.length === 0) return [];

  const limited = permits.filter((p) => p.qtyLimit != null);
  const usedByPermit = new Map<string, number>();
  if (limited.length > 0) {
    // Одним запросом на все лимитированные допуски заказа: их единицы,
    // но ходить в БД в цикле по горячему пути issue/scan не хочется.
    const events = await db.passportEvent.findMany({
      where: {
        type: 'OPERATION_FINISHED',
        operationId: { in: limited.map((p) => p.operationId) },
        passport: { orderId },
      },
      select: {
        operationId: true,
        createdAt: true,
        passport: { select: { qtyGood: true } },
      },
    });
    for (const p of limited) {
      const used = events
        .filter(
          (e) => e.operationId === p.operationId && e.createdAt >= p.createdAt,
        )
        .reduce((sum, e) => sum + (e.passport?.qtyGood ?? 0), 0);
      usedByPermit.set(p.id, used);
    }
  }

  return permits
    .filter((p) => {
      if (p.qtyLimit == null) return true;
      return (usedByPermit.get(p.id) ?? 0) < p.qtyLimit;
    })
    .map((p) => ({
      satisfiesOpId: p.satisfiesStepOperationId,
      substituteOpId: p.operationId,
    }));
}
