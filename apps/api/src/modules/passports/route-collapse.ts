/**
 * Распознавание сворачиваемой группы сплит-распошива (чистая логика).
 *
 * Контекст. Сплит-маршрут (маршрут 02, чёрные футболки) держит распошив
 * параллельной группой из «Распошив рукав» (16) + «Подгиб низа» (0001)
 * (+ «Киперка» 03). Пара {рукав, низ} взаимозаменяема с одним полным
 * «Распошивом» (04) через `OperationSubstitution`.
 *
 * Раньше этот модуль ещё и НЕОБРАТИМО переписывал снапшот маршрута
 * (пара → один 04). От этого отказались в пользу адаптивного режима,
 * вычисляемого на лету (Вариант B, см. `route-mode.ts`): снапшот всегда
 * остаётся сплитом. Здесь осталась только распознавалка группы —
 * `findCollapsibleGroup`, — которой пользуется резолвер режима, чтобы
 * понять, какие операции образуют сворачиваемую пару (низ+рукав), кто из
 * них принимающий (рукав), а кто выделенный (низ).
 */

export interface RouteStepLite {
  index: number;
  operationId: string;
  parallelGroup: number | null;
}

export interface SubstitutionLite {
  /** Операция, которую «закрывает» substitute (напр. низ 0001 / рукав 16). */
  satisfiesOpId: string;
  /** Операция-заместитель (полный распошив 04). */
  substituteOpId: string;
  /** Принимающая станция группы (рукав) — её станок продолжает работать. */
  isReceivingStation: boolean;
}

/**
 * Описание сворачиваемой параллельной группы заказа: что с чем сливаем.
 */
export interface CollapsiblePlan {
  parallelGroup: number;
  /** Операции группы, сливаемые в `targetOpId` (низ + рукав). */
  mergeOpIds: string[];
  /** Прочие операции группы, которые остаются как есть (киперка). */
  keepOpIds: string[];
  /** Целевая операция «полный распошив» (04). */
  targetOpId: string;
  /** Принимающая операция группы (рукав 16). */
  receivingOpId: string;
  /** Выделенные операции, чей станок ломается (низ 0001) = merge − receiving. */
  dedicatedOpIds: string[];
}

/**
 * Находит сворачиваемую параллельную группу в snapshot-е маршрута заказа.
 *
 * Группа сворачиваема, если ≥2 её операций имеют ОБЩИЙ `substituteOpId`
 * (это и есть целевая операция T). Те операции = `mergeOpIds`, среди них
 * принимающая (`isReceivingStation`) — рукав. Остальные участники группы
 * остаются (`keepOpIds`).
 *
 * Возвращает null, если у заказа нет такой группы (обычный маршрут).
 */
export function findCollapsibleGroup(
  steps: readonly RouteStepLite[],
  substitutions: readonly SubstitutionLite[],
): CollapsiblePlan | null {
  // operationId -> parallelGroup (только шаги, реально стоящие в маршруте).
  const opToGroup = new Map<string, number>();
  const groupOps = new Map<number, string[]>();
  for (const s of steps) {
    if (s.parallelGroup == null) continue;
    opToGroup.set(s.operationId, s.parallelGroup);
    const arr = groupOps.get(s.parallelGroup) ?? [];
    arr.push(s.operationId);
    groupOps.set(s.parallelGroup, arr);
  }
  if (groupOps.size === 0) return null;

  // substitute target -> список (satisfiesOp, isReceiving) для операций,
  // которые реально стоят в маршруте заказа.
  for (const [group, ops] of groupOps) {
    const opsSet = new Set(ops);
    // target T -> участники группы, у которых есть substitution на T.
    const byTarget = new Map<string, { satisfiesOpId: string; isReceiving: boolean }[]>();
    for (const sub of substitutions) {
      if (!opsSet.has(sub.satisfiesOpId)) continue;
      const arr = byTarget.get(sub.substituteOpId) ?? [];
      arr.push({ satisfiesOpId: sub.satisfiesOpId, isReceiving: sub.isReceivingStation });
      byTarget.set(sub.substituteOpId, arr);
    }
    for (const [targetOpId, members] of byTarget) {
      if (members.length < 2) continue; // нужна пара (низ + рукав)
      const mergeOpIds = members.map((m) => m.satisfiesOpId);
      const receiving = members.find((m) => m.isReceiving);
      if (!receiving) continue; // без явной принимающей станции не сворачиваем
      const keepOpIds = ops.filter((o) => !mergeOpIds.includes(o));
      const dedicatedOpIds = mergeOpIds.filter((o) => o !== receiving.satisfiesOpId);
      if (dedicatedOpIds.length === 0) continue;
      return {
        parallelGroup: group,
        mergeOpIds,
        keepOpIds,
        targetOpId,
        receivingOpId: receiving.satisfiesOpId,
        dedicatedOpIds,
      };
    }
  }
  return null;
}
