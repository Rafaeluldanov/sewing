import { Prisma } from '@prisma/client';

/**
 * Критерий «весь тираж заказа выпущен» — общий для доски помощника
 * раскройщика (`CuttingTasksService.listReadyForRelease`, метка
 * «Завершено») и гейта авто-завершения заказа при упаковке
 * (`PackingService`). Держим алгоритм в одном месте, чтобы две ветки
 * не разъехались (см. историю consistency-аудитов: снимок, посчитанный
 * двумя путями, рано или поздно расходится).
 *
 * Паспорта заказа создаются ИНКРЕМЕНТАЛЬНО — порулонно/пораскладно
 * (`PassportsService.releaseFromRolls`), поэтому «нет живых паспортов»
 * само по себе НЕ значит «заказ готов»: остаток тиража мог быть ещё не
 * выпущен. Отсюда потребность в явной проверке полноты выпуска.
 */

/**
 * Считает ожидаемые (`totalPairs`) и выпущенные (`releasedPairs`) тройки
 * `(расклад, размер, рулон)` по набору раскладов задачи раскроя.
 *
 * Ожидаемая тройка — размер с `perLayerQty > 0` × рулон с `layers > 0`.
 * Выпущенная — её ключ `layOrdinal:sizeId:rollOrdinal` присутствует в
 * `releasedSet` (собирается из non-CANCELLED паспортов заказа с
 * проставленными `cuttingLayOrdinal` + `rollOrdinal`).
 */
export function countReleasePairs(
  lays: Array<{
    ordinal: number;
    laySizes: Array<{ sizeId: string | null; perLayerQty: number }>;
    rolls: Array<{ ordinal: number; layers: number }>;
  }>,
  releasedSet: Set<string>,
): { totalPairs: number; releasedPairs: number } {
  let totalPairs = 0;
  let releasedPairs = 0;
  for (const lay of lays) {
    const sizes = lay.laySizes.filter((s) => s.sizeId && s.perLayerQty > 0);
    const rolls = lay.rolls.filter((r) => r.layers > 0);
    for (const s of sizes) {
      for (const roll of rolls) {
        totalPairs += 1;
        if (releasedSet.has(`${lay.ordinal}:${s.sizeId}:${roll.ordinal}`)) {
          releasedPairs += 1;
        }
      }
    }
  }
  return { totalPairs, releasedPairs };
}

/**
 * Полностью ли выпущен тираж заказа: у завершённой (`DONE`) задачи
 * раскроя выпущены ВСЕ ожидаемые тройки `(расклад, размер, рулон)`
 * (`releasedPairs >= totalPairs`). Тот же критерий, что `status = 'DONE'`
 * в `listReadyForRelease`.
 *
 * `false`, если задачи раскроя нет, она ещё не `DONE`, или выпущены не
 * все тройки. `db` — `PrismaService` или транзакционный клиент (`tx`):
 * гейт авто-завершения зовёт это внутри транзакции упаковки, атомарно с
 * переводом паспорта в `PACKED`.
 */
export async function isOrderCuttingFullyReleased(
  db: Prisma.TransactionClient,
  orderId: string,
): Promise<boolean> {
  const task = await db.cuttingTask.findUnique({
    where: { orderId },
    select: {
      status: true,
      lays: {
        select: {
          ordinal: true,
          laySizes: { select: { sizeId: true, perLayerQty: true } },
          rolls: { select: { ordinal: true, layers: true } },
        },
      },
    },
  });
  if (!task || task.status !== 'DONE') return false;

  const released = await db.passport.findMany({
    where: {
      orderId,
      status: { not: 'CANCELLED' },
      rollOrdinal: { not: null },
      cuttingLayOrdinal: { not: null },
    },
    select: { sizeId: true, rollOrdinal: true, cuttingLayOrdinal: true },
  });
  const releasedSet = new Set(
    released.map((p) => `${p.cuttingLayOrdinal}:${p.sizeId}:${p.rollOrdinal}`),
  );
  const { totalPairs, releasedPairs } = countReleasePairs(task.lays, releasedSet);
  return totalPairs > 0 && releasedPairs >= totalPairs;
}
