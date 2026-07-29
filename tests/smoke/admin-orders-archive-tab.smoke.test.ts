/**
 * Smoke-тесты вкладки «Архив» в списке заказов `/admin/orders`.
 *
 * Договорённость фичи: архив заказа — НЕ отдельный флаг `archivedAt`
 * (как в 9 справочниках админки, см. `shared/archive.ts`), а
 * ПРОИЗВОДНАЯ от статуса: в архив уезжают заказы в
 * `ORDER_ARCHIVED_STATUSES` — сейчас только `CANCELLED`. Иначе
 * появилось бы второе состояние, которое надо синхронизировать с
 * отменой.
 *
 * Проверяем source-level, что:
 *   - shared отдаёт `ORDER_ARCHIVED_STATUSES` / `isOrderArchived`,
 *     query-параметр `tab` и счётчики вкладок `tabCounts`;
 *   - backend `OrdersService.list` честно фильтрует по вкладке и
 *     считает обе цифры под теми же фильтрами;
 *   - `tab` НЕ имеет default-а — легаси-потребители (`/admin` дашборд,
 *     блок «Заказы клиента») продолжают видеть заказы всех статусов;
 *   - web-страница рендерит `AdminArchiveTabs` и не предлагает
 *     «Отменён» в селекте статуса активной вкладки.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  ORDER_ARCHIVED_STATUSES,
  isOrderArchived,
} from '@sewing/shared/orders';

const repoRoot = path.resolve(__dirname, '..', '..');

function read(p: string): string {
  return readFileSync(path.join(repoRoot, p), 'utf8');
}
function exists(p: string): boolean {
  return existsSync(path.join(repoRoot, p));
}

// ---------------------------------------------------------------------------
// 1. Shared — контракт архива
// ---------------------------------------------------------------------------

describe('shared — архив заказов', () => {
  const shared = 'packages/shared/src/orders.ts';

  test('ORDER_ARCHIVED_STATUSES = только CANCELLED', () => {
    expect([...ORDER_ARCHIVED_STATUSES]).toEqual(['CANCELLED']);
  });

  test('isOrderArchived: CANCELLED — да, DONE и рабочие статусы — нет', () => {
    expect(isOrderArchived('CANCELLED')).toBe(true);
    // DONE в архив сознательно НЕ уводим — это нормальный
    // управленческий срез (выработка / себестоимость / сроки).
    expect(isOrderArchived('DONE')).toBe(false);
    expect(isOrderArchived('DRAFT')).toBe(false);
    expect(isOrderArchived('IN_PRODUCTION')).toBe(false);
  });

  test('ListOrdersQuery знает про вкладку, ответ — про счётчики', () => {
    const src = read(shared);
    expect(src).toMatch(/export const ORDER_LIST_TABS = \['active', 'archive'\]/);
    expect(src).toMatch(/tab: OrderListTabSchema\.optional\(\)/);
    expect(src).toMatch(/export interface OrderListTabCounts/);
    expect(src).toMatch(/export interface OrderListResponse/);
    expect(src).toMatch(/tabCounts\?: OrderListTabCounts/);
  });

  test('у `tab` НЕТ default-а — легаси-потребители видят все статусы', () => {
    const src = read(shared);
    expect(src).not.toMatch(/tab: OrderListTabSchema\.default\(/);
  });

  test('отдельного поля archivedAt у заказа не заводили', () => {
    const schema = read('prisma/schema.prisma');
    expect(schema).not.toMatch(/orderArchivedAt|archivedAt\s+DateTime\?\s*\/\/ order/);
  });
});

// ---------------------------------------------------------------------------
// 2. Backend — OrdersService.list
// ---------------------------------------------------------------------------

describe('api — OrdersService.list фильтрует и считает вкладки', () => {
  const service = 'apps/api/src/modules/orders/orders.service.ts';

  test('сервис существует и отдаёт OrderListResponse', () => {
    expect(exists(service)).toBe(true);
    const src = read(service);
    expect(src).toMatch(/async list\(query: ListOrdersQuery\): Promise<OrderListResponse>/);
  });

  test('фильтр вкладки: archive → in, active → notIn', () => {
    const src = read(service);
    expect(src).toMatch(/query\.tab === 'archive'/);
    expect(src).toMatch(/status: \{ in: archivedStatuses \}/);
    expect(src).toMatch(/status: \{ notIn: archivedStatuses \}/);
  });

  test('счётчики вкладок считаются по фильтрам БЕЗ самой вкладки', () => {
    const src = read(service);
    // Счётчики берутся по `where` (общие фильтры), а выдача — по
    // `listWhere` (те же фильтры + вкладка).
    expect(src).toMatch(/tabCountsPromise/);
    expect(src).toMatch(/this\.prisma\.order\.count\(\{ where: listWhere \}\)/);
    expect(src).toMatch(/active: all - archive/);
  });

  test('in-memory режим (deadline/дд.мм) тоже делит выборку на вкладки', () => {
    const src = read(service);
    expect(src).toMatch(/isOrderArchived\(i\.status\) === \(query\.tab === 'archive'\)/);
  });
});

// ---------------------------------------------------------------------------
// 3. Web — /admin/orders
// ---------------------------------------------------------------------------

describe('web — /admin/orders рендерит вкладки «Активные» / «Архив»', () => {
  const page = 'apps/web/app/admin/orders/page.tsx';

  test('страница использует общий AdminArchiveTabs и передаёт tab в запрос', () => {
    const src = read(page);
    expect(src).toMatch(/AdminArchiveTabs/);
    expect(src).toMatch(/basePath="\/admin\/orders"/);
    expect(src).toMatch(/tab,/);
  });

  test('«Отменён» убран из селекта статуса активной вкладки', () => {
    const src = read(page);
    expect(src).toMatch(/ORDER_STATUSES\.filter\(\(s\) => !isOrderArchived\(s\)\)/);
  });

  test('вкладка не теряется при поиске / пагинации / submit-е формы', () => {
    const src = read(page);
    expect(src).toMatch(/tab: tabParam/);
    expect(src).toMatch(/<input type="hidden" name="tab" value="archive" \/>/);
  });

  test('web-обёртка listOrders пробрасывает tab', () => {
    const src = read('apps/web/lib/orders-api.ts');
    expect(src).toMatch(/tab: query\.tab/);
    expect(src).toMatch(/Promise<OrderListResponse>/);
  });
});
