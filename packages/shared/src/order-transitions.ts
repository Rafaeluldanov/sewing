/**
 * Переходы статуса заказа — единый источник истины для backend-гейтов
 * и UI-контрола «Статус заказа» (выпадающий список в шапке карточки
 * `/admin/orders/[id]` и в строке списка `/admin/orders`).
 *
 * Зачем модуль: до него правила «какой переход сейчас доступен» жили в
 * двух местах — гейты в `OrdersService` (`start` / `startCalculation` /
 * `complete` / `cancel`, `OrderCostEstimatesService.reopenCalculation`)
 * и набор `show*`-флагов в `order-management-header.tsx`. Список
 * статусов показывает и НЕДОСТУПНЫЕ переходы с причиной, поэтому UI
 * обязан знать причину ДО клика — а дублировать бизнес-гейты на фронте
 * значит гарантированно их разъехать. Здесь один pure-helper, его
 * зовёт и backend (при сборке `OrderDetailDto.availableTransitions`),
 * и — через DTO — web.
 *
 * Модуль намеренно не зависит от `@prisma/client` и web-окружения:
 * на вход идёт плоский контекст (`OrderTransitionContext`), на выход —
 * массив `OrderTransitionDto` по одному элементу на КАЖДЫЙ статус,
 * кроме текущего (включая недостижимые — с `allowed = false` и кодом
 * причины). Тестируется `tests/unit/order-transitions.test.ts` без БД.
 *
 * Чего модуль НЕ делает:
 *   - не выполняет переход и не заменяет backend-гейты. Ручки
 *     (`POST /orders/:id/start` и т.д.) продолжают валидировать всё
 *     сами — helper лишь предсказывает их вердикт, чтобы UI не
 *     предлагал заведомо 409-й переход;
 *   - не описывает НЕ-статусные действия («Пересчитать план»,
 *     «Редактировать», «Выпустить паспорт») — они остаются кнопками;
 *   - не знает про «Рассчитать вариант» (`isVariantCalc` в
 *     `startCalculation`): статус заказа при этом не меняется, это не
 *     переход, а действие внутри `CALCULATION`.
 */

import { ORDER_STATUSES, type OrderStatus } from './orders';

/**
 * Действие, которым выполняется переход. Ровно соответствует
 * существующим ручкам API — новых эндпоинтов смены статуса нет:
 *
 *   - `START_CALCULATION`    → `POST /orders/:id/start-calculation`
 *   - `COMPLETE_CALCULATION` → `POST /orders/:id/complete-calculation`
 *   - `START_SAMPLE`         → `POST /orders/:id/samples` (форма запуска)
 *   - `START`                → `POST /orders/:id/start`
 *   - `REOPEN_CALCULATION`   → `POST /orders/:id/reopen-calculation`
 *   - `COMPLETE`             → `POST /orders/:id/complete`
 *   - `CANCEL`               → `POST /orders/:id/cancel`
 */
export const ORDER_TRANSITION_ACTIONS = [
  'START_CALCULATION',
  'COMPLETE_CALCULATION',
  'START_SAMPLE',
  'START',
  'REOPEN_CALCULATION',
  'COMPLETE',
  'CANCEL',
] as const;

export type OrderTransitionAction = (typeof ORDER_TRANSITION_ACTIONS)[number];

/**
 * Подпись пункта списка. Формулировка «что сделает менеджер», а не
 * «в какой статус попадёт заказ» — сам статус в строке уже написан.
 */
export const ORDER_TRANSITION_ACTION_LABELS: Record<
  OrderTransitionAction,
  string
> = {
  START_CALCULATION: 'Перевести в расчёт',
  COMPLETE_CALCULATION: 'Завершить расчёт',
  START_SAMPLE: 'Запустить сигнальный образец',
  START: 'Запустить в производство',
  REOPEN_CALCULATION: 'Вернуть на пересчёт',
  COMPLETE: 'Завершить заказ',
  CANCEL: 'Отменить заказ',
};

/**
 * Код причины, по которой переход недоступен. Там, где backend уже
 * имеет адресный код ошибки, используем ЕГО же — так текст в списке и
 * текст 409-й ошибки совпадают (см. `apps/api/src/common/errors.ts`).
 * Остальные коды — маршрутные, ошибкой backend-а они не бывают.
 */
export const ORDER_TRANSITION_BLOCK_CODES = [
  // Зеркала backend-исключений (гейты `startCalculation` / `start`).
  'ORDER_PATTERN_REQUIRED',
  'ORDER_CLIENT_REQUIRED',
  'ORDER_TECH_CARD_REQUIRED',
  'ORDER_ITEMS_REQUIRED',
  'ORDER_HAS_NO_ITEMS',
  'PATTERN_INACTIVE',
  // Маршрутные причины «такого перехода нет».
  'ORDER_TRANSITION_BACKWARD_NOT_ALLOWED',
  'ORDER_TRANSITION_PLAN_FROZEN',
  'ORDER_TRANSITION_SEQUENCE_REQUIRED',
  'ORDER_TRANSITION_HANDLED_ELSEWHERE',
  'ORDER_TRANSITION_TERMINAL',
] as const;

export type OrderTransitionBlockCode =
  (typeof ORDER_TRANSITION_BLOCK_CODES)[number];

/**
 * Человекочитаемая причина блокировки. Лежит в shared рядом с
 * `ORDER_STATUS_LABELS` по той же причине: и backend (fallback-поле
 * `reason` в DTO), и web показывают ОДИН текст.
 */
export const ORDER_TRANSITION_BLOCK_LABELS: Record<
  OrderTransitionBlockCode,
  string
> = {
  ORDER_PATTERN_REQUIRED: 'Не выбрано лекало',
  ORDER_CLIENT_REQUIRED: 'Не указан клиент — обязательное поле заказа',
  ORDER_TECH_CARD_REQUIRED: 'Не привязана техкарта',
  ORDER_ITEMS_REQUIRED: 'В заказе нет позиций с количеством',
  ORDER_HAS_NO_ITEMS: 'В заказе нет позиций',
  PATTERN_INACTIVE:
    'Лекало ещё не принято от конструктора — примите задачу КБ',
  ORDER_TRANSITION_BACKWARD_NOT_ALLOWED:
    'Возврат в этот статус не предусмотрен',
  ORDER_TRANSITION_PLAN_FROZEN: 'План заморожен после запуска производства',
  ORDER_TRANSITION_SEQUENCE_REQUIRED: 'Сначала нужно пройти предыдущие этапы',
  ORDER_TRANSITION_HANDLED_ELSEWHERE:
    'Статус ставится на другом экране',
  ORDER_TRANSITION_TERMINAL: 'Заказ закрыт — статус больше не меняется',
};

/**
 * Экран, на котором реально выполняется переход, если это НЕ кнопка в
 * карточке заказа. UI рисует такой пункт ссылкой, а не действием:
 *
 *   - `WORKSHOP_NEEDS` — «Завершить расчёт» делает закупщик на
 *     `/admin/workshop-needs` (`completeCalculation` требует курс USD и
 *     проверенных потребностей — одной кнопкой из шапки не сделать);
 *   - `SAMPLE_TAB` — запуск сигнального образца идёт через форму на
 *     вкладке «Сигнальный образец» (нужны размеры и количество).
 */
export type OrderTransitionHandledIn = 'WORKSHOP_NEEDS' | 'SAMPLE_TAB';

export interface OrderTransitionDto {
  /** Целевой статус. */
  to: OrderStatus;
  /**
   * Действие, которым выполняется переход. `null` — перехода из
   * текущего статуса не существует вовсе (строка в списке рисуется
   * заблокированной с `reasonCode`).
   */
  action: OrderTransitionAction | null;
  /**
   * `true` — переход можно инициировать прямо сейчас. Для пунктов с
   * `handledIn` это означает «ведём пользователя на нужный экран», а
   * не «дёргаем ручку из карточки».
   */
  allowed: boolean;
  /** Код причины блокировки (`allowed = false`). */
  reasonCode?: OrderTransitionBlockCode;
  /** Готовый текст причины — fallback, если UI не знает код. */
  reason?: string;
  /** Переход выполняется на другом экране (см. тип). */
  handledIn?: OrderTransitionHandledIn;
}

/**
 * Плоский контекст заказа для гейтов. Собирается на backend-е из
 * `Order` + связей (см. `OrdersService.toDetailDto`).
 */
export interface OrderTransitionContext {
  status: OrderStatus;
  /** `Order.clientId !== null`. */
  hasClient: boolean;
  /** По заказу есть хотя бы одна позиция. */
  hasItems: boolean;
  /** Σ `OrderItem.qtyPlan` > 0. */
  hasPlannedQty: boolean;
  /** `Order.patternItemId !== null`. */
  hasPattern: boolean;
  /**
   * Лекало пригодно для запуска в производство: `PatternItem.status
   * === 'ACTIVE'`. Если лекала нет — `true` (гейт неприменим, см.
   * `OrdersService.start`).
   */
  patternActive: boolean;
  /**
   * Техкарта задана на заказе (`Order.techCardId`) ИЛИ хотя бы на
   * одной расцветке (`OrderVariant.techCardId`) — фича «Расцветки»
   * прячет общий выбор техкарты.
   */
  hasTechCard: boolean;
}

const TERMINAL_STATUSES: readonly OrderStatus[] = ['DONE', 'CANCELLED'];

function block(
  to: OrderStatus,
  reasonCode: OrderTransitionBlockCode,
  action: OrderTransitionAction | null = null,
): OrderTransitionDto {
  return {
    to,
    action,
    allowed: false,
    reasonCode,
    reason: ORDER_TRANSITION_BLOCK_LABELS[reasonCode],
  };
}

function allow(
  to: OrderStatus,
  action: OrderTransitionAction,
  handledIn?: OrderTransitionHandledIn,
): OrderTransitionDto {
  return handledIn ? { to, action, allowed: true, handledIn } : { to, action, allowed: true };
}

/**
 * Гейты «Перевести в расчёт» — порядок проверок повторяет
 * `OrdersService.startCalculation`, чтобы предсказанная причина
 * совпадала с той, которую вернёт ручка при клике.
 */
function calculationBlockCode(
  ctx: OrderTransitionContext,
): OrderTransitionBlockCode | null {
  if (!ctx.hasPattern) return 'ORDER_PATTERN_REQUIRED';
  if (!ctx.hasClient) return 'ORDER_CLIENT_REQUIRED';
  if (!ctx.hasTechCard) return 'ORDER_TECH_CARD_REQUIRED';
  if (!ctx.hasItems || !ctx.hasPlannedQty) return 'ORDER_ITEMS_REQUIRED';
  return null;
}

/** Гейты «Запустить в производство» — зеркало `OrdersService.start`. */
function startBlockCode(
  ctx: OrderTransitionContext,
): OrderTransitionBlockCode | null {
  if (!ctx.hasItems) return 'ORDER_HAS_NO_ITEMS';
  if (!ctx.patternActive) return 'PATTERN_INACTIVE';
  return null;
}

/**
 * Возвращает переходы из текущего статуса — по одному элементу на
 * каждый статус, кроме текущего, в порядке `ORDER_STATUSES`.
 *
 * Терминальные `DONE` / `CANCELLED`: все переходы заблокированы кодом
 * `ORDER_TRANSITION_TERMINAL` — UI по `some(t => t.allowed)` понимает,
 * что контрол статуса надо нарисовать обычным бейджем без списка.
 *
 * Осознанное расхождение с backend-ом: `OrdersService.start` по
 * legacy-причинам принимает и `DRAFT` (старый flow «запустить без
 * расчёта»). В маршруте мы этот переход НЕ предлагаем — управленческий
 * путь идёт через расчёт; ручка остаётся рабочей для интеграций.
 */
export function evaluateOrderTransitions(
  ctx: OrderTransitionContext,
): OrderTransitionDto[] {
  const targets = ORDER_STATUSES.filter((s) => s !== ctx.status);

  if (TERMINAL_STATUSES.includes(ctx.status)) {
    return targets.map((to) => block(to, 'ORDER_TRANSITION_TERMINAL'));
  }

  return targets.map((to) => {
    // Отмена доступна из любого активного статуса.
    if (to === 'CANCELLED') return allow(to, 'CANCEL');

    switch (ctx.status) {
      case 'DRAFT': {
        if (to === 'CALCULATION') {
          const code = calculationBlockCode(ctx);
          return code
            ? block(to, code, 'START_CALCULATION')
            : allow(to, 'START_CALCULATION');
        }
        return block(to, 'ORDER_TRANSITION_SEQUENCE_REQUIRED');
      }

      case 'CALCULATION': {
        if (to === 'CALCULATION_DONE') {
          return {
            ...block(
              to,
              'ORDER_TRANSITION_HANDLED_ELSEWHERE',
              'COMPLETE_CALCULATION',
            ),
            handledIn: 'WORKSHOP_NEEDS',
          };
        }
        if (to === 'SAMPLE_PRODUCTION') {
          return allow(to, 'START_SAMPLE', 'SAMPLE_TAB');
        }
        if (to === 'IN_PRODUCTION') {
          const code = startBlockCode(ctx);
          return code ? block(to, code, 'START') : allow(to, 'START');
        }
        if (to === 'DRAFT') {
          return block(to, 'ORDER_TRANSITION_BACKWARD_NOT_ALLOWED');
        }
        return block(to, 'ORDER_TRANSITION_SEQUENCE_REQUIRED');
      }

      case 'CALCULATION_DONE': {
        if (to === 'CALCULATION') return allow(to, 'REOPEN_CALCULATION');
        if (to === 'SAMPLE_PRODUCTION') {
          return allow(to, 'START_SAMPLE', 'SAMPLE_TAB');
        }
        if (to === 'IN_PRODUCTION') {
          const code = startBlockCode(ctx);
          return code ? block(to, code, 'START') : allow(to, 'START');
        }
        if (to === 'DRAFT') {
          return block(to, 'ORDER_TRANSITION_BACKWARD_NOT_ALLOWED');
        }
        return block(to, 'ORDER_TRANSITION_SEQUENCE_REQUIRED');
      }

      case 'SAMPLE_PRODUCTION': {
        if (to === 'IN_PRODUCTION') {
          const code = startBlockCode(ctx);
          return code ? block(to, code, 'START') : allow(to, 'START');
        }
        if (to === 'DONE') {
          return block(to, 'ORDER_TRANSITION_SEQUENCE_REQUIRED');
        }
        return block(to, 'ORDER_TRANSITION_BACKWARD_NOT_ALLOWED');
      }

      case 'IN_PRODUCTION': {
        if (to === 'DONE') return allow(to, 'COMPLETE');
        return block(to, 'ORDER_TRANSITION_PLAN_FROZEN');
      }

      default:
        return block(to, 'ORDER_TRANSITION_SEQUENCE_REQUIRED');
    }
  });
}

/**
 * Есть ли из текущего статуса хотя бы один доступный переход. UI по
 * этому флагу решает, рисовать бейдж статуса кнопкой со списком или
 * статичным бейджем (терминальные заказы).
 */
export function hasAvailableOrderTransitions(
  transitions: readonly OrderTransitionDto[] | undefined,
): boolean {
  return (transitions ?? []).some((t) => t.allowed);
}
