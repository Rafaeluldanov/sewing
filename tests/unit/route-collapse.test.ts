/**
 * Unit-тесты чистой логики сворачивания сплит-маршрута распошива
 * (`apps/api/src/modules/passports/route-collapse.ts`).
 *
 * Покрываем:
 *   - findCollapsibleGroup: распознавание группы {рукав, низ}+киперка,
 *     идемпотентность (после сворачивания группа не находится);
 *   - shouldCollapse: 1 станок / 2 станка / нет перехода / держатель на
 *     рукавном станке;
 *   - buildCollapsedSteps + remapPassport: перепись шагов и переиндексация
 *     паспортов до/в/после группы.
 */
import { describe, expect, test } from 'vitest';
import {
  findCollapsibleGroup,
  shouldCollapse,
  buildCollapsedSteps,
  remapPassport,
  type RouteStepLite,
  type SubstitutionLite,
} from '@sewing/api/modules/passports/route-collapse';

// Маршрут 02 (сплит): крой → [киперка ∥ рукав ∥ низ] → ОТК → ВТО.
const SPLIT_STEPS: RouteStepLite[] = [
  { index: 0, operationId: 'cut', parallelGroup: null },
  { index: 1, operationId: '03', parallelGroup: 2 }, // киперка
  { index: 2, operationId: '16', parallelGroup: 2 }, // рукав (принимающий)
  { index: 3, operationId: '0001', parallelGroup: 2 }, // низ (выделенный)
  { index: 4, operationId: '05', parallelGroup: null }, // ОТК
  { index: 5, operationId: 'wto', parallelGroup: null },
];

const SUBS: SubstitutionLite[] = [
  { satisfiesOpId: '0001', substituteOpId: '04', isReceivingStation: false },
  { satisfiesOpId: '16', substituteOpId: '04', isReceivingStation: true },
];

describe('findCollapsibleGroup', () => {
  test('находит сворачиваемую группу низ+рукав, киперка остаётся', () => {
    const plan = findCollapsibleGroup(SPLIT_STEPS, SUBS);
    expect(plan).not.toBeNull();
    expect(plan!.parallelGroup).toBe(2);
    expect(plan!.targetOpId).toBe('04');
    expect(plan!.receivingOpId).toBe('16');
    expect(plan!.dedicatedOpIds).toEqual(['0001']);
    expect([...plan!.mergeOpIds].sort()).toEqual(['0001', '16']);
    expect(plan!.keepOpIds).toEqual(['03']);
  });

  test('идемпотентность: после сворачивания (нет merge-шагов) группа не находится', () => {
    const collapsed: RouteStepLite[] = [
      { index: 0, operationId: 'cut', parallelGroup: null },
      { index: 1, operationId: '03', parallelGroup: 2 },
      { index: 2, operationId: '04', parallelGroup: 2 },
      { index: 4, operationId: '05', parallelGroup: null },
      { index: 5, operationId: 'wto', parallelGroup: null },
    ];
    expect(findCollapsibleGroup(collapsed, SUBS)).toBeNull();
  });

  test('нет параллельных групп → null', () => {
    const seq: RouteStepLite[] = [
      { index: 0, operationId: 'cut', parallelGroup: null },
      { index: 1, operationId: '04', parallelGroup: null },
    ];
    expect(findCollapsibleGroup(seq, SUBS)).toBeNull();
  });

  test('без явной принимающей станции (нет isReceivingStation) → null', () => {
    const subsNoRecv: SubstitutionLite[] = [
      { satisfiesOpId: '0001', substituteOpId: '04', isReceivingStation: false },
      { satisfiesOpId: '16', substituteOpId: '04', isReceivingStation: false },
    ];
    expect(findCollapsibleGroup(SPLIT_STEPS, subsNoRecv)).toBeNull();
  });
});

describe('shouldCollapse', () => {
  const plan = findCollapsibleGroup(SPLIT_STEPS, SUBS)!;
  const receiving = new Set(['eqSleeve']); // рукав/полный распошив
  // eqLow1/eqLow2 — выделенные низ-станки (не в receiving)

  test('нет перехода (низ закрыт на выделенном станке) → false', () => {
    expect(
      shouldCollapse({
        plan,
        receivingEquipmentIds: receiving,
        lowOrFullFinishes: [{ operationId: '0001', equipmentId: 'eqLow1' }],
        heldOnLow: [],
      }),
    ).toBe(false);
  });

  test('1 станок: низ закрыт на рукавном станке, никто не держит низ → true', () => {
    expect(
      shouldCollapse({
        plan,
        receivingEquipmentIds: receiving,
        lowOrFullFinishes: [{ operationId: '0001', equipmentId: 'eqSleeve' }],
        heldOnLow: [],
      }),
    ).toBe(true);
  });

  test('переход через полный распошив (04) на рукавном станке → true', () => {
    expect(
      shouldCollapse({
        plan,
        receivingEquipmentIds: receiving,
        lowOrFullFinishes: [{ operationId: '04', equipmentId: 'eqSleeve' }],
        heldOnLow: [],
      }),
    ).toBe(true);
  });

  test('2 станка: второй ещё держит низ на выделенном станке → false', () => {
    expect(
      shouldCollapse({
        plan,
        receivingEquipmentIds: receiving,
        lowOrFullFinishes: [{ operationId: '0001', equipmentId: 'eqSleeve' }],
        heldOnLow: [{ holderEquipmentId: 'eqLow2' }],
      }),
    ).toBe(false);
  });

  test('2 станка: оба перестали держать низ отдельно → true', () => {
    expect(
      shouldCollapse({
        plan,
        receivingEquipmentIds: receiving,
        lowOrFullFinishes: [{ operationId: '0001', equipmentId: 'eqSleeve' }],
        heldOnLow: [{ holderEquipmentId: 'eqSleeve' }], // держит, но на рукавном станке
      }),
    ).toBe(true);
  });

  test('старое событие без станка (equipmentId=null) не считается переходом', () => {
    expect(
      shouldCollapse({
        plan,
        receivingEquipmentIds: receiving,
        lowOrFullFinishes: [{ operationId: '0001', equipmentId: null }],
        heldOnLow: [],
      }),
    ).toBe(false);
  });
});

describe('buildCollapsedSteps + remapPassport', () => {
  const plan = findCollapsibleGroup(SPLIT_STEPS, SUBS)!;
  const result = buildCollapsedSteps(SPLIT_STEPS, plan);
  const oldByIndex = new Map(SPLIT_STEPS.map((s) => [s.index, s]));

  test('merge-шаги удалены, целевой шаг на минимальном освободившемся индексе', () => {
    // merge-индексы 2 (рукав) и 3 (низ) → целевой берёт 2.
    expect(result.targetIndex).toBe(2);
    const ops = result.newSteps.map((s) => s.operationId);
    expect(ops).not.toContain('16');
    expect(ops).not.toContain('0001');
    expect(ops).toContain('04');
    const target = result.newSteps.find((s) => s.operationId === '04')!;
    expect(target.index).toBe(2);
    // киперка осталась в группе → целевой шаг сохраняет parallelGroup.
    expect(target.parallelGroup).toBe(2);
  });

  test('киперка сохраняет индекс и группу', () => {
    const kip = result.newSteps.find((s) => s.operationId === '03')!;
    expect(kip.index).toBe(1);
    expect(kip.parallelGroup).toBe(2);
  });

  test('паспорт на низе → переезжает на полный распошив', () => {
    const r = remapPassport(
      { currentRouteStepIndex: 3, currentOperationId: '0001' },
      oldByIndex,
      result,
      plan,
    );
    expect(r).toEqual({ currentRouteStepIndex: 2, currentOperationId: '04' });
  });

  test('паспорт на рукаве → переезжает на полный распошив', () => {
    const r = remapPassport(
      { currentRouteStepIndex: 2, currentOperationId: '16' },
      oldByIndex,
      result,
      plan,
    );
    expect(r).toEqual({ currentRouteStepIndex: 2, currentOperationId: '04' });
  });

  test('паспорт после группы (ОТК) → операция та же, индекс сохранён', () => {
    const r = remapPassport(
      { currentRouteStepIndex: 4, currentOperationId: '05' },
      oldByIndex,
      result,
      plan,
    );
    expect(r).toEqual({ currentRouteStepIndex: 4, currentOperationId: '05' });
  });

  test('паспорт без индекса маршрута → не трогаем', () => {
    expect(
      remapPassport(
        { currentRouteStepIndex: null, currentOperationId: null },
        oldByIndex,
        result,
        plan,
      ),
    ).toBeNull();
  });

  test('группа без киперки вырождается: целевой шаг становится последовательным', () => {
    const pairOnly: RouteStepLite[] = [
      { index: 0, operationId: 'cut', parallelGroup: null },
      { index: 1, operationId: '16', parallelGroup: 2 },
      { index: 2, operationId: '0001', parallelGroup: 2 },
      { index: 3, operationId: '05', parallelGroup: null },
    ];
    const p = findCollapsibleGroup(pairOnly, SUBS)!;
    const r = buildCollapsedSteps(pairOnly, p);
    const target = r.newSteps.find((s) => s.operationId === '04')!;
    expect(target.parallelGroup).toBeNull();
  });
});
