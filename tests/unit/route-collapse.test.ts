/**
 * Unit-тесты чистой логики распознавания сворачиваемой группы сплит-распошива
 * (`apps/api/src/modules/passports/route-collapse.ts`).
 *
 * Покрываем findCollapsibleGroup: распознавание группы {рукав, низ}+киперка,
 * случай уже-свёрнутого маршрута, отсутствие группы, отсутствие принимающей
 * станции. Необратимое сворачивание удалено (Вариант B, см. route-mode.ts) —
 * режим SPLIT/COLLAPSED теперь вычисляется на лету, тесты режима — в
 * `route-mode.test.ts`.
 */
import { describe, expect, test } from 'vitest';
import {
  findCollapsibleGroup,
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
