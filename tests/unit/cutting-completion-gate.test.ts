/**
 * Unit-тесты гейта «Раскрой завершён» —
 * `listCuttingCompletionProblems` (`packages/shared/src/cutting-tasks.ts`).
 *
 * Функция общая для двух сторон: клиент (`apps/web/app/cutter/[id]/cutting-form.tsx`,
 * кнопка «Раскрой завершён») и backend (`CuttingTasksService.complete` →
 * `CUTTING_TASK_COMPLETION_INCOMPLETE`). Проверяется только то, что уходит в
 * payload: ЗАКРЫТЫЕ расклады форма не шлёт (backend их не принимает,
 * `CUTTING_LAY_LOCKED`), поэтому «раскладов в payload нет» ≠ «раскладов нет».
 *
 * Отдельный тест на `hasClosedLays` — регрессия на реальный залёт (заказ
 * 02-00002, 30.07): единственный расклад был закрыт кнопкой «Расклад готов»,
 * payload ушёл пустым, клиентское зеркало гейта отвечало «нет ни одного
 * расклада» — задача навсегда `IN_PROGRESS`, заказ заперт в «Ждём расклад».
 */
import { expect, test } from 'vitest';

import { listCuttingCompletionProblems } from '@sewing/shared/cutting-tasks';

const fullLay = {
  laySizes: [{ sizeId: 'M', perLayerQty: 2 }],
  rolls: [{ ordinal: 1, layers: 10, variantId: null }],
};

test('заполненный расклад → проблем нет', () => {
  expect(listCuttingCompletionProblems([fullLay])).toEqual([]);
});

test('раскладов нет и закрытых нет → «нет ни одного расклада»', () => {
  expect(listCuttingCompletionProblems([])).toEqual(['нет ни одного расклада']);
});

test('пустой payload при закрытых раскладах → проблем нет', () => {
  expect(listCuttingCompletionProblems([], (id) => id, { hasClosedLays: true })).toEqual(
    [],
  );
});

test('незаполненный расклад ругается и при закрытых раскладах', () => {
  const problems = listCuttingCompletionProblems(
    [{ laySizes: [{ sizeId: 'M', perLayerQty: 0 }], rolls: [] }],
    (id) => (id === 'M' ? 'M' : id),
    { hasClosedLays: true },
  );
  expect(problems).toEqual([
    'расклад 1: не заполнено «на настиле» у размеров M',
    'расклад 1: нет ни одного рулона',
  ]);
});

test('номер в сообщении берётся из `ordinal`, а не из индекса', () => {
  const problems = listCuttingCompletionProblems([
    { ordinal: 7, laySizes: [], rolls: [] },
  ]);
  expect(problems[0]).toContain('расклад 7:');
});
