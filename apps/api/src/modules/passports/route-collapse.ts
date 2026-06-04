/**
 * Автосворачивание сплит-маршрута распошива (чистая логика, без Prisma).
 *
 * Контекст. Сплит-маршрут (маршрут 02, чёрные футболки) держит распошив
 * параллельной группой из «Распошив рукав» (16) + «Подгиб низа» (0001)
 * (+ «Киперка» 03). Когда у заказа НЕ остаётся ни одного станка, который
 * делает низ ОТДЕЛЬНО — весь низ «переехал» на рукавный станок, — пара
 * {рукав, низ} должна свернуться в одну операцию «Распошив» (04).
 *
 * Сигнал перехода (по согласованию с заказчиком): паспорт, взятый под низ,
 * закрывается на станке, где шьют рукав (рукав-capable оборудование), либо
 * закрывается полным распошивом (04) на таком станке. Статус смены
 * сломавшегося низ-станка значения не имеет.
 *
 * Правило (см. `shouldCollapse`):
 *   collapse  ⟺  был хотя бы один такой переход (crossover)
 *               И сейчас ни один паспорт заказа не делает низ на ВЫДЕЛЕННОМ
 *               низ-станке (т.е. удерживается на низ-операции, а смена
 *               держателя — на станке, не умеющем рукав).
 * Для одного станка низа первый переход сразу сворачивает; для двух —
 * пока второй станок ещё держит низ, `collapse` остаётся false.
 *
 * Вся логика — чистые функции над уже выбранными из БД данными, чтобы
 * покрыть юнит-тестами без живой базы (см. `route-collapse.spec.ts`).
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
 * Идемпотентность: если `mergeOpIds`-шагов в маршруте уже нет (заказ
 * свёрнут), для этой группы вернётся null.
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

/**
 * Удержание паспорта на низ-операции в момент оценки.
 */
export interface HeldLowPassport {
  /** equipmentId открытой смены держателя (null — смены нет/неизвестно). */
  holderEquipmentId: string | null;
}

export interface ShouldCollapseInput {
  plan: CollapsiblePlan;
  /**
   * equipmentId, которые УМЕЮТ принимать (рукав/полный распошив): активные
   * `EquipmentOperation` на receivingOpId или targetOpId.
   */
  receivingEquipmentIds: ReadonlySet<string>;
  /**
   * Закрытия (OPERATION_FINISHED) низ/полного по паспортам заказа:
   * пара (operationId, equipmentId). equipmentId может быть null (старые
   * события без станка — в расчёте перехода игнорируются).
   */
  lowOrFullFinishes: ReadonlyArray<{ operationId: string; equipmentId: string | null }>;
  /** Паспорта заказа, прямо сейчас удерживаемые на низ-операции. */
  heldOnLow: readonly HeldLowPassport[];
}

/**
 * Главный предикат: пора ли сворачивать сплит-маршрут заказа.
 *
 * crossover — был ли хоть один переход «низ закрыт на рукавном станке» (или
 * полный распошив 04 закрыт на таком станке).
 * stillSeparate — держит ли сейчас хоть один паспорт низ на ВЫДЕЛЕННОМ
 * низ-станке (смена держателя не умеет рукав).
 */
export function shouldCollapse(input: ShouldCollapseInput): boolean {
  const { plan, receivingEquipmentIds, lowOrFullFinishes, heldOnLow } = input;
  const dedicated = new Set(plan.dedicatedOpIds);

  const crossover = lowOrFullFinishes.some(
    (f) =>
      f.equipmentId != null &&
      receivingEquipmentIds.has(f.equipmentId) &&
      (dedicated.has(f.operationId) || f.operationId === plan.targetOpId),
  );
  if (!crossover) return false;

  const stillSeparate = heldOnLow.some(
    (h) => h.holderEquipmentId != null && !receivingEquipmentIds.has(h.holderEquipmentId),
  );
  return !stillSeparate;
}

export interface CollapseStepsResult {
  newSteps: RouteStepLite[];
  /** operationId -> новый index (включая mergeOps → index целевого шага). */
  opToNewIndex: Map<string, number>;
  /** Новый index целевого шага (полный распошив). */
  targetIndex: number;
}

/**
 * Строит новый список шагов: убирает merge-шаги (низ+рукав), вставляет один
 * шаг targetOpId на минимальный из освободившихся индексов merge-шагов.
 * Остальные шаги (включая киперку) сохраняют свои индексы — пересчёт
 * сквозной нумерации не нужен (index лишь уникален и задаёт порядок).
 *
 * parallelGroup целевого шага: сохраняется, если в группе остаётся ещё
 * хотя бы один участник (киперка) — тогда «полный распошив» по-прежнему
 * параллелен киперке. Если кроме merge в группе никого не было — группа
 * вырождается, ставим parallelGroup = null (обычный последовательный шаг).
 */
export function buildCollapsedSteps(
  steps: readonly RouteStepLite[],
  plan: CollapsiblePlan,
): CollapseStepsResult {
  const merge = new Set(plan.mergeOpIds);
  const mergeIndexes = steps
    .filter((s) => merge.has(s.operationId))
    .map((s) => s.index);
  const targetIndex = Math.min(...mergeIndexes);

  const survivesGroup = plan.keepOpIds.length > 0;
  const newSteps: RouteStepLite[] = steps
    .filter((s) => !merge.has(s.operationId))
    .map((s) => ({ ...s }));
  newSteps.push({
    index: targetIndex,
    operationId: plan.targetOpId,
    parallelGroup: survivesGroup ? plan.parallelGroup : null,
  });
  newSteps.sort((a, b) => a.index - b.index);

  const opToNewIndex = new Map<string, number>();
  for (const s of newSteps) opToNewIndex.set(s.operationId, s.index);
  // Паспорта, стоящие на низ/рукаве, переезжают на целевой шаг.
  for (const op of plan.mergeOpIds) opToNewIndex.set(op, targetIndex);

  return { newSteps, opToNewIndex, targetIndex };
}

export interface PassportRemapInput {
  currentRouteStepIndex: number | null;
  currentOperationId: string | null;
}

export interface PassportRemapResult {
  currentRouteStepIndex: number;
  /** Новая текущая операция (для merge-паспортов = targetOpId), иначе прежняя. */
  currentOperationId: string | null;
}

/**
 * Пересчитывает `currentRouteStepIndex`/`currentOperationId` паспорта после
 * сворачивания. Возвращает null, если паспорт трогать не нужно (нет индекса
 * маршрута, либо его операцию не удалось сопоставить новому шагу).
 */
export function remapPassport(
  passport: PassportRemapInput,
  oldStepsByIndex: ReadonlyMap<number, RouteStepLite>,
  collapse: CollapseStepsResult,
  plan: CollapsiblePlan,
): PassportRemapResult | null {
  if (passport.currentRouteStepIndex == null) return null;
  const opId =
    passport.currentOperationId ??
    oldStepsByIndex.get(passport.currentRouteStepIndex)?.operationId ??
    null;
  if (opId == null) return null;
  const newIndex = collapse.opToNewIndex.get(opId);
  if (newIndex == null) return null; // операции нет в новом маршруте — не трогаем
  const isMerge = plan.mergeOpIds.includes(opId);
  return {
    currentRouteStepIndex: newIndex,
    currentOperationId: isMerge ? plan.targetOpId : passport.currentOperationId,
  };
}
