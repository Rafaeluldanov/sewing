/**
 * Smoke-тест «Стоимость операции правится там же, где маршрут».
 *
 * Состав маршрута и деньги маршрута жили на разных поверхностях: холст в
 * окне «Изменить маршрут» / «Изменить в производстве» и отдельный редактор
 * во вкладке «Операции», хотя окно правки у них одно и то же (всё, кроме
 * `DONE`/`CANCELLED`). Теперь тот же редактор встроен в окно вкладкой
 * «Расценки» (`RatesAmendmentTab`).
 *
 * Плюс регрессия 31.08.2026 (прод, `02-00023`): маршрут с параллельной
 * группой ПОЗАДИ фронта не сохранялся вовсе — клиент отправлял
 * замороженный префикс с `parallelGroup: null` и получал
 * `409 AMENDMENT_ROUTE_FRONTIER_CHANGED`. Арифметику стережёт unit-тест
 * `unit/route-amendment-draft.test.ts`, здесь — только то, что условие
 * сброса связей не вернулось к `i <= minSlot`.
 *
 * Полноценного React-рендерера в vitest нет (см.
 * `order-route-snapshot.smoke.test.ts`), поэтому контракт фиксируем
 * текстовыми проверками исходников.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

const DRAFT = 'apps/web/components/orders/amendments/route-draft.ts';
const DIALOG = 'apps/web/components/orders/amendments/order-amendment-dialog.tsx';
const BUTTON = 'apps/web/components/orders/amendments/order-amendment-button.tsx';
const RATES_TAB = 'apps/web/components/orders/amendments/rates-amendment-tab.tsx';
const EDITOR =
  'apps/web/components/orders/operations/order-route-overrides-editor.tsx';
const EDITOR_DATA =
  'apps/web/components/orders/operations/route-overrides-editor-data.ts';
const UNIFIED =
  'apps/web/components/orders/operations/order-operations-unified-table.tsx';
const PROD_TAB = 'apps/web/components/orders/view/tabs/order-production-tab.tsx';
const MASTER = 'apps/web/app/master/orders-routes-view.tsx';

describe('замороженный префикс уходит на бэкенд как в снимке', () => {
  test('связи замороженных шагов не сбрасываются', () => {
    const src = readSrc(DRAFT);
    // Старое условие ронял любую правку заказа с параллельной группой
    // позади фронта в 409.
    expect(src).not.toMatch(/i <= minSlot && s\.linkedWithPrev/);
    expect(src).toMatch(/if \(!s\.linkedWithPrev \|\| i < minSlot\) return s;/);
    // Шаг на первой свободной позиции сохраняет связь, только если он там
    // и стоял в снимке.
    expect(src).toMatch(/i === minSlot && s\.sourceIndex !== minSlot/);
  });

  test('номера параллельных групп префикса берутся из снимка', () => {
    const src = readSrc(DRAFT);
    expect(src).toMatch(/snapshotGroup/);
    expect(src).toMatch(/out\[i\]\.parallelGroup = s\.snapshotGroup/);
    // Новые группы нумеруются выше замороженных — иначе разные группы
    // получили бы один номер.
    expect(src).toMatch(/group = Math\.max\(group, s\.snapshotGroup\)/);
  });
});

describe('вкладка «Расценки» в окне правки маршрута', () => {
  test('окно рисует вкладку и вставляет RatesAmendmentTab', () => {
    const src = readSrc(DIALOG);
    expect(src).toMatch(/data-testid="amend-tab-rates"/);
    expect(src).toMatch(/tab === 'rates' && ratesState/);
    expect(src).toMatch(/<RatesAmendmentTab/);
    // Поразмерная сетка в узкое окно не влезает.
    expect(src).toMatch(/tab === 'route' \|\| tab === 'rates'/);
  });

  test('состояние вкладки прокинуто от кнопки', () => {
    expect(readSrc(BUTTON)).toMatch(/ratesState=\{ratesState\}/);
  });

  test('вкладка зовёт ту же ручку route-overrides встроенным редактором', () => {
    const src = readSrc(RATES_TAB);
    expect(src).toMatch(/<OrderRouteOverridesEditor/);
    expect(src).toMatch(/variant="embedded"/);
    // Правка денег не переписывает уже начисленное — предупреждаем.
    expect(src).toMatch(/задним числом не пересчитывается/);
  });

  test('редактор умеет встроенный режим, не ломая вкладку «Операции»', () => {
    const src = readSrc(EDITOR);
    expect(src).toMatch(/variant = 'inline'/);
    expect(src).toMatch(/const embedded = variant === 'embedded'/);
    expect(src).toMatch(/useState\(embedded\)/);
    expect(src).toMatch(/if \(!editing && !embedded\)/);
  });
});

describe('данные редактора собираются одним кодом на две поверхности', () => {
  test('сборка вынесена из таблицы «Операции»', () => {
    const data = readSrc(EDITOR_DATA);
    expect(data).toMatch(/export function buildRouteOverrideEditorSizes/);
    expect(data).toMatch(/export function buildRouteOverrideEditorSteps/);
    expect(data).toMatch(/export async function loadRouteOverridesEditorData/);
    // Гейт статуса совпадает с бэкендом `updateRouteOverrides`.
    expect(data).toMatch(/new Set\(\['DONE', 'CANCELLED'\]\)/);

    const unified = readSrc(UNIFIED);
    expect(unified).toMatch(/buildRouteOverrideEditorSteps\(order, data\.operationsById\)/);
  });

  test('вкладка «Производство» грузит расценки только менеджеру', () => {
    const src = readSrc(PROD_TAB);
    expect(src).toMatch(/if \(canManage && operationState\)/);
    expect(src).toMatch(/ratesState = await loadRouteOverridesEditorData\(order\)/);
  });

  test('кабинет мастера остаётся без правки денег', () => {
    const src = readSrc(MASTER);
    expect(src).not.toMatch(/RatesAmendmentTab/);
    expect(src).not.toMatch(/route-overrides/);
  });
});
