/**
 * Адаптивный режим сплит-распошива (чистая логика, без Prisma).
 *
 * Контекст. Сплит-маршрут (маршрут 02, чёрные футболки) держит распошив
 * параллельной группой {«Распошив рукав» 16, «Подгиб низа» 0001} (+ «Киперка»
 * 03). Раньше пара рукав+низ НЕОБРАТИМО сворачивалась в один «Распошив» (04)
 * через перезапись `OrderRouteStep` (см. `route-collapse.ts`). Это оказалось
 * слишком жёстким: режим должен быть АДАПТИВНЫМ — схлопываться, когда
 * выделенный низ-станок не работает, и раздваиваться обратно, когда его снова
 * заняли.
 *
 * Решение (Вариант B). Снапшот маршрута заказа НЕ трогаем — он всегда несёт
 * сплит-группу {03, 0001, 16}. «Сплит vs схлоп» — это ПРОИЗВОДНАЯ от текущей
 * обстановки, вычисляемая на лету для (1) гейта перехода (уже инвариантен:
 * 04 засчитывает и низ, и рукав через `OperationSubstitution`) и (2) монитора
 * цеха (одна колонка распошива или две). Никакого хранимого/необратимого
 * состояния — кроме ручного override мастера.
 *
 * Правило (см. `modeForOrder`):
 *   AUTO  →  COLLAPSED, когда у заказа есть сворачиваемая группа И прямо
 *            сейчас нет активной смены на ВЫДЕЛЕННОМ низ-станке (станок умеет
 *            низ 0001, но НЕ умеет принимать рукав/полный 16/04). Иначе SPLIT.
 *   FORCE_SPLIT / FORCE_COLLAPSED  →  жёстко, мимо авто-сигнала (страховка
 *            мастера от залипших смен и дребезга).
 *
 * Вся логика — чистые функции над уже выбранными из БД данными, чтобы
 * покрыть юнит-тестами без живой базы (см. `tests/unit/route-mode.test.ts`).
 */
import type { CollapsiblePlan } from './route-collapse';

export type RouteMode = 'SPLIT' | 'COLLAPSED';

/** Зеркалит prisma enum `RouteModeOverride` (поле `Order.routeModeOverride`). */
export type RouteModeOverride = 'AUTO' | 'FORCE_SPLIT' | 'FORCE_COLLAPSED';

/** Активная смена (endedAt=null), сведённая к операции и станку. */
export interface ActiveLowSession {
  operationId: string;
  equipmentId: string;
}

/**
 * Есть ли прямо сейчас активная смена на ВЫДЕЛЕННОМ низ-станке.
 *
 * Выделенный низ-станок = станок, чья активная смена стоит на одной из
 * `dedicatedOpIds` (низ 0001) И который НЕ входит в `receivingEquipmentIds`
 * (не умеет принимать рукав/полный — иначе это универсальная распошивная
 * машина, а не выделенный низ). Универсальный станок, открывший смену на
 * низе, выделенным НЕ считается — он может в любой момент закрыть полный 04.
 */
export function hasDedicatedLowStation(
  sessions: readonly ActiveLowSession[],
  dedicatedOpIds: readonly string[],
  receivingEquipmentIds: ReadonlySet<string>,
): boolean {
  const dedicated = new Set(dedicatedOpIds);
  return sessions.some(
    (s) => dedicated.has(s.operationId) && !receivingEquipmentIds.has(s.equipmentId),
  );
}

export interface RouteModeInput {
  override: RouteModeOverride;
  /**
   * Сворачиваемая группа заказа из `findCollapsibleGroup` (route-collapse.ts),
   * либо null, если у заказа нечего сворачивать (обычный маршрут).
   */
  plan: CollapsiblePlan | null;
  /**
   * Есть ли прямо сейчас активная смена на выделенном низ-станке, относящаяся
   * к этому заказу (v1: занят выделенный низ-станок И у заказа есть незакрытый
   * распошив). Считается в резолвере (см. shopfloor.service).
   */
  dedicatedLowActive: boolean;
}

/**
 * Главный предикат: в каком режиме отображать/трактовать распошив заказа.
 *
 * Для заказа без сворачиваемой группы (`plan === null`) сливать нечего —
 * возвращаем SPLIT («показывать как есть», синоним «не схлопывать»).
 */
export function modeForOrder(input: RouteModeInput): RouteMode {
  switch (input.override) {
    case 'FORCE_SPLIT':
      return 'SPLIT';
    case 'FORCE_COLLAPSED':
      return 'COLLAPSED';
    case 'AUTO':
    default:
      if (!input.plan) return 'SPLIT';
      return input.dedicatedLowActive ? 'SPLIT' : 'COLLAPSED';
  }
}

// ---------------------------------------------------------------------------
// View-трансформ для монитора цеха: слияние колонок распошива у COLLAPSED-
// заказов БЕЗ изменения снапшота маршрута (Вариант B). Снимок маршрута всегда
// остаётся сплитом; на лету для COLLAPSED-заказа пара шагов {низ 0001, рукав
// 16} схлопывается в один синтетический шаг «полный распошив» (04), а паспорта
// заказа, стоящие на низе/рукаве/полном, переезжают на этот общий шаг. Чистая
// функция над уже выбранными данными — тестируется без БД.
// ---------------------------------------------------------------------------

/** Описание слияния для одного заказа (что во что сливать в мониторе). */
export interface CollapseSpec {
  /** Операции, сливаемые в `targetOpId` (низ + рукав). */
  mergeOpIds: string[];
  /** Целевая операция «полный распошив» (04). */
  targetOpId: string;
  /** Имя/порядок целевой операции для колонки монитора. */
  targetName: string;
  targetSortOrder: number;
}

/** Минимальный контракт sewing-шага монитора (см. buildSewingRoute). */
export interface SewingViewStep {
  orderId: string;
  index: number;
  operation: { id: string; name: string; sortOrder: number };
}

/** Минимальный контракт паспорта монитора (поля, которые ремапим). */
export interface SewingViewPassport {
  orderId: string;
  currentRouteStepIndex: number | null;
  currentOperationId: string | null;
  assignedShiftSewingOperationId: string | null;
}

/**
 * Сливает шаги {низ, рукав} → один «полный распошив» и ремапит паспорта для
 * заказов из `collapseByOrder`. Заказы вне карты не трогаются. Целевой индекс
 * шага = САМЫЙ ПОЗДНИЙ из merge-индексов (согласовано с substitution-aware
 * индексацией в evaluateRouteOrder: паспорт, закрывший 04, тоже встаёт на
 * максимальный индекс группы).
 */
export function collapseSewingView<S extends SewingViewStep, P extends SewingViewPassport>(
  steps: readonly S[],
  passports: readonly P[],
  collapseByOrder: ReadonlyMap<string, CollapseSpec>,
): { steps: S[]; passports: P[] } {
  if (collapseByOrder.size === 0) {
    return { steps: [...steps], passports: [...passports] };
  }

  // Per-order: множество merge-операций, их индексы и целевой индекс.
  const perOrder = new Map<
    string,
    { ops: Set<string>; indexes: Set<number>; targetIndex: number; spec: CollapseSpec }
  >();
  for (const [orderId, spec] of collapseByOrder) {
    const ops = new Set(spec.mergeOpIds);
    const mergeSteps = steps.filter((s) => s.orderId === orderId && ops.has(s.operation.id));
    if (mergeSteps.length === 0) continue; // нечего сливать у этого заказа
    const targetIndex = mergeSteps.reduce((m, s) => Math.max(m, s.index), -Infinity);
    perOrder.set(orderId, {
      ops,
      indexes: new Set(mergeSteps.map((s) => s.index)),
      targetIndex,
      spec,
    });
  }

  const outSteps: S[] = [];
  for (const s of steps) {
    const m = perOrder.get(s.orderId);
    if (!m || !m.ops.has(s.operation.id)) {
      outSteps.push(s);
      continue;
    }
    if (s.index !== m.targetIndex) continue; // лишние merge-шаги выкидываем
    outSteps.push({
      ...s,
      operation: {
        id: m.spec.targetOpId,
        name: m.spec.targetName,
        sortOrder: m.spec.targetSortOrder,
      },
    });
  }

  const outPassports: P[] = passports.map((p) => {
    const m = perOrder.get(p.orderId);
    if (!m) return p;
    const next: P = { ...p };
    if (p.currentOperationId && m.ops.has(p.currentOperationId)) {
      next.currentOperationId = m.spec.targetOpId;
    }
    if (p.assignedShiftSewingOperationId && m.ops.has(p.assignedShiftSewingOperationId)) {
      next.assignedShiftSewingOperationId = m.spec.targetOpId;
    }
    if (p.currentRouteStepIndex != null && m.indexes.has(p.currentRouteStepIndex)) {
      next.currentRouteStepIndex = m.targetIndex;
    }
    return next;
  });

  return { steps: outSteps, passports: outPassports };
}
