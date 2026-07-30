/**
 * Smoke — фича «Правка потребности на любой стадии».
 *
 * Требование владельца: потребность заказа должна правиться на любой
 * стадии (ошиблись в расчёте / доуточнили) прямо во вкладке
 * «Потребности» карточки заказа, а себестоимость за изделие — сама
 * догонять правку, без второго клика.
 *
 * Ключевые инварианты, которые тут сторожатся (все ломались бы молча):
 *
 *   1. состав СИСТЕМНОЙ строки больше не отбивается 409
 *      `WORKSHOP_NEED_NOT_MANUAL` — этот гейт остаётся только на
 *      физическом удалении строки;
 *   2. правка помечается `manualEditAt`, и пересчёт потребности без
 *      `force` такую строку не затирает (иначе ручная норма молча
 *      вернулась бы к расчётной — ровно та ловушка, что была с
 *      ре-синком маршрута из шаблона);
 *   3. после правки зовётся `syncAfterNeedsChange` — автопересчёт
 *      сметы; при отказе ставится `costEstimateStaleAt`, а вкладка
 *      рисует плашку с кнопкой «Пересчитать»;
 *   4. правка разрешена вплоть до `DONE` включительно;
 *   5. во вкладке есть UI правки (карандаш в строке + «Добавить
 *      строку»), а не только ссылка на экран закупщика.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('правка потребности на любой стадии — backend', () => {
  const service = read(
    'apps/api/src/modules/workshop-needs/workshop-needs.service.ts',
  );
  const gate = read('apps/api/src/common/order-material-correction.ts');
  const estimates = read(
    'apps/api/src/modules/orders/order-cost-estimates.service.ts',
  );

  test('состав правится у любой строки: NOT_MANUAL больше не бросается в update', () => {
    const updateBody = service.slice(
      service.indexOf('async update('),
      service.indexOf('async cancel('),
    );
    expect(updateBody).not.toMatch(/WorkshopNeedNotManualException/);
    // Но гейт по статусу заказа на состав — остаётся.
    expect(updateBody).toMatch(/assertOrderMaterialCorrectionAllowed/);
  });

  test('физическое удаление по-прежнему только для ручных строк', () => {
    const deleteBody = service.slice(service.indexOf('async deleteManual('));
    expect(deleteBody).toMatch(/WorkshopNeedNotManualException/);
  });

  test('правка помечается manualEditAt и хранит исходное количество', () => {
    expect(service).toMatch(/data\.manualEditAt = new Date\(\)/);
    expect(service).toMatch(/data\.calculatedQtyOriginal = existing\.calculatedQty/);
  });

  test('пересчёт потребности не затирает правленную руками строку', () => {
    expect(service).toMatch(/manualEditAt: true/);
    expect(service).toMatch(/e\.status !== 'CALCULATED' \|\| e\.manualEditAt != null/);
  });

  test('после правки/добавления/удаления/гашения зовётся автопересчёт сметы', () => {
    const calls = service.match(/syncAfterNeedsChange\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(4);
  });

  test('правка разрешена вплоть до DONE, но не в DRAFT/CANCELLED', () => {
    expect(gate).toMatch(/OrderStatus\.DONE/);
    expect(gate).not.toMatch(/OrderStatus\.CANCELLED,/);
  });

  test('автопересчёт не бросает, а ставит отметку «себестоимость устарела»', () => {
    expect(estimates).toMatch(/async syncAfterNeedsChange\(/);
    expect(estimates).toMatch(/costEstimateStaleAt: new Date\(\)/);
    // Успешный пересчёт отметку снимает.
    expect(estimates).toMatch(/costEstimateStaleAt: null/);
    // Пересчёт доступен и на выпущенном заказе.
    expect(estimates).toMatch(/order\.status !== OrderStatus\.DONE/);
  });

  test('одинаковый план не плодит версию сметы', () => {
    expect(estimates).toMatch(/function samePlanAsEstimate\(/);
  });
});

describe('правка потребности на любой стадии — UI вкладки «Потребности»', () => {
  const editor = read(
    'apps/web/components/orders/materials/order-need-editor.tsx',
  );
  const table = read(
    'apps/web/components/orders/materials/order-materials-unified-table.tsx',
  );
  const tab = read('apps/web/components/orders/view/tabs/order-needs-tab.tsx');
  const actions = read('apps/web/app/orders/actions.ts');

  test('окно правки умеет сохранить, погасить и удалить строку', () => {
    expect(editor).toMatch(/updateOrderNeedAction/);
    expect(editor).toMatch(/cancelOrderNeedAction/);
    expect(editor).toMatch(/deleteOrderNeedAction/);
    expect(editor).toMatch(/createManualWorkshopNeedAction/);
  });

  test('таблица материалов показывает карандаш и «Добавить строку» при canEdit', () => {
    expect(table).toMatch(/canEdit/);
    expect(table).toMatch(/OrderNeedEditor/);
    expect(table).toMatch(/mode="create"/);
  });

  test('вкладка разрешает правку менеджеру вплоть до DONE', () => {
    expect(tab).toMatch(/order\.status === 'DONE'/);
    expect(tab).toMatch(/canEdit=\{correctionAllowed\}/);
  });

  test('вкладка рисует плашку «себестоимость устарела» с пересчётом', () => {
    expect(tab).toMatch(/orderCostEstimateStaleAt/);
    expect(tab).toMatch(/RecalcCostButton/);
  });

  test('server actions заведены на любую строку, не только ручную', () => {
    expect(actions).toMatch(/export async function updateOrderNeedAction\(/);
    expect(actions).toMatch(/export async function cancelOrderNeedAction\(/);
    expect(actions).toMatch(/export async function deleteOrderNeedAction\(/);
  });
});
