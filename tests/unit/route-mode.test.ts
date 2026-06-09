/**
 * Unit-тесты чистой логики адаптивного режима сплит-распошива
 * (`apps/api/src/modules/passports/route-mode.ts`).
 *
 * Покрываем:
 *   - hasDedicatedLowStation: выделенный низ-станок vs универсальная машина;
 *   - modeForOrder: AUTO (SPLIT/COLLAPSED по сигналу), FORCE_*, отсутствие
 *     сворачиваемой группы.
 */
import { describe, expect, test } from 'vitest';
import { findCollapsibleGroup, type RouteStepLite, type SubstitutionLite } from '@sewing/api/modules/passports/route-collapse';
import {
  collapseSewingView,
  hasDedicatedLowStation,
  modeForOrder,
  type ActiveLowSession,
  type CollapseSpec,
} from '@sewing/api/modules/passports/route-mode';

// Маршрут 02 (сплит): крой → [киперка ∥ рукав ∥ низ] → ОТК.
const SPLIT_STEPS: RouteStepLite[] = [
  { index: 0, operationId: 'cut', parallelGroup: null },
  { index: 1, operationId: '03', parallelGroup: 2 }, // киперка
  { index: 2, operationId: '16', parallelGroup: 2 }, // рукав (принимающий)
  { index: 3, operationId: '0001', parallelGroup: 2 }, // низ (выделенный)
  { index: 4, operationId: '05', parallelGroup: null }, // ОТК
];

const SUBS: SubstitutionLite[] = [
  { satisfiesOpId: '0001', substituteOpId: '04', isReceivingStation: false },
  { satisfiesOpId: '16', substituteOpId: '04', isReceivingStation: true },
];

const PLAN = findCollapsibleGroup(SPLIT_STEPS, SUBS)!;

// receivingEquipmentIds = универсальные/полные распошивные станки (умеют 16/04).
const RECEIVING = new Set(['rasposhiv', 'rasposhiv-2', 'rasposhiv-3', 'rasposhiv-4']);

describe('hasDedicatedLowStation', () => {
  test('выделенный низ-станок (podgib-niza: низ, не умеет принимать) → true', () => {
    const sessions: ActiveLowSession[] = [
      { operationId: '0001', equipmentId: 'podgib-niza' },
    ];
    expect(hasDedicatedLowStation(sessions, PLAN.dedicatedOpIds, RECEIVING)).toBe(true);
  });

  test('универсальная машина на низе (умеет принимать) → false', () => {
    const sessions: ActiveLowSession[] = [
      { operationId: '0001', equipmentId: 'rasposhiv-2' },
    ];
    expect(hasDedicatedLowStation(sessions, PLAN.dedicatedOpIds, RECEIVING)).toBe(false);
  });

  test('смена на полном распошиве (04) на любом станке → false (это не низ)', () => {
    const sessions: ActiveLowSession[] = [
      { operationId: '04', equipmentId: 'podgib-niza' },
    ];
    expect(hasDedicatedLowStation(sessions, PLAN.dedicatedOpIds, RECEIVING)).toBe(false);
  });

  test('нет активных смен → false', () => {
    expect(hasDedicatedLowStation([], PLAN.dedicatedOpIds, RECEIVING)).toBe(false);
  });

  test('несколько смен, хотя бы одна на выделенном низ-станке → true', () => {
    const sessions: ActiveLowSession[] = [
      { operationId: '04', equipmentId: 'rasposhiv' },
      { operationId: '0001', equipmentId: 'podgib-niza' },
    ];
    expect(hasDedicatedLowStation(sessions, PLAN.dedicatedOpIds, RECEIVING)).toBe(true);
  });
});

describe('modeForOrder', () => {
  test('AUTO + выделенный низ-станок активен → SPLIT', () => {
    expect(
      modeForOrder({ override: 'AUTO', plan: PLAN, dedicatedLowActive: true }),
    ).toBe('SPLIT');
  });

  test('AUTO + выделенный низ-станок НЕ активен → COLLAPSED', () => {
    expect(
      modeForOrder({ override: 'AUTO', plan: PLAN, dedicatedLowActive: false }),
    ).toBe('COLLAPSED');
  });

  test('AUTO + нет сворачиваемой группы → SPLIT (нечего сливать)', () => {
    expect(
      modeForOrder({ override: 'AUTO', plan: null, dedicatedLowActive: false }),
    ).toBe('SPLIT');
  });

  test('FORCE_SPLIT перебивает авто-сигнал (даже без активного низа)', () => {
    expect(
      modeForOrder({ override: 'FORCE_SPLIT', plan: PLAN, dedicatedLowActive: false }),
    ).toBe('SPLIT');
  });

  test('FORCE_COLLAPSED перебивает авто-сигнал (даже при активном низе)', () => {
    expect(
      modeForOrder({ override: 'FORCE_COLLAPSED', plan: PLAN, dedicatedLowActive: true }),
    ).toBe('COLLAPSED');
  });
});

describe('collapseSewingView', () => {
  // sewing-шаги монитора для заказа O1 (сплит-снимок: киперка, низ, рукав, ОТК).
  const STEPS = [
    { orderId: 'O1', index: 3, parallelGroup: 1, operation: { id: '03', name: 'Киперка', sortOrder: 30 } },
    { orderId: 'O1', index: 4, parallelGroup: 1, operation: { id: '0001', name: 'Подгиб низа', sortOrder: 40 } },
    { orderId: 'O1', index: 5, parallelGroup: 1, operation: { id: '16', name: 'Распошив рукав', sortOrder: 50 } },
    { orderId: 'O1', index: 6, parallelGroup: null, operation: { id: '05', name: 'ОТК', sortOrder: 60 } },
  ];
  const SPEC: CollapseSpec = {
    mergeOpIds: ['0001', '16'],
    targetOpId: '04',
    targetName: 'Распошив',
    targetSortOrder: 45,
  };

  test('COLLAPSED: низ+рукав сливаются в один шаг 04 на максимальном индексе', () => {
    const { steps } = collapseSewingView(STEPS, [], new Map([['O1', SPEC]]));
    const ops = steps.map((s) => s.operation.id).sort();
    expect(ops).toEqual(['03', '04', '05']); // 0001 и 16 убраны, добавлен 04
    const target = steps.find((s) => s.operation.id === '04')!;
    expect(target.index).toBe(5); // max(4,5) — согласовано с evaluateRouteOrder
    expect(target.operation.name).toBe('Распошив');
    expect(target.operation.sortOrder).toBe(45);
  });

  test('COLLAPSED: киперка и ОТК остаются нетронутыми', () => {
    const { steps } = collapseSewingView(STEPS, [], new Map([['O1', SPEC]]));
    expect(steps.find((s) => s.operation.id === '03')!.index).toBe(3);
    expect(steps.find((s) => s.operation.id === '05')!.index).toBe(6);
  });

  test('COLLAPSED: паспорта на низе/рукаве/полном переезжают на шаг 04 (max index)', () => {
    const passports = [
      { orderId: 'O1', currentRouteStepIndex: 4, currentOperationId: '0001', assignedShiftSewingOperationId: '0001' },
      { orderId: 'O1', currentRouteStepIndex: 5, currentOperationId: '16', assignedShiftSewingOperationId: null },
      { orderId: 'O1', currentRouteStepIndex: 5, currentOperationId: '04', assignedShiftSewingOperationId: '04' },
      { orderId: 'O1', currentRouteStepIndex: 3, currentOperationId: '03', assignedShiftSewingOperationId: '03' },
    ];
    const { passports: out } = collapseSewingView(STEPS, passports, new Map([['O1', SPEC]]));
    // низ → 04, индекс 4→5
    expect(out[0].currentOperationId).toBe('04');
    expect(out[0].assignedShiftSewingOperationId).toBe('04');
    expect(out[0].currentRouteStepIndex).toBe(5);
    // рукав → 04
    expect(out[1].currentOperationId).toBe('04');
    // полный 04 уже на 04 / индексе 5 — без изменений
    expect(out[2].currentOperationId).toBe('04');
    expect(out[2].currentRouteStepIndex).toBe(5);
    // киперка не трогается
    expect(out[3].currentOperationId).toBe('03');
    expect(out[3].currentRouteStepIndex).toBe(3);
  });

  test('пустая карта (нет COLLAPSED-заказов) → вход без изменений', () => {
    const { steps, passports } = collapseSewingView(STEPS, [{ orderId: 'O1', currentRouteStepIndex: 4, currentOperationId: '0001', assignedShiftSewingOperationId: null }], new Map());
    expect(steps).toHaveLength(4);
    expect(passports[0].currentOperationId).toBe('0001');
  });

  test('SPLIT-заказ вне карты не трогается, даже если в карте есть другой заказ', () => {
    const steps = [
      ...STEPS,
      { orderId: 'O2', index: 4, parallelGroup: 1, operation: { id: '0001', name: 'Подгиб низа', sortOrder: 40 } },
      { orderId: 'O2', index: 5, parallelGroup: 1, operation: { id: '16', name: 'Распошив рукав', sortOrder: 50 } },
    ];
    const { steps: out } = collapseSewingView(steps, [], new Map([['O1', SPEC]]));
    // O2 сохраняет обе колонки распошива
    const o2 = out.filter((s) => s.orderId === 'O2').map((s) => s.operation.id).sort();
    expect(o2).toEqual(['0001', '16']);
  });
});
