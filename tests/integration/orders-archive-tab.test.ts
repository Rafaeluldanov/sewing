/**
 * Integration-тесты вкладки «Архив» в списке заказов
 * (`GET /api/orders?tab=…`, см. `OrdersService.list`).
 *
 * Договорённость фичи: архив заказа — производная от статуса
 * (`ORDER_ARCHIVED_STATUSES`, сейчас только `CANCELLED`), отдельного
 * поля `archivedAt` у заказа нет.
 *
 * Сценарии:
 *   1. `?tab=active` не отдаёт отменённые заказы, `?tab=archive` —
 *      только их.
 *   2. Ответ обеих вкладок содержит `tabCounts` с одинаковыми цифрами.
 *   3. Отмена заказа сама переносит его из активных в архив.
 *   4. Без `tab` ручка отдаёт заказы всех статусов — на это
 *      рассчитывают дашборд `/admin` и блок «Заказы клиента».
 *   5. Счётчики вкладок учитывают поиск, но НЕ `status`/`deadline`
 *      (эти фильтры живут только на активной вкладке, UI сбрасывает их
 *      при переключении — иначе «Архив (0)» открывал бы непустой архив).
 *   6. In-memory режим выдачи (фильтр `?deadline=…`) делит выборку на
 *      вкладки по тому же правилу.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import { loginAs, startTestApp, stopTestApp, type TestApp } from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

describeWithDb('integration — вкладка «Архив» в списке заказов', () => {
  let t: TestApp;
  let seed: SeedResult;
  let cookie: string;

  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await stopTestApp(t);
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    seed = await seedMinimal(t.prisma);
    cookie = loginAs(t, seed.employees['shop-chief']);
  });

  async function createOrder(): Promise<{ id: string; number: string }> {
    const res = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookie)
      .send({
        orderDate: new Date().toISOString(),
        productId: seed.product.id,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 10 }],
      });
    expect(res.status).toBe(201);
    return { id: res.body.id, number: res.body.number };
  }

  async function cancelOrder(id: string) {
    const res = await request(t.app.getHttpServer())
      .post(`/api/orders/${id}/cancel`)
      .set('Cookie', cookie);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('CANCELLED');
  }

  function list(qs: string) {
    return request(t.app.getHttpServer())
      .get(`/api/orders${qs}`)
      .set('Cookie', cookie);
  }
  function ids(body: { items: Array<{ id: string }> }): string[] {
    return body.items.map((i) => i.id);
  }

  // -------------------------------------------------------------------------
  // 1-3. Отмена уводит заказ в архив
  // -------------------------------------------------------------------------

  test('отменённый заказ уходит из «Активных» в «Архив», счётчики сходятся', async () => {
    const live = await createOrder();
    const cancelled = await createOrder();

    // До отмены оба заказа — активные.
    const before = await list('?tab=active');
    expect(before.status).toBe(200);
    expect(ids(before.body).sort()).toEqual([live.id, cancelled.id].sort());
    expect(before.body.tabCounts).toEqual({ active: 2, archive: 0 });

    await cancelOrder(cancelled.id);

    const active = await list('?tab=active');
    expect(ids(active.body)).toEqual([live.id]);
    expect(active.body.total).toBe(1);
    expect(active.body.tabCounts).toEqual({ active: 1, archive: 1 });

    const archive = await list('?tab=archive');
    expect(ids(archive.body)).toEqual([cancelled.id]);
    expect(archive.body.total).toBe(1);
    // Счётчики одинаковы на обеих вкладках — это одна и та же картина.
    expect(archive.body.tabCounts).toEqual({ active: 1, archive: 1 });
  });

  // -------------------------------------------------------------------------
  // 4. Легаси-режим без `tab`
  // -------------------------------------------------------------------------

  test('без `tab` ручка отдаёт заказы всех статусов и не считает вкладки', async () => {
    const live = await createOrder();
    const cancelled = await createOrder();
    await cancelOrder(cancelled.id);

    const all = await list('');
    expect(ids(all.body).sort()).toEqual([live.id, cancelled.id].sort());
    expect(all.body.total).toBe(2);
    expect(all.body.tabCounts).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 5. Что счётчики учитывают, а что нет
  // -------------------------------------------------------------------------

  test('счётчики учитывают поиск', async () => {
    const live = await createOrder();
    const cancelled = await createOrder();
    await cancelOrder(cancelled.id);

    // Поиск по номеру живого заказа: в архиве под этот поиск — пусто.
    const res = await list(`?tab=active&search=${encodeURIComponent(live.number)}`);
    expect(ids(res.body)).toEqual([live.id]);
    expect(res.body.tabCounts).toEqual({ active: 1, archive: 0 });
  });

  test('счётчики НЕ сужаются фильтром `status` активной вкладки', async () => {
    await createOrder();
    const cancelled = await createOrder();
    await cancelOrder(cancelled.id);

    // Фильтр status=DRAFT живёт только на активной вкладке; архив при
    // переключении его сбрасывает, поэтому счётчик архива обязан
    // остаться честным (иначе «Архив (0)» открыл бы непустой архив).
    const res = await list('?tab=active&status=DRAFT');
    expect(res.body.total).toBe(1);
    expect(res.body.tabCounts).toEqual({ active: 1, archive: 1 });
  });

  // -------------------------------------------------------------------------
  // 6. In-memory режим (фильтр по бакету срока)
  // -------------------------------------------------------------------------

  test('фильтр `deadline` (in-memory режим) уважает вкладку и счётчики', async () => {
    const live = await createOrder();
    const cancelled = await createOrder();
    await cancelOrder(cancelled.id);

    // Оба заказа без dueDate → бакет NO_DUE_DATE. Отменённый в него не
    // попадает: `evaluateOrderDeadline` уводит CANCELLED в DONE-tier.
    const res = await list('?tab=active&deadline=NO_DUE_DATE');
    expect(ids(res.body)).toEqual([live.id]);
    expect(res.body.total).toBe(1);
    expect(res.body.tabCounts).toEqual({ active: 1, archive: 1 });

    // Архив под тем же фильтром пуст, но сам архив — нет.
    const archive = await list('?tab=archive&deadline=NO_DUE_DATE');
    expect(archive.body.items).toHaveLength(0);
    expect(archive.body.tabCounts).toEqual({ active: 1, archive: 1 });
  });
});
