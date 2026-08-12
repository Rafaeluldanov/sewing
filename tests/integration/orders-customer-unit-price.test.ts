/**
 * Integration-тесты этапа «Цена продажи за единицу» (см. ТЗ §C,
 * `prisma/schema.prisma::Order.customerUnitPrice`,
 * `apps/api/src/modules/orders/orders.service.ts`,
 * `packages/shared/src/orders.ts`).
 *
 * Покрытие:
 *   1. POST /api/orders с customerUnitPrice + customerCurrency
 *      сохраняет оба поля.
 *   2. POST /api/orders с customerUnitPrice без валюты — backend
 *      подставляет default `RUB` (по ТЗ «default RUB только при
 *      price > 0»).
 *   3. PATCH /api/orders/:id обновляет / стирает (`null`/`""`)
 *      оба поля.
 *   4. GET /api/orders/:id возвращает оба поля как в DTO
 *      (string / 'RUB' | 'USD' | null).
 *   5. Валюта ограничена RUB/USD на уровне DTO — `'EUR'` отбивается
 *      Zod-ом (через прямой POST /api/orders).
 *   6. WorkshopNeed.calculate не трогается полями заказа (защита
 *      от регрессии: ТЗ «Не менять расчёт создания потребностей»).
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import {
  loginAs,
  startTestApp,
  stopTestApp,
  type TestApp,
} from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';
import { createSpecPattern } from '../utils/spec';

describeWithDb(
  'integration — orders.customerUnitPrice / customerCurrency',
  () => {
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

    async function createDraft(body?: {
      customerUnitPrice?: string | number | null;
      customerCurrency?: string | null;
      patternItemId?: string;
    }): Promise<{ id: string; res: request.Response }> {
      const res = await request(t.app.getHttpServer())
        .post('/api/orders')
        .set('Cookie', cookie)
        .send({
          orderDate: '2026-05-15T00:00:00.000Z',
          productId: seed.product.id,
          items: [{ sizeId: seed.sizes.M, qtyPlan: 4 }],
          ...(body ?? {}),
        });
      return { id: res.body?.id ?? '', res };
    }

    // ---------------------------------------------------------------------
    // 1. Create with both fields
    // ---------------------------------------------------------------------

    test('POST /orders: customerUnitPrice + customerCurrency сохраняются', async () => {
      const { res } = await createDraft({
        customerUnitPrice: '2500.00',
        customerCurrency: 'RUB',
      });
      expect(res.status).toBe(201);
      expect(res.body.customerUnitPrice).toBe('2500');
      expect(res.body.customerCurrency).toBe('RUB');

      const detail = await request(t.app.getHttpServer())
        .get(`/api/orders/${res.body.id}`)
        .set('Cookie', cookie)
        .expect(200);
      expect(detail.body.customerUnitPrice).toBe('2500');
      expect(detail.body.customerCurrency).toBe('RUB');
    });

    // ---------------------------------------------------------------------
    // 2. Create with price only — default RUB
    // ---------------------------------------------------------------------

    test('POST /orders с ценой без валюты → backend подставляет RUB', async () => {
      const { res } = await createDraft({
        customerUnitPrice: '1900',
      });
      expect(res.status).toBe(201);
      expect(res.body.customerUnitPrice).toBe('1900');
      expect(res.body.customerCurrency).toBe('RUB');
    });

    test('POST /orders без цены — оба поля null', async () => {
      const { res } = await createDraft();
      expect(res.status).toBe(201);
      expect(res.body.customerUnitPrice).toBeNull();
      expect(res.body.customerCurrency).toBeNull();
    });

    // ---------------------------------------------------------------------
    // 3. PATCH update / clear
    // ---------------------------------------------------------------------

    test('PATCH /orders/:id обновляет цену и валюту', async () => {
      const { id } = await createDraft();
      const r = await request(t.app.getHttpServer())
        .patch(`/api/orders/${id}`)
        .set('Cookie', cookie)
        .send({
          customerUnitPrice: '3500',
          customerCurrency: 'USD',
        });
      expect(r.status).toBe(200);
      expect(r.body.customerUnitPrice).toBe('3500');
      expect(r.body.customerCurrency).toBe('USD');
    });

    test('PATCH /orders/:id с null стирает оба поля', async () => {
      const { id } = await createDraft({
        customerUnitPrice: '2500',
        customerCurrency: 'RUB',
      });
      const r = await request(t.app.getHttpServer())
        .patch(`/api/orders/${id}`)
        .set('Cookie', cookie)
        .send({
          customerUnitPrice: null,
          customerCurrency: null,
        });
      expect(r.status).toBe(200);
      expect(r.body.customerUnitPrice).toBeNull();
      expect(r.body.customerCurrency).toBeNull();
    });

    test('PATCH с пустой строкой («очистить») тоже null-ит', async () => {
      const { id } = await createDraft({
        customerUnitPrice: '2500',
        customerCurrency: 'RUB',
      });
      const r = await request(t.app.getHttpServer())
        .patch(`/api/orders/${id}`)
        .set('Cookie', cookie)
        .send({
          customerUnitPrice: '',
          customerCurrency: '',
        });
      expect(r.status).toBe(200);
      expect(r.body.customerUnitPrice).toBeNull();
      expect(r.body.customerCurrency).toBeNull();
    });

    test('PATCH с одной только ценой (>0) — backend подставляет RUB', async () => {
      const { id } = await createDraft();
      const r = await request(t.app.getHttpServer())
        .patch(`/api/orders/${id}`)
        .set('Cookie', cookie)
        .send({ customerUnitPrice: '4200' });
      expect(r.status).toBe(200);
      expect(r.body.customerUnitPrice).toBe('4200');
      expect(r.body.customerCurrency).toBe('RUB');
    });

    // ---------------------------------------------------------------------
    // 4. Validation: only RUB / USD
    // ---------------------------------------------------------------------

    test('Невалидная валюта (EUR) отбивается с 400', async () => {
      const r = await request(t.app.getHttpServer())
        .post('/api/orders')
        .set('Cookie', cookie)
        .send({
          orderDate: '2026-05-15T00:00:00.000Z',
          productId: seed.product.id,
          items: [{ sizeId: seed.sizes.M, qtyPlan: 4 }],
          customerUnitPrice: '100',
          customerCurrency: 'EUR',
        });
      expect(r.status).toBe(400);
    });

    test('Отрицательная цена отбивается с 400', async () => {
      const r = await request(t.app.getHttpServer())
        .post('/api/orders')
        .set('Cookie', cookie)
        .send({
          orderDate: '2026-05-15T00:00:00.000Z',
          productId: seed.product.id,
          items: [{ sizeId: seed.sizes.M, qtyPlan: 4 }],
          customerUnitPrice: '-1',
        });
      expect(r.status).toBe(400);
    });

    // ---------------------------------------------------------------------
    // 5. List response shape
    // ---------------------------------------------------------------------

    test('GET /orders возвращает customerUnitPrice/Currency в каждом элементе', async () => {
      await createDraft({
        customerUnitPrice: '1234.56',
        customerCurrency: 'USD',
      });
      const r = await request(t.app.getHttpServer())
        .get('/api/orders')
        .set('Cookie', cookie)
        .expect(200);
      const items = r.body.items as Array<{
        id: string;
        customerUnitPrice: string | null;
        customerCurrency: string | null;
      }>;
      expect(items.length).toBeGreaterThan(0);
      const target = items.find((i) => i.customerUnitPrice === '1234.56');
      expect(target).toBeDefined();
      expect(target?.customerCurrency).toBe('USD');
    });

    // ---------------------------------------------------------------------
    // 6. WorkshopNeed.calculate uses quotedPrice as unit price
    //    (regression guard for ТЗ §E «Не менять расчёт создания потребностей»)
    // ---------------------------------------------------------------------

    test('WorkshopNeed.calculate не зависит от customerUnitPrice заказа', async () => {
      // Минимальная спецификация с одной QTY_PER_UNIT-строкой — нам
      // нужен только один материал-fallback для расчёта.
      const pattern = await createSpecPattern(t, cookie, {
        name: 'CustomerPrice probe',
        materialLines: [{ name: 'Этикетка', unit: 'шт', qtyPerUnit: '2' }],
      });
      // Создаём заказ с любой customerUnitPrice — это управленческая
      // цена продажи и НЕ должна влиять на расчёт потребностей.
      const { id } = await createDraft({
        customerUnitPrice: '1000',
        customerCurrency: 'RUB',
        patternItemId: pattern.id,
      });

      const calc = await request(t.app.getHttpServer())
        .post(`/api/orders/${id}/workshop-needs/calculate`)
        .set('Cookie', cookie)
        .send({})
        .expect(201);
      expect(calc.body.count).toBe(1);
      const need = calc.body.needs[0];
      // QTY_PER_UNIT × Σ qtyPlan = 2 × 4 = 8.
      expect(Number(need.calculatedQty)).toBeCloseTo(8, 4);
      // Customer price НЕ касается расчёта; в строке потребности
      // его нет.
      expect(need.quotedPrice).toBeNull();
      expect(need.quotedCurrency).toBeNull();
    });

    // ---------------------------------------------------------------------
    // 7. WorkshopNeed quotedPrice is per-unit (regression guard)
    // ---------------------------------------------------------------------

    test('PATCH WorkshopNeed quotedPrice сохраняется как цена за единицу', async () => {
      const pattern = await createSpecPattern(t, cookie, {
        name: 'Per-unit probe',
        materialLines: [{ name: 'Этикетка', unit: 'шт', qtyPerUnit: '2' }],
      });
      const { id } = await createDraft({ patternItemId: pattern.id });
      const calc = await request(t.app.getHttpServer())
        .post(`/api/orders/${id}/workshop-needs/calculate`)
        .set('Cookie', cookie)
        .send({})
        .expect(201);
      const needId = calc.body.needs[0].id;
      // Закупщик ставит цену за 1 шт = 17.50 ₽; backend сохраняет ровно
      // её, никаких пересчётов в зависимости от qty / customer price.
      const r = await request(t.app.getHttpServer())
        .patch(`/api/workshop-needs/${needId}`)
        .set('Cookie', cookie)
        .send({
          quotedPrice: '17.50',
          quotedCurrency: 'RUB',
        })
        .expect(200);
      expect(r.body.quotedPrice).toBe('17.5');
      expect(r.body.quotedCurrency).toBe('RUB');
      // calculatedQty (8) НЕ конкатенируется с ценой в БД — оно
      // остаётся отдельным полем.
      expect(r.body.calculatedQty).toBe('8');
    });
  },
);
