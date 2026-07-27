/**
 * Контракты фичи «Правка заказа в производстве» (order amendments).
 *
 * Бэкенд: `apps/api/src/modules/order-amendments/*`
 * (`/api/orders/:id/amendments/*`). Веб: `apps/web/lib/amendments-api.ts`,
 * `components/orders/amendments/*`. Фича под флагом
 * `FEATURE_ORDER_AMENDMENTS` (на проде OFF по умолчанию, на dev ON).
 *
 * Смысл: после запуска заказа (`IN_PRODUCTION`) его план заморожен
 * (ADR-0006). Amendment — второй, узкий ярус редактируемости: аддитивные,
 * forward-only правки, которые ДОСТРАИВАЮТ производные снимки, а не
 * пересоздают их, и защищены проверкой уже выполненной работы.
 *
 * ФАЗА 1 (этот срез) — только «количество по размерам»:
 *   - меняем `OrderItem.qtyPlan` (+ `OrderVariantSize` у single-variant),
 *     `CuttingTaskSizeRow.qtyPlan`, снимок материалов и плановую
 *     стоимость/время операций;
 *   - нельзя опустить план ниже уже раскроенного (Σ `Passport.qtyCut`) —
 *     код `AMENDMENT_BELOW_CUT`;
 *   - заказы с ≥2 расцветками пока не поддержаны (правка per-цвет —
 *     следующая фаза), код `AMENDMENT_MULTIVARIANT_UNSUPPORTED`.
 */

import { z } from 'zod';

/** Верхняя граница планового количества (как у items/colorways). */
export const AMENDMENT_QTY_MAX = 1_000_000;

/** Одна правка: новый плановый тираж по размеру. */
export const QuantityAmendmentChangeSchema = z.object({
  sizeId: z.string().min(1),
  newQtyPlan: z.number().int().min(0).max(AMENDMENT_QTY_MAX),
});
export type QuantityAmendmentChange = z.infer<
  typeof QuantityAmendmentChangeSchema
>;

/** Тело применения правки количества. */
export const ApplyQuantityAmendmentSchema = z.object({
  changes: z
    .array(QuantityAmendmentChangeSchema)
    .min(1, 'Укажите хотя бы один размер'),
  reason: z.string().trim().min(1, 'Укажите причину правки').max(500),
});
export type ApplyQuantityAmendmentDto = z.infer<
  typeof ApplyQuantityAmendmentSchema
>;

/**
 * Строка состояния размера для drawer-а: текущий план, уже раскроено
 * (нижняя граница правки) и код размера.
 */
export interface QuantityAmendmentRowDto {
  sizeId: string;
  sizeCode: string;
  /** Текущий `OrderItem.qtyPlan`. */
  currentQtyPlan: number;
  /** Σ `Passport.qtyCut` (кроме CANCELLED) — минимум, ниже которого нельзя. */
  qtyCut: number;
}

/**
 * Ответ GET-состояния: что можно править и с какими ограничениями.
 * Клиент считает «после»-влияние локально из этих строк.
 */
export interface QuantityAmendmentStateDto {
  orderId: string;
  /** Заказ в статусе, где правка количества разрешена (`IN_PRODUCTION`). */
  editable: boolean;
  /** ≥2 расцветок — правка количества per-цвет пока не поддержана. */
  multiVariant: boolean;
  /**
   * По строкам потребности уже есть движения склада — авто-пересчёт
   * потребностей при правке будет пропущен (нужно обновить вручную).
   */
  needsHaveStock: boolean;
  rows: QuantityAmendmentRowDto[];
}

/** Результат применения правки количества. */
export interface QuantityAmendmentResultDto {
  orderId: string;
  applied: boolean;
  /** Потребности были пересчитаны автоматически. */
  needsRecalculated: boolean;
  /** Человекочитаемые предупреждения (напр. «потребности не пересчитаны»). */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// ФАЗА 2 — размерность (добавить / убрать размер в производстве).
// ---------------------------------------------------------------------------

/** Добавляемый размер: новый плановый тираж. */
export const SizeAmendmentAddSchema = z.object({
  sizeId: z.string().min(1),
  qtyPlan: z.number().int().min(1).max(AMENDMENT_QTY_MAX),
});
export type SizeAmendmentAdd = z.infer<typeof SizeAmendmentAddSchema>;

/** Тело правки размерности: добавить/убрать размеры одним сабмитом. */
export const ApplySizeAmendmentSchema = z
  .object({
    add: z.array(SizeAmendmentAddSchema).default([]),
    /** sizeId размеров к удалению (только не начатых в работе). */
    remove: z.array(z.string().min(1)).default([]),
    reason: z.string().trim().min(1, 'Укажите причину правки').max(500),
  })
  .refine((d) => d.add.length + d.remove.length > 0, {
    message: 'Укажите хотя бы одно изменение размерности',
  });
export type ApplySizeAmendmentDto = z.infer<typeof ApplySizeAmendmentSchema>;

/** Размер, уже присутствующий в заказе. */
export interface SizeAmendmentCurrentRowDto {
  sizeId: string;
  sizeCode: string;
  qtyPlan: number;
  /** Σ `Passport.qtyCut` (кроме CANCELLED). */
  qtyCut: number;
  /**
   * Размер можно убрать: по нему ещё нет ни раскроя (паспортов), ни
   * настилов раскроя. Иначе удаление запрещено (раскрой необратим).
   */
  removable: boolean;
}

/** Размер каталога, доступный для добавления в заказ. */
export interface SizeAmendmentAvailableRowDto {
  sizeId: string;
  sizeCode: string;
  /**
   * У лекала заказа есть активный файл на этот размер. `false` —
   * раскрой не пройдёт готовность, пока файл не загрузят (предупреждение,
   * не запрет). `true` также когда у заказа нет лекала (нет ограничения).
   */
  inPattern: boolean;
}

/** Ответ GET-состояния правки размерности. */
export interface SizeAmendmentStateDto {
  orderId: string;
  editable: boolean;
  multiVariant: boolean;
  needsHaveStock: boolean;
  current: SizeAmendmentCurrentRowDto[];
  available: SizeAmendmentAvailableRowDto[];
}

/** Результат применения правки размерности. */
export interface SizeAmendmentResultDto {
  orderId: string;
  applied: boolean;
  needsRecalculated: boolean;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// ФАЗА 3 — добавить операцию в маршрут заказа в производстве.
// ---------------------------------------------------------------------------

/**
 * Тело добавления операции. `afterIndex` — вставить сразу ПОСЛЕ шага
 * заказа с этим index; `null`/отсутствует — в конец маршрута. Позиция
 * обязана быть «впереди фронта» (дальше всех паспортов), иначе backend
 * отдаст 409 `AMENDMENT_OPERATION_BEHIND_FRONTIER`.
 */
export const ApplyOperationAmendmentSchema = z.object({
  operationId: z.string().min(1),
  afterIndex: z.number().int().min(0).nullable().optional(),
  reason: z.string().trim().min(1, 'Укажите причину правки').max(500),
});
export type ApplyOperationAmendmentDto = z.infer<
  typeof ApplyOperationAmendmentSchema
>;

/** Шаг маршрута заказа (снимок) для выбора позиции вставки. */
export interface OperationAmendmentStepDto {
  index: number;
  operationId: string;
  operationName: string;
  /**
   * Шаг «впереди фронта» — все паспорта его ещё не прошли. Вставлять
   * новую операцию можно только ПОСЛЕ такого шага (чисто аддитивно, без
   * возврата уже сделанной работы).
   */
  ahead: boolean;
  /** Код операции — для `data-`атрибутов и smoke-тестов, в UI не печатаем. */
  operationCode: string;
  /** Категория операции (CUTTING/SEWING/QC/IRONING/PACKING) — цвет чипа. */
  operationCategory: string | null;
  /** Снимок `parallelGroup`: соседи с одинаковым значением взаимозаменяемы. */
  parallelGroup: number | null;
  /**
   * Эффективная сдельная расценка шага (`rateOverride ?? Operation.fixedRate`)
   * или `null`, если операция окладная / поразмерная. Нужна только для
   * локальной оценки Δ плана в drawer-е; истина — пересчёт на бэкенде.
   */
  rateRub: number | null;
  /** Эффективная норма времени, сек/шт (`FIXED`), либо `null`. */
  timeNormSec: number | null;
  /**
   * Шаг можно двигать/убирать: он строго впереди фронта
   * (`index > frontierIndex`), т.е. ни один паспорт до него не дошёл.
   */
  movable: boolean;
  /**
   * Шаг можно убрать: `movable` И по операции в этом заказе нет ни одной
   * записи выработки (`OperationEntry`). Иначе удаление стёрло бы шаг,
   * за который уже начислены деньги.
   */
  removable: boolean;
}

/** Операция каталога, доступная для добавления. */
export interface OperationAmendmentOptionDto {
  id: string;
  code: string;
  name: string;
  /** Категория — группировка палитры и цвет чипа. */
  category: string | null;
  /** Сдельная расценка по справочнику (`FIXED`), иначе `null`. */
  rateRub: number | null;
  /** Норма времени по справочнику (`FIXED`), иначе `null`. */
  timeNormSec: number | null;
}

/** Ответ GET-состояния добавления операции. */
export interface OperationAmendmentStateDto {
  orderId: string;
  editable: boolean;
  /**
   * Индекс дальше которого стоят все паспорта (`max currentRouteStepIndex`,
   * −1 если паспортов нет). Вставлять операцию можно после шага с
   * `index >= frontierIndex` либо в конец.
   */
  frontierIndex: number;
  steps: OperationAmendmentStepDto[];
  availableOperations: OperationAmendmentOptionDto[];
}

/** Результат добавления операции. */
export interface OperationAmendmentResultDto {
  orderId: string;
  applied: boolean;
  /** Индекс, на который встала новая операция. */
  insertedIndex: number;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// ФАЗА 3.1 — правка маршрута целиком (drawer «Изменить в производстве» →
// вкладка «Маршрут»): состав, порядок и параллельные группы ВПЕРЕДИ фронта.
// ---------------------------------------------------------------------------

/** Один шаг целевого маршрута. Порядок в массиве = порядок шагов. */
export const RouteAmendmentStepSchema = z.object({
  operationId: z.string().min(1),
  /**
   * Номер параллельной (взаимозаменяемой) группы. Соседние шаги с
   * одинаковым ненулевым значением — один этап, порядок внутри любой.
   */
  parallelGroup: z.number().int().min(1).nullable().optional(),
});
export type RouteAmendmentStep = z.infer<typeof RouteAmendmentStepSchema>;

/**
 * Тело правки маршрута: клиент присылает **весь целевой маршрут**, а не
 * дельту. Так холст остаётся источником истины «как должно быть», а
 * бэкенд сам считает, что добавлено/убрано/переставлено, и проверяет,
 * что замороженный префикс (шаги до фронта включительно) не тронут.
 */
export const ApplyRouteAmendmentSchema = z.object({
  steps: z.array(RouteAmendmentStepSchema).min(1, 'Маршрут не может быть пустым'),
  reason: z.string().trim().min(1, 'Укажите причину правки').max(500),
});
export type ApplyRouteAmendmentDto = z.infer<typeof ApplyRouteAmendmentSchema>;

/** Результат правки маршрута. `summary` — то же, что уйдёт в журнал. */
export interface RouteAmendmentResultDto {
  orderId: string;
  applied: boolean;
  addedCount: number;
  removedCount: number;
  movedCount: number;
  /** Человекочитаемая сводка правки («+ Киперка после Распошив; − ВТО»). */
  summary: string;
  warnings: string[];
}

/** Текущий шаг снимка для планировщика (минимум полей). */
export interface RoutePlanCurrentStep {
  index: number;
  operationId: string;
  parallelGroup: number | null;
}

/** Целевой шаг для планировщика. */
export interface RoutePlanTargetStep {
  operationId: string;
  parallelGroup: number | null;
}

/** Что делать с одной позицией целевого маршрута. */
export interface RoutePlanPlacement {
  /** Новый index шага. */
  index: number;
  operationId: string;
  parallelGroup: number | null;
  /** Прежний index этого шага в снимке; `null` — шаг новый. */
  fromIndex: number | null;
}

export interface RouteAmendmentPlan {
  placements: RoutePlanPlacement[];
  /** Прежние index'ы шагов, которых нет в целевом маршруте. */
  removedIndexes: number[];
  /** operationId добавленных шагов. */
  addedOperationIds: string[];
  /** operationId убранных шагов. */
  removedOperationIds: string[];
  /** Шаги, сменившие позицию (без учёта добавленных/убранных). */
  movedOperationIds: string[];
  /** Правка ничего не меняет — сохранять нечего. */
  noop: boolean;
}

export type RouteAmendmentViolation =
  /** В целевом маршруте одна операция встречается дважды. */
  | { code: 'DUPLICATE_OPERATION'; operationId: string }
  /**
   * Тронут замороженный префикс: шаги с `index <= frontierIndex` обязаны
   * остаться теми же и в том же порядке (их уже проходят паспорта).
   */
  | { code: 'FRONTIER_CHANGED'; index: number }
  /** Шаг впереди фронта убран, но по его операции уже есть выработка. */
  | { code: 'STEP_HAS_WORK'; operationId: string };

export type RouteAmendmentPlanResult =
  | { ok: true; plan: RouteAmendmentPlan }
  | { ok: false; violation: RouteAmendmentViolation };

/**
 * Чистое планирование правки маршрута: из текущего снимка и целевого
 * маршрута считает перестановки и проверяет инварианты. Ни Prisma, ни
 * побочных эффектов — вся арифметика индексов живёт здесь и покрыта
 * unit-тестом (`tests/unit/route-amendment-plan.test.ts`).
 *
 * `frontierIndex` — максимальный `Passport.currentRouteStepIndex`
 * (−1, если паспортов нет). Шаги `0..frontierIndex` заморожены: паспорта
 * их прошли или проходят прямо сейчас. Менять можно только хвост.
 *
 * `operationIdsWithWork` — операции этого заказа, по которым уже есть
 * записи выработки: убирать такой шаг нельзя, даже если он впереди фронта
 * (сдельные начисления ссылаются на операцию).
 */
export function planRouteAmendment(
  current: readonly RoutePlanCurrentStep[],
  target: readonly RoutePlanTargetStep[],
  frontierIndex: number,
  operationIdsWithWork: ReadonlySet<string> = new Set(),
): RouteAmendmentPlanResult {
  const ordered = [...current].sort((a, b) => a.index - b.index);

  const seen = new Set<string>();
  for (const t of target) {
    if (seen.has(t.operationId)) {
      return {
        ok: false,
        violation: { code: 'DUPLICATE_OPERATION', operationId: t.operationId },
      };
    }
    seen.add(t.operationId);
  }

  // Замороженный префикс: 0..frontierIndex включительно — один в один.
  const frozenCount = Math.max(0, Math.min(frontierIndex + 1, ordered.length));
  for (let i = 0; i < frozenCount; i += 1) {
    const cur = ordered[i];
    const tgt = target[i];
    if (
      !tgt ||
      tgt.operationId !== cur.operationId ||
      (tgt.parallelGroup ?? null) !== (cur.parallelGroup ?? null)
    ) {
      return { ok: false, violation: { code: 'FRONTIER_CHANGED', index: i } };
    }
  }

  const byOperationId = new Map(ordered.map((s) => [s.operationId, s]));
  const targetIds = new Set(target.map((t) => t.operationId));

  const removed = ordered.filter((s) => !targetIds.has(s.operationId));
  for (const s of removed) {
    if (operationIdsWithWork.has(s.operationId)) {
      return {
        ok: false,
        violation: { code: 'STEP_HAS_WORK', operationId: s.operationId },
      };
    }
  }

  const placements: RoutePlanPlacement[] = target.map((t, i) => {
    const prev = byOperationId.get(t.operationId);
    return {
      index: i,
      operationId: t.operationId,
      parallelGroup: t.parallelGroup ?? null,
      fromIndex: prev ? prev.index : null,
    };
  });

  const added = placements.filter((p) => p.fromIndex === null);

  // «Переставлен» — сменился ОТНОСИТЕЛЬНЫЙ порядок среди выживших шагов, а
  // не абсолютный index: вставка операции в начало сдвигает весь хвост, но
  // это не перестановка, и в сводке правки такой шум не нужен.
  const survivedBefore = ordered
    .filter((s) => targetIds.has(s.operationId))
    .map((s) => s.operationId);
  const survivedAfter = target
    .filter((t) => byOperationId.has(t.operationId))
    .map((t) => t.operationId);
  const moved = placements.filter(
    (p) =>
      p.fromIndex !== null &&
      (survivedBefore.indexOf(p.operationId) !==
        survivedAfter.indexOf(p.operationId) ||
        (byOperationId.get(p.operationId)?.parallelGroup ?? null) !==
          p.parallelGroup),
  );

  return {
    ok: true,
    plan: {
      placements,
      removedIndexes: removed.map((s) => s.index),
      addedOperationIds: added.map((p) => p.operationId),
      removedOperationIds: removed.map((s) => s.operationId),
      movedOperationIds: moved.map((p) => p.operationId),
      noop:
        added.length === 0 && removed.length === 0 && moved.length === 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Журнал правок в производстве (аудит ORDER_QTY_AMENDED / ORDER_SIZE_AMENDED
// / ORDER_OPERATION_ADDED / ORDER_TECH_CARD_AMENDED). Read-only, для карточки
// заказа.
// ---------------------------------------------------------------------------

/** Одна запись журнала правок. `summary` уже человекочитаемый (собран на backend). */
export interface AmendmentHistoryEntryDto {
  id: string;
  /** ISO-время события. */
  occurredAt: string;
  /** Кто применил правку (`null` — актор не сохранён). */
  actorName: string | null;
  /**
   * `materials` — правка спецификации техкарты заказа (норма, единица, цвет,
   * значение параметра, добавленный/убранный материал). Пишется, когда
   * технолог правит материалы уже после расчёта / в производстве.
   */
  kind: 'quantity' | 'size' | 'operation' | 'materials';
  /** Причина, указанная менеджером. */
  reason: string | null;
  /** Готовая строка «что изменилось» (коды размеров/имя операции уже подставлены). */
  summary: string;
}
