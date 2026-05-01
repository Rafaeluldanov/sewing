/**
 * Управленческий слой контроля сроков заказов (Order Deadlines + Risk
 * Detection).
 *
 * Backend (`OrdersService.list/get/detail`) и web (`/admin/orders`,
 * `/admin/orders/[id]`, `/admin`) используют ОДИН pure-helper
 * `evaluateOrderDeadline` — чтобы цвет/лейбл/текст про «осталось N дн.»
 * нельзя было разъехаться между списком и карточкой.
 *
 * Намеренно не зависит от `@prisma/client` и web-окружения: модуль
 * чистый, его тестирует `tests/unit/order-deadlines.test.ts` без БД.
 *
 * Источники:
 *   - `Order.dueDate` — управленческий срок (DateTime?, см.
 *     `prisma/schema.prisma model Order`).
 *   - `Order.status` — `OrderStatus` (`DRAFT`/`IN_PRODUCTION`/`DONE`/
 *     `CANCELLED`).
 *   - `qtyPlan` / `qtyFinished` — план и факт выпуска (паспорта в
 *     статусе `PACKED`, см. `apps/api/src/modules/orders/order-aggregator.ts`).
 *
 * Правила MVP (см. ТЗ «Order Deadlines + Risk Detection»):
 *   1. status = DONE → DONE («Готов»).
 *   2. status = CANCELLED → DONE («Отменён», tone muted) — заказ
 *      терминальный, в дашборд просрочки/риска не попадает.
 *   3. dueDate отсутствует → NO_DUE_DATE («Без срока»).
 *   4. today > dueDate (по UTC-дню) и заказ не DONE/CANCELLED →
 *      OVERDUE («Просрочен»).
 *   5. до dueDate ≤ 2 дней и progressPercent < 80 → AT_RISK
 *      («В риске»).
 *   6. Иначе → ON_TRACK («В срок»).
 *
 * Сравнение дат — по UTC-дню, чтобы исключить «на час позже» из-за
 * timezone сервера. `dueDate` хранится в БД как `DateTime` без
 * времени (фактически 00:00 UTC), помощник не «теряет» день из-за
 * локального оффсета.
 */

import type { OrderStatus } from './orders';

export const ORDER_DEADLINE_STATUSES = [
  'OVERDUE',
  'AT_RISK',
  'ON_TRACK',
  'NO_DUE_DATE',
  'DONE',
] as const;

export type OrderDeadlineStatus = (typeof ORDER_DEADLINE_STATUSES)[number];

/**
 * Тон для UI (`AdminStatusBadge`, `.admin-deadline-card--*`). Совпадает
 * с `AdminStatusTone` в `apps/web/lib/admin-labels.ts` — это сделано
 * намеренно, чтобы web мог отдавать `evaluation.tone` напрямую в
 * `<AdminStatusBadge tone={…}>` без маппинга.
 */
export type OrderDeadlineTone =
  | 'danger'
  | 'warning'
  | 'success'
  | 'muted'
  | 'info';

export interface OrderDeadlineEvaluation {
  status: OrderDeadlineStatus;
  label: string;
  tone: OrderDeadlineTone;
  /**
   * Календарных дней до `dueDate` (UTC). Отрицательное число — заказ
   * просрочен. `null`, если `dueDate` не задан или некорректен.
   */
  daysLeft: number | null;
  /**
   * Целое 0..100 — процент выпуска (`qtyFinished / qtyPlan * 100`).
   * `null`, если `qtyPlan` не положителен (нечего считать).
   */
  progressPercent: number | null;
  /** Короткая «человеческая» подпись для UI-карточек. */
  reason: string;
}

export interface EvaluateOrderDeadlineInput {
  status: OrderStatus;
  dueDate?: string | Date | null;
  qtyPlan?: number | null;
  qtyFinished?: number | null;
  /**
   * Опционально для тестирования. По умолчанию — `new Date()` сервера.
   */
  now?: Date;
}

/** Человекочитаемые лейблы для UI (бейджи, фильтры, KPI). */
export const ORDER_DEADLINE_LABELS: Record<OrderDeadlineStatus, string> = {
  OVERDUE: 'Просрочен',
  AT_RISK: 'В риске',
  ON_TRACK: 'В срок',
  NO_DUE_DATE: 'Без срока',
  DONE: 'Готов',
};

/** Тон бейджа/карточки по статусу (см. `OrderDeadlineTone`). */
export const ORDER_DEADLINE_TONES: Record<OrderDeadlineStatus, OrderDeadlineTone> = {
  OVERDUE: 'danger',
  AT_RISK: 'warning',
  ON_TRACK: 'success',
  NO_DUE_DATE: 'muted',
  DONE: 'success',
};

/** Заказ считается «в риске» начиная с этого порога дней до dueDate. */
export const ORDER_DEADLINE_AT_RISK_DAYS = 2;
/**
 * Порог прогресса (в %), ниже которого «осталось ≤ N дней» переводит
 * заказ в AT_RISK. ≥ 80 % считается достаточным выпуском, чтобы
 * не подсвечивать риск.
 */
export const ORDER_DEADLINE_AT_RISK_PROGRESS = 80;

const MS_IN_DAY = 24 * 60 * 60 * 1000;

function startOfUtcDay(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function diffInDaysUtc(target: Date, base: Date): number {
  return Math.round((startOfUtcDay(target) - startOfUtcDay(base)) / MS_IN_DAY);
}

/**
 * Прогресс выпуска в % (целое 0..100). Если `qtyPlan` пуст или ≤ 0 —
 * вернёт `null`: на пустом плане проценты считать нечего.
 */
export function computeProgressPercent(
  qtyPlan: number | null | undefined,
  qtyFinished: number | null | undefined,
): number | null {
  if (qtyPlan == null || qtyPlan <= 0) return null;
  const finished = Math.max(qtyFinished ?? 0, 0);
  const raw = (finished / qtyPlan) * 100;
  if (!Number.isFinite(raw)) return null;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

/**
 * Главная функция модуля. Принимает «паспорт заказа» в форме DTO и
 * возвращает однородную оценку `OrderDeadlineEvaluation` — её
 * напрямую сериализуют backend и потребляет UI.
 *
 * Помощник pure: не читает БД, не зависит от часового пояса хоста
 * (использует UTC-день), не бросает исключений на мусорные данные —
 * на некорректную дату возвращает `NO_DUE_DATE`.
 */
export function evaluateOrderDeadline(
  input: EvaluateOrderDeadlineInput,
): OrderDeadlineEvaluation {
  const now = input.now ?? new Date();
  const progressPercent = computeProgressPercent(
    input.qtyPlan,
    input.qtyFinished,
  );

  // 1. DONE/CANCELLED — терминальные. CANCELLED трактуем как DONE-tier
  // (в KPI «Просрочено / В риске» не попадает), но с отдельной
  // подписью и нейтральным тоном — иначе менеджер увидит «Готов»
  // на отменённом заказе.
  if (input.status === 'DONE') {
    return {
      status: 'DONE',
      label: ORDER_DEADLINE_LABELS.DONE,
      tone: ORDER_DEADLINE_TONES.DONE,
      daysLeft: null,
      progressPercent,
      reason: 'Заказ завершён.',
    };
  }
  if (input.status === 'CANCELLED') {
    return {
      status: 'DONE',
      label: 'Отменён',
      tone: 'muted',
      daysLeft: null,
      progressPercent,
      reason: 'Заказ отменён.',
    };
  }

  // 2. Без срока — даже если заказ пошёл в работу, в риск не уходит.
  if (input.dueDate == null) {
    return {
      status: 'NO_DUE_DATE',
      label: ORDER_DEADLINE_LABELS.NO_DUE_DATE,
      tone: ORDER_DEADLINE_TONES.NO_DUE_DATE,
      daysLeft: null,
      progressPercent,
      reason: 'Срок сдачи не задан.',
    };
  }

  const dueRaw =
    input.dueDate instanceof Date ? input.dueDate : new Date(input.dueDate);
  if (Number.isNaN(dueRaw.getTime())) {
    return {
      status: 'NO_DUE_DATE',
      label: ORDER_DEADLINE_LABELS.NO_DUE_DATE,
      tone: ORDER_DEADLINE_TONES.NO_DUE_DATE,
      daysLeft: null,
      progressPercent,
      reason: 'Срок сдачи не задан.',
    };
  }

  const daysLeft = diffInDaysUtc(dueRaw, now);

  // 3. OVERDUE — день dueDate уже прошёл (по UTC-дню), заказ ещё в
  // работе. CANCELLED исключён выше, DONE тоже.
  if (daysLeft < 0) {
    const overdueDays = Math.abs(daysLeft);
    return {
      status: 'OVERDUE',
      label: ORDER_DEADLINE_LABELS.OVERDUE,
      tone: ORDER_DEADLINE_TONES.OVERDUE,
      daysLeft,
      progressPercent,
      reason: `Срок прошёл ${overdueDays} дн. назад, заказ не завершён.`,
    };
  }

  // 4. AT_RISK — близко к сроку и недостаточно прогресса. Если плана
  // нет (`progressPercent === null`) — риск не показываем: считать
  // «нечего», менеджеру нечего ускорять.
  if (
    daysLeft <= ORDER_DEADLINE_AT_RISK_DAYS &&
    progressPercent !== null &&
    progressPercent < ORDER_DEADLINE_AT_RISK_PROGRESS
  ) {
    const tail =
      daysLeft === 0
        ? 'сегодня'
        : daysLeft === 1
          ? '1 день'
          : `${daysLeft} дн.`;
    return {
      status: 'AT_RISK',
      label: ORDER_DEADLINE_LABELS.AT_RISK,
      tone: ORDER_DEADLINE_TONES.AT_RISK,
      daysLeft,
      progressPercent,
      reason: `До срока ${tail}, готово ${progressPercent}%.`,
    };
  }

  // 5. Иначе — идёт по сроку. Прогресс может быть `null` (план не
  // выставлен) — это нормально, отдаём ON_TRACK без процента.
  return {
    status: 'ON_TRACK',
    label: ORDER_DEADLINE_LABELS.ON_TRACK,
    tone: ORDER_DEADLINE_TONES.ON_TRACK,
    daysLeft,
    progressPercent,
    reason: 'Заказ идёт по сроку.',
  };
}

/**
 * Порядок сортировки бакетов «контроля сроков» — для дефолтного
 * визуального группирования в `/admin/orders` (OVERDUE → AT_RISK →
 * ON_TRACK → NO_DUE_DATE → DONE) и для KPI на `/admin`.
 */
export const ORDER_DEADLINE_SORT_PRIORITY: Record<OrderDeadlineStatus, number> = {
  OVERDUE: 0,
  AT_RISK: 1,
  ON_TRACK: 2,
  NO_DUE_DATE: 3,
  DONE: 4,
};
