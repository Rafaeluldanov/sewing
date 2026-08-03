/**
 * Smoke-тесты вкладки «Заказы» кабинета мастера (маршруты заказов +
 * правка маршрута холстом с телефона).
 *
 * Структурные инварианты, которые дёшево проверить без Nest / Prisma:
 *   1. backend-модуль `master-orders` существует и подключён в AppModule,
 *      ручка read-only и под теми же ролями, что остальной кабинет;
 *   2. ГЛАВНОЕ: мастеру открыта РОВНО ОДНА write-ручка amendments —
 *      `PUT route`. Количество, размерность и операции (деньги и план)
 *      остаются менеджеру заказа; расширение этого списка должно быть
 *      осознанным, а не побочным эффектом рефакторинга;
 *   3. server-actions вкладки не экспортируют ничего, кроме async-функций
 *      (`'use server'`-файл с объектом роняет страницу в рантайме, при
 *      зелёных tsc/lint/build);
 *   4. UI: вкладка есть в кабинете, холст открывается в тач-режиме
 *      (`compact`), а в тач-режиме микро-кнопки внутри чипа не рисуются —
 *      иначе пальцем по ним не попасть.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  MASTER_ORDER_TABS,
  MASTER_ORDER_TAB_STATUSES,
} from '../../packages/shared/src/master-orders';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relative: string): string {
  return readFileSync(path.join(repoRoot, relative), 'utf8');
}

describe('master-orders smoke — backend', () => {
  test('модуль подключён в AppModule, контроллер read-only и под ролями кабинета', () => {
    const appModule = readSrc('apps/api/src/app.module.ts');
    expect(appModule).toMatch(/MasterOrdersModule/);

    const controller = readSrc(
      'apps/api/src/modules/master-orders/master-orders.controller.ts',
    );
    expect(controller).toMatch(/@Controller\(['"]master\/orders['"]\)/);
    expect(controller).toMatch(
      /@Roles\('SHOPFLOOR_MASTER', 'SHOP_MANAGER', 'ADMIN'\)/,
    );
    // Read-only: список заказов ничего не мутирует, правка маршрута
    // идёт ручкой order-amendments.
    expect(controller).not.toMatch(/@(Post|Put|Patch|Delete)\(/);
  });

  test('вкладки списка покрывают все статусы, кроме CANCELLED', () => {
    const all = MASTER_ORDER_TABS.flatMap((t) => [
      ...MASTER_ORDER_TAB_STATUSES[t],
    ]);
    expect(new Set(all).size).toBe(all.length); // статус не в двух вкладках
    expect(all).not.toContain('CANCELLED');
    expect(all).toContain('IN_PRODUCTION');
    expect(all).toContain('DRAFT');
  });
});

describe('master-orders smoke — RBAC правки маршрута', () => {
  const controller = readSrc(
    'apps/api/src/modules/order-amendments/order-amendments.controller.ts',
  );

  test('мастеру открыт PUT route', () => {
    const routeBlock = controller.slice(controller.indexOf("@Put('route')"));
    expect(routeBlock).toMatch(
      /@Roles\('ADMIN', 'SHOP_MANAGER', 'SHOPFLOOR_MASTER'\)/,
    );
  });

  test('и только он: количество, размерность и операции мастеру закрыты', () => {
    // Все `@Roles` модуля, кроме строки правки маршрута, обязаны
    // остаться менеджерскими.
    const roleLines = controller
      .split('\n')
      .filter((l) => l.includes('@Roles('));
    const masterLines = roleLines.filter((l) => l.includes('SHOPFLOOR_MASTER'));
    expect(masterLines).toHaveLength(1);
    expect(roleLines.length).toBeGreaterThan(1);
  });
});

describe('master-orders smoke — web', () => {
  test("server actions вкладки экспортируют только async-функции", () => {
    const actions = readSrc('apps/web/app/master/master-orders-actions.ts');
    expect(actions.startsWith("'use server';")).toBe(true);
    // `export const …` / `export interface` в 'use server' роняет всю
    // страницу в рантайме — типы отдаём через `export type`.
    expect(actions).not.toMatch(/^export (const|interface|class|let|var) /m);
    for (const m of actions.matchAll(/^export (?!type )(\w+)/gm)) {
      expect(m[1]).toBe('async');
    }
  });

  test('вкладка «Заказы» есть в кабинете и живёт под общим флагом amendments', () => {
    const client = readSrc('apps/web/app/master/master-page-client.tsx');
    expect(client).toMatch(/OrdersRoutesView/);
    expect(client).toMatch(/orderRoutesEnabled/);
    expect(client).toMatch(/'orders'/);

    const page = readSrc('apps/web/app/master/page.tsx');
    expect(page).toMatch(/isOrderAmendmentsEnabled/);
  });

  test('холст маршрута открывается у мастера в тач-режиме', () => {
    const view = readSrc('apps/web/app/master/orders-routes-view.tsx');
    expect(view).toMatch(/RouteAmendmentTab/);
    expect(view).toMatch(/compact/);
    // Правка идёт существующей ручкой: своей копии применения нет.
    expect(view).not.toMatch(/applyRouteAmendment\(/);
  });

  test('в тач-режиме микро-кнопки внутри чипа не рисуются', () => {
    const tab = readSrc(
      'apps/web/components/orders/amendments/route-amendment-tab.tsx',
    );
    expect(tab).toMatch(/!step\.frozen && !compact/);
    // Тап по слоту — единственный способ вставить операцию пальцем.
    expect(tab).toMatch(/openPoolAt/);
    expect(tab).toMatch(/rb-touch__acts/);
  });

  test('из «Расхождений» можно уйти в маршрут заказа', () => {
    const div = readSrc('apps/web/app/master/divergences-view.tsx');
    expect(div).toMatch(/onOpenRoute/);
    expect(div).toMatch(/Поправить маршрут/);
    // Наряд-допуск остаётся: правка маршрута не закрывает уже сделанную
    // мимо маршрута работу.
    expect(div).toMatch(/выдать допуск/);
  });
});
