/**
 * Smoke-тест snapshot маршрута в карточке заказа (`/orders/[id]`).
 *
 * Полноценного React-рендерера в vitest у нас нет (см.
 * `seamstress-feedback.smoke.test.ts`, `qc-collapsed-row.smoke.test.ts`),
 * поэтому идём текстовыми проверками исходников — фиксируем контракт
 * между `apps/web/app/orders/[id]/page.tsx` и `OrderDetailDto.routeSteps`
 * (см. `docs/screens.md §7.3`, `docs/api.md §4`).
 *
 * Покрываем:
 *   1. Страница импортирует `OrderRouteStepDto` и рендерит секцию
 *      «Маршрут производства».
 *   2. Источник истины — snapshot `order.routeSteps` (а НЕ живой
 *      `RouteTemplate`), и для непустого snapshot рендерится `<ol>`
 *      со строками вида «operationName (operationCode)».
 *   3. Пустой snapshot → нейтральный empty-state
 *      «Маршрут для заказа не зафиксирован», без падений.
 *   4. Read-only: нет edit-контролов, drag/drop, timeline и прогресса
 *      паспортов в этой секции.
 *   5. Shared DTO объявляет `routeSteps: OrderRouteStepDto[]` в
 *      `OrderDetailDto` и реэкспортирует тип из `@sewing/shared/orders`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('order detail page — route snapshot section', () => {
  test('страница импортирует OrderRouteStepDto и подключает секцию', () => {
    const src = readSrc('apps/web/app/orders/[id]/page.tsx');
    expect(src).toMatch(/OrderRouteStepDto/);
    expect(src).toMatch(/from '@sewing\/shared\/orders'/);
    // Секция включена в JSX страницы и получает snapshot заказа.
    expect(src).toMatch(/<RouteSnapshotCard steps=\{order\.routeSteps\} \/>/);
  });

  test('заголовок секции — «Маршрут производства»', () => {
    const src = readSrc('apps/web/app/orders/[id]/page.tsx');
    expect(src).toMatch(/Маршрут производства/);
  });

  test('непустой snapshot → ol со строками «operationName (operationCode)»', () => {
    const src = readSrc('apps/web/app/orders/[id]/page.tsx');
    // Список шагов — нумерованный (ol), нумерация совпадает с index+1
    // (snapshot уже отсортирован бэкендом по index ASC).
    expect(src).toMatch(/<ol[\s\S]*steps\.map\(\(s\)/);
    expect(src).toMatch(/s\.operationName/);
    expect(src).toMatch(/s\.operationCode/);
  });

  test('пустой snapshot → нейтральный empty-state', () => {
    const src = readSrc('apps/web/app/orders/[id]/page.tsx');
    expect(src).toMatch(/steps\.length === 0/);
    expect(src).toMatch(/Маршрут для заказа не зафиксирован/);
  });

  test('секция read-only: нет edit-контролов / drag-drop / прогресса паспортов', () => {
    const src = readSrc('apps/web/app/orders/[id]/page.tsx');
    const idx = src.indexOf('function RouteSnapshotCard');
    expect(idx).toBeGreaterThan(0);
    const end = src.indexOf('\n}\n', idx);
    expect(end).toBeGreaterThan(idx);
    const block = src.slice(idx, end);
    // Никаких кнопок, форм, draggable / drop / drag* атрибутов
    // и никакого прогресса паспортов в этой секции.
    expect(block).not.toMatch(/<button/);
    expect(block).not.toMatch(/onClick/);
    expect(block).not.toMatch(/onSubmit/);
    expect(block).not.toMatch(/draggable/);
    expect(block).not.toMatch(/onDrag/);
    expect(block).not.toMatch(/onDrop/);
    expect(block).not.toMatch(/currentRouteStepIndex/);
    expect(block).not.toMatch(/passport/i);
    // Источник — именно snapshot, а не живой RouteTemplate.
    expect(block).not.toMatch(/RouteTemplate/);
  });

  test('Shared DTO: OrderDetailDto содержит routeSteps и реэкспортирует тип', () => {
    const dto = readSrc('packages/shared/src/orders.ts');
    expect(dto).toMatch(/routeSteps:\s*OrderRouteStepDto\[\]/);
    expect(dto).toMatch(/export type \{ OrderRouteStepDto \}/);
  });
});
