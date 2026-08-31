/**
 * Порядок операций «как в маршруте» для экранов, которые показывают
 * движение тиража (чистая логика, без Prisma).
 *
 * Контекст. И «Доска движения тиража» в кабинете мастера
 * (`ProductionBoardService`), и «Экран цеха» (`buildSewingRoute` в
 * `ShopfloorService`) строят колонки/блоки из снимков `OrderRouteStep`,
 * но упорядочивали их ГЛОБАЛЬНЫМ `Operation.sortOrder` из справочника.
 * Справочник же ничего не знает о технологии конкретного заказа:
 * операции, заведённые позже, получили «хвостовые» sortOrder, и на
 * заказе 02-00020 (31.08.2026) доска рисовала колонки в порядке
 *
 *   ОВЕРЛОК(20) → РАСПОШИВ(40) → ОТК(50) → УПАКОВКА(70)
 *   → ВТО ОКЛАД(290) → РАСПОШИВ ГОРЛОВИНЫ(420),
 *
 * тогда как маршрут заказа — ОВЕРЛОК → РАСПОШИВ → ГОРЛОВИНЫ → ОТК →
 * ВТО → УПАКОВКА. Тираж шёл строго по маршруту (проверено по всем 122
 * паспортам: ни одного закрытого позднего шага при незакрытом раннем),
 * но на доске «прыгал» вправо-влево через всю ширину экрана. Мастер
 * читает это как сбой производства и идёт искать несуществующую
 * проблему.
 *
 * Почему топологический порядок, а не минимальный индекс шага. Оба
 * экрана МУЛЬТИЗАКАЗНЫЕ: колонки собираются из маршрутов всех заказов
 * когорты, а индексы шагов разных заказов между собой несопоставимы.
 * Заказ A = [ОВЕРЛОК(1), ОТК(2)], заказ B = [ОВЕРЛОК(1), РАСПОШИВ(2),
 * ГОРЛОВИНЫ(3), ОТК(4)]: сортировка по min-индексу дала бы ОТК(2)
 * ПЕРЕД ГОРЛОВИНАМИ(3) — то есть ровно тот же зигзаг, только по другой
 * причине. Порядок задаётся ОТНОШЕНИЯМИ «A раньше B», взятыми из
 * каждого маршрута отдельно, а не сравнением чисел из разных заказов.
 *
 * Свойства, на которые опираются вызывающие:
 *
 *   1. **Стабильность.** Результат зависит только от входа, порядок
 *      элементов во входном массиве не важен. Для TV-монитора это
 *      обязательное условие: между polling-tick'ами layout не должен
 *      «прыгать» (см. `buildSewingRoute`).
 *   2. **Повторы операций не рвут порядок.** Операция может стоять в
 *      маршруте несколько раз (чередующиеся ОТК/ВТО — см.
 *      `project_route_repeated_operation`). Внутри заказа учитывается
 *      только ПЕРВОЕ вхождение, иначе [ОТК, ВТО, ОТК] дало бы пару
 *      встречных рёбер, то есть цикл на ровном месте.
 *   3. **Устойчивость к противоречивым маршрутам.** Если в одном заказе
 *      A раньше B, а в другом B раньше A (разная технология на разных
 *      моделях — законная ситуация), общего линейного порядка не
 *      существует. Мы НЕ падаем и не выбрасываем колонки: цикл
 *      разрывается по тому же тай-брейку, что и обычная неоднозначность.
 *      Потерять колонку хуже, чем показать две спорные операции в
 *      неидеальном порядке — на потерянной колонке пропадут паспорта.
 *   4. **`Operation.sortOrder` остаётся тай-брейком.** Для операций,
 *      которые маршруты между собой не сравнивают (лежат в разных
 *      заказах и не встречаются вместе), порядок задаёт справочник —
 *      как и раньше.
 */

/** Шаг маршрута, сведённый к минимуму для расчёта порядка. */
export interface RouteOperationOrderStep {
  orderId: string;
  /** `OrderRouteStep.index` — позиция шага ВНУТРИ своего заказа. */
  index: number;
  operationId: string;
  /** `Operation.sortOrder` — тай-брейк для несравнимых операций. */
  sortOrder: number;
  /** Второй тай-брейк (обычно `Operation.code`) — ради детерминизма. */
  tieBreak: string;
}

/**
 * Ранги операций: `operationId` → позиция в общем порядке (0, 1, 2…).
 *
 * Возвращаем именно ранги, а не готовый отсортированный список: у
 * вызывающих разные типы колонок/блоков, им нужно отсортировать СВОИ
 * структуры, а не получить чужие.
 */
export function buildRouteOperationRanks(
  steps: RouteOperationOrderStep[],
): Map<string, number> {
  // Первое вхождение операции в каждом заказе (см. свойство 2).
  const firstIndexByOrder = new Map<string, Map<string, number>>();
  // Тай-брейк-ключ операции: справочный sortOrder + стабильный code.
  const tieByOp = new Map<string, { sortOrder: number; tieBreak: string }>();

  for (const st of steps) {
    let byOp = firstIndexByOrder.get(st.orderId);
    if (!byOp) {
      byOp = new Map();
      firstIndexByOrder.set(st.orderId, byOp);
    }
    const seen = byOp.get(st.operationId);
    if (seen === undefined || st.index < seen) {
      byOp.set(st.operationId, st.index);
    }
    if (!tieByOp.has(st.operationId)) {
      tieByOp.set(st.operationId, {
        sortOrder: st.sortOrder,
        tieBreak: st.tieBreak,
      });
    }
  }

  const ranks = new Map<string, number>();
  if (tieByOp.size === 0) return ranks;

  // Рёбра «A раньше B» — только между СОСЕДНИМИ уникальными операциями
  // маршрута. Транзитивность даёт сам топологический порядок, хранить
  // полный транзитивный замык незачем.
  const next = new Map<string, Set<string>>();
  const inDegree = new Map<string, number>();
  for (const op of tieByOp.keys()) {
    next.set(op, new Set());
    inDegree.set(op, 0);
  }
  for (const byOp of firstIndexByOrder.values()) {
    const chain = [...byOp.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([opId]) => opId);
    for (let i = 1; i < chain.length; i += 1) {
      const from = chain[i - 1]!;
      const to = chain[i]!;
      if (from === to) continue;
      const edges = next.get(from)!;
      if (edges.has(to)) continue;
      edges.add(to);
      inDegree.set(to, (inDegree.get(to) ?? 0) + 1);
    }
  }

  /** Сравнение двух операций, когда маршруты их не упорядочивают. */
  const byTieBreak = (a: string, b: string): number => {
    const ta = tieByOp.get(a)!;
    const tb = tieByOp.get(b)!;
    if (ta.sortOrder !== tb.sortOrder) return ta.sortOrder - tb.sortOrder;
    if (ta.tieBreak !== tb.tieBreak) return ta.tieBreak < tb.tieBreak ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  };

  // Алгоритм Кана. Среди операций, у которых не осталось неудовлетворённых
  // предшественников, берём минимальную по тай-брейку — это и даёт
  // детерминизм (свойство 1) при любой перестановке входа.
  const remaining = new Set(tieByOp.keys());
  let rank = 0;
  while (remaining.size > 0) {
    let pick: string | null = null;
    for (const op of remaining) {
      if ((inDegree.get(op) ?? 0) !== 0) continue;
      if (pick === null || byTieBreak(op, pick) < 0) pick = op;
    }
    if (pick === null) {
      // Цикл (свойство 3): общего порядка нет. Разрываем его на
      // минимальной по тай-брейку операции из оставшихся и продолжаем —
      // все колонки обязаны попасть в результат.
      for (const op of remaining) {
        if (pick === null || byTieBreak(op, pick) < 0) pick = op;
      }
    }
    const chosen = pick!;
    remaining.delete(chosen);
    ranks.set(chosen, rank);
    rank += 1;
    for (const to of next.get(chosen) ?? []) {
      if (!remaining.has(to)) continue;
      inDegree.set(to, (inDegree.get(to) ?? 0) - 1);
    }
  }

  return ranks;
}
