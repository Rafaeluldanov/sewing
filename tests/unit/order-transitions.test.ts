/**
 * Unit-тесты pure-helper-а `evaluateOrderTransitions`
 * (`packages/shared/src/order-transitions.ts`).
 *
 * Helper — единственное место, где записано «какой переход статуса
 * доступен и почему нет». Его результат уезжает в
 * `OrderDetailDto.availableTransitions` и рисуется контролом
 * `OrderStatusSelect` (шапка `/admin/orders/[id]` и строка списка).
 * Поэтому фиксируем здесь ровно то, что зеркалим из гейтов
 * `OrdersService`: сместится правило — упадёт тест, а не менеджер в
 * 409-ю ошибку после клика.
 */
import { describe, expect, test } from 'vitest';
import { ORDER_STATUSES, type OrderStatus } from '@sewing/shared/orders';
import {
  evaluateOrderTransitions,
  hasAvailableOrderTransitions,
  type OrderTransitionContext,
} from '@sewing/shared/order-transitions';

/** Полностью укомплектованный заказ — все гейты пройдены. */
function ctx(
  status: OrderStatus,
  overrides: Partial<OrderTransitionContext> = {},
): OrderTransitionContext {
  return {
    status,
    hasClient: true,
    hasItems: true,
    hasPlannedQty: true,
    hasPattern: true,
    patternActive: true,
    hasTechCard: true,
    ...overrides,
  };
}

function to(status: OrderStatus, target: OrderStatus, over = {}) {
  const t = evaluateOrderTransitions(ctx(status, over)).find(
    (x) => x.to === target,
  );
  if (!t) throw new Error(`нет строки перехода ${status} → ${target}`);
  return t;
}

describe('evaluateOrderTransitions — форма ответа', () => {
  test('по одному элементу на каждый статус, кроме текущего', () => {
    for (const status of ORDER_STATUSES) {
      const result = evaluateOrderTransitions(ctx(status));
      expect(result).toHaveLength(ORDER_STATUSES.length - 1);
      expect(result.some((t) => t.to === status)).toBe(false);
      // Каждая недоступная строка обязана нести причину — иначе UI
      // покажет заблокированный пункт без объяснения.
      for (const t of result) {
        if (!t.allowed) expect(t.reasonCode).toBeTruthy();
      }
    }
  });
});

describe('DRAFT', () => {
  test('укомплектованный черновик → «Перевести в расчёт»', () => {
    const t = to('DRAFT', 'CALCULATION');
    expect(t.allowed).toBe(true);
    expect(t.action).toBe('START_CALCULATION');
  });

  test('порядок гейтов совпадает с startCalculation: лекало → клиент → техкарта → позиции', () => {
    expect(
      to('DRAFT', 'CALCULATION', {
        hasPattern: false,
        hasClient: false,
        hasTechCard: false,
        hasItems: false,
      }).reasonCode,
    ).toBe('ORDER_PATTERN_REQUIRED');
    expect(
      to('DRAFT', 'CALCULATION', { hasClient: false }).reasonCode,
    ).toBe('ORDER_CLIENT_REQUIRED');
    expect(
      to('DRAFT', 'CALCULATION', { hasTechCard: false }).reasonCode,
    ).toBe('ORDER_TECH_CARD_REQUIRED');
    expect(
      to('DRAFT', 'CALCULATION', { hasPlannedQty: false }).reasonCode,
    ).toBe('ORDER_ITEMS_REQUIRED');
  });

  test('заблокированный переход сохраняет action — UI пишет «что хотел сделать»', () => {
    const t = to('DRAFT', 'CALCULATION', { hasClient: false });
    expect(t.allowed).toBe(false);
    expect(t.action).toBe('START_CALCULATION');
    expect(t.reason).toBeTruthy();
  });

  test('прямой запуск в производство из черновика не предлагается', () => {
    expect(to('DRAFT', 'IN_PRODUCTION').allowed).toBe(false);
  });
});

describe('CALCULATION', () => {
  test('«Расчёт завершён» — ссылка на «Расчёты цеха», а не действие в карточке', () => {
    const t = to('CALCULATION', 'CALCULATION_DONE');
    expect(t.allowed).toBe(false);
    expect(t.action).toBe('COMPLETE_CALCULATION');
    expect(t.handledIn).toBe('WORKSHOP_NEEDS');
  });

  test('сигнальный образец — разрешён, но через форму запуска', () => {
    const t = to('CALCULATION', 'SAMPLE_PRODUCTION');
    expect(t.allowed).toBe(true);
    expect(t.handledIn).toBe('SAMPLE_TAB');
  });

  test('запуск в производство разрешён; неактивное лекало блокирует', () => {
    expect(to('CALCULATION', 'IN_PRODUCTION').allowed).toBe(true);
    expect(
      to('CALCULATION', 'IN_PRODUCTION', { patternActive: false }).reasonCode,
    ).toBe('PATTERN_INACTIVE');
    expect(
      to('CALCULATION', 'IN_PRODUCTION', { hasItems: false }).reasonCode,
    ).toBe('ORDER_HAS_NO_ITEMS');
  });

  test('возврат в черновик не предусмотрен', () => {
    expect(to('CALCULATION', 'DRAFT').reasonCode).toBe(
      'ORDER_TRANSITION_BACKWARD_NOT_ALLOWED',
    );
  });
});

describe('CALCULATION_DONE', () => {
  test('назад на пересчёт — разрешённый обратный переход', () => {
    const t = to('CALCULATION_DONE', 'CALCULATION');
    expect(t.allowed).toBe(true);
    expect(t.action).toBe('REOPEN_CALCULATION');
  });

  test('запуск тиража разрешён', () => {
    expect(to('CALCULATION_DONE', 'IN_PRODUCTION').allowed).toBe(true);
  });
});

describe('SAMPLE_PRODUCTION и IN_PRODUCTION', () => {
  test('из образца запускается полный тираж', () => {
    const t = to('SAMPLE_PRODUCTION', 'IN_PRODUCTION');
    expect(t.allowed).toBe(true);
    expect(t.action).toBe('START');
  });

  test('в производстве доступно только «Завершить» и «Отменить»', () => {
    const result = evaluateOrderTransitions(ctx('IN_PRODUCTION'));
    const allowed = result.filter((t) => t.allowed).map((t) => t.to);
    expect(allowed.sort()).toEqual(['CANCELLED', 'DONE']);
  });

  test('назад из производства нельзя — план заморожен', () => {
    expect(to('IN_PRODUCTION', 'CALCULATION').reasonCode).toBe(
      'ORDER_TRANSITION_PLAN_FROZEN',
    );
  });
});

describe('отмена и терминальные статусы', () => {
  test('отмена доступна из любого активного статуса', () => {
    for (const status of ORDER_STATUSES) {
      if (status === 'DONE' || status === 'CANCELLED') continue;
      const t = to(status, 'CANCELLED');
      expect(t.allowed).toBe(true);
      expect(t.action).toBe('CANCEL');
    }
  });

  test('DONE / CANCELLED — переходов нет, контрол рисуется бейджем', () => {
    for (const status of ['DONE', 'CANCELLED'] as const) {
      const result = evaluateOrderTransitions(ctx(status));
      expect(result.every((t) => !t.allowed)).toBe(true);
      expect(
        result.every((t) => t.reasonCode === 'ORDER_TRANSITION_TERMINAL'),
      ).toBe(true);
      expect(hasAvailableOrderTransitions(result)).toBe(false);
    }
  });

  test('hasAvailableOrderTransitions терпит undefined (старый DTO без поля)', () => {
    expect(hasAvailableOrderTransitions(undefined)).toBe(false);
    expect(hasAvailableOrderTransitions(evaluateOrderTransitions(ctx('DRAFT')))).toBe(
      true,
    );
  });
});
