/**
 * Integration-тесты модуля «Техкарты» (MVP, ADR-0022) — см.
 * `docs/domain.md §19`, `docs/api.md §18`.
 *
 * Покрытие:
 *   1. POST/GET/PATCH `/api/tech-cards` (CRUD шаблонов с упорядоченными
 *      строками `materialLines` / `outsourceLines`).
 *   2. Создание заказа с `techCardId` → 400 на неактивной техкарте.
 *   3. `OrdersService.start()` фиксирует snapshot
 *      `OrderMaterialRequirement[]` и `OrderOutsourceRequirement[]`
 *      с `totalQty = qtyPerUnit * Σ OrderItem.qtyPlan`.
 *   4. Заказ без `techCardId` запускается, snapshot пуст.
 *   5. Правка техкарты (full-replace строк) после запуска заказа НЕ
 *      меняет уже зафиксированный snapshot, и snapshot переживает
 *      даже деактивацию шаблона.
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

describeWithDb('integration — tech cards (MVP, ADR-0022)', () => {
  let t: TestApp;
  let seed: SeedResult;
  let cookies: Record<string, string>;

  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await stopTestApp(t);
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    seed = await seedMinimal(t.prisma);
    cookies = {
      manager: loginAs(t, seed.employees['shop-chief']),
    };
  });

  // ---------------------------------------------------------------------------
  // CRUD шаблонов
  // ---------------------------------------------------------------------------

  test('A. POST /api/tech-cards: создаём шаблон с упорядоченными строками', async () => {
    const r = await request(t.app.getHttpServer())
      .post('/api/tech-cards')
      .set('Cookie', cookies.manager)
      .send({
        code: 'TC-BASIC-1',
        name: 'Базовая техкарта',
        materialLines: [
          { name: 'Кулирка', unit: 'м', qtyPerUnit: '0.55' },
          { name: 'Нитки', unit: 'м', qtyPerUnit: '120', note: 'белые' },
        ],
        outsourceLines: [
          {
            name: 'Шелкография',
            unit: 'шт',
            qtyPerUnit: '1',
            vendorName: 'Print&Co',
          },
          { name: 'Этикетки за партию' }, // unit/qtyPerUnit опц.
        ],
      });
    expect(r.status).toBe(201);
    expect(r.body.code).toBe('TC-BASIC-1');
    expect(r.body.isActive).toBe(true);
    expect(r.body.materialLines).toHaveLength(2);
    expect(r.body.outsourceLines).toHaveLength(2);
    // sortOrder проставляется backend-ом по позиции в массиве (см. сервис).
    expect(
      r.body.materialLines.map((l: { sortOrder: number }) => l.sortOrder),
    ).toEqual([10, 20]);
    expect(
      r.body.outsourceLines.map((l: { sortOrder: number }) => l.sortOrder),
    ).toEqual([10, 20]);
    // qtyPerUnit отдаётся строкой (Decimal-семантика).
    expect(typeof r.body.materialLines[0].qtyPerUnit).toBe('string');
    expect(r.body.outsourceLines[1].unit).toBeNull();
    expect(r.body.outsourceLines[1].qtyPerUnit).toBeNull();

    const list = await request(t.app.getHttpServer())
      .get('/api/tech-cards')
      .set('Cookie', cookies.manager)
      .expect(200);
    const item = list.body.find(
      (c: { code: string }) => c.code === 'TC-BASIC-1',
    );
    expect(item).toBeDefined();
    expect(item.materialLinesCount).toBe(2);
    expect(item.outsourceLinesCount).toBe(2);

    // Уникальность code.
    const dup = await request(t.app.getHttpServer())
      .post('/api/tech-cards')
      .set('Cookie', cookies.manager)
      .send({ code: 'TC-BASIC-1', name: 'Дубль' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('TECH_CARD_CODE_TAKEN');

    // qtyPerUnit > 0 — иначе VALIDATION_ERROR.
    const bad = await request(t.app.getHttpServer())
      .post('/api/tech-cards')
      .set('Cookie', cookies.manager)
      .send({
        code: 'TC-BAD',
        name: 'плохая',
        materialLines: [{ name: 'X', unit: 'м', qtyPerUnit: '0' }],
      });
    expect(bad.status).toBe(400);
  });

  test('A2. PATCH /api/tech-cards/:id: full-replace строк меняет порядок и состав', async () => {
    const created = await createTechCard(t, cookies.manager, {
      code: 'TC-PATCH',
      name: 'Техкарта для patch',
      materialLines: [
        { name: 'A', unit: 'м', qtyPerUnit: '1' },
        { name: 'B', unit: 'м', qtyPerUnit: '2' },
      ],
      outsourceLines: [{ name: 'OutA', unit: 'шт', qtyPerUnit: '1' }],
    });

    // Полностью заменяем materialLines (B→C, добавили D), пустим outsource.
    const patched = await request(t.app.getHttpServer())
      .patch(`/api/tech-cards/${created.id}`)
      .set('Cookie', cookies.manager)
      .send({
        materialLines: [
          { name: 'C', unit: 'кг', qtyPerUnit: '0.25' },
          { name: 'D', unit: 'м', qtyPerUnit: '5' },
        ],
        outsourceLines: [],
      })
      .expect(200);
    expect(patched.body.materialLines.map((l: { name: string }) => l.name)).toEqual([
      'C',
      'D',
    ]);
    expect(patched.body.outsourceLines).toHaveLength(0);
    expect(
      patched.body.materialLines.map((l: { sortOrder: number }) => l.sortOrder),
    ).toEqual([10, 20]);
  });

  // ---------------------------------------------------------------------------
  // Снапшот на заказе
  // ---------------------------------------------------------------------------

  test('B. start(): snapshot копирует строки, totalQty = qtyPerUnit * Σ qtyPlan', async () => {
    const tc = await createTechCard(t, cookies.manager, {
      code: 'TC-SNAP',
      name: 'Snapshot demo',
      materialLines: [
        { name: 'Кулирка', unit: 'м', qtyPerUnit: '0.5' },
        { name: 'Нитки', unit: 'м', qtyPerUnit: '120', note: 'белые' },
      ],
      outsourceLines: [
        { name: 'Шелкография', unit: 'шт', qtyPerUnit: '1' },
        { name: 'Этикетки за партию' },
      ],
    });

    // baseQty = 2 + 3 = 5
    const orderId = await createOrderWithTechCard(
      t,
      seed,
      cookies.manager,
      [
        { sizeId: seed.sizes.M, qtyPlan: 2 },
        { sizeId: seed.sizes.L, qtyPlan: 3 },
      ],
      tc.id,
    );

    const before = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(before.body.techCardId).toBe(tc.id);
    expect(before.body.techCardCode).toBe('TC-SNAP');
    expect(before.body.materialRequirements).toEqual([]);
    expect(before.body.outsourceRequirements).toEqual([]);

    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start`)
      .set('Cookie', cookies.manager)
      .expect(201);

    const after = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}`)
      .set('Cookie', cookies.manager)
      .expect(200);

    expect(after.body.materialRequirements).toHaveLength(2);
    const mat = after.body.materialRequirements;
    // отсортировано по sortOrder ASC
    expect(mat.map((r: { sortOrder: number }) => r.sortOrder)).toEqual([10, 20]);
    expect(mat[0].name).toBe('Кулирка');
    expect(Number(mat[0].totalQty)).toBeCloseTo(0.5 * 5, 4);
    expect(Number(mat[1].totalQty)).toBeCloseTo(120 * 5, 4);

    expect(after.body.outsourceRequirements).toHaveLength(2);
    const outs = after.body.outsourceRequirements;
    expect(outs[0].name).toBe('Шелкография');
    expect(Number(outs[0].totalQty)).toBeCloseTo(1 * 5, 4);
    // Outsource без qtyPerUnit → totalQty = null
    expect(outs[1].totalQty).toBeNull();
    expect(outs[1].qtyPerUnit).toBeNull();
    expect(outs[1].unit).toBeNull();
  });

  test('B2. Backward-compat: заказ без techCardId стартует, snapshot пуст', async () => {
    const create = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookies.manager)
      .send({
        orderDate: '2026-04-15T00:00:00.000Z',
        productId: seed.product.id,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 1 }],
      })
      .expect(201);
    const orderId: string = create.body.id;
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start`)
      .set('Cookie', cookies.manager)
      .expect(201);
    const detail = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(detail.body.techCardId).toBeNull();
    expect(detail.body.materialRequirements).toEqual([]);
    expect(detail.body.outsourceRequirements).toEqual([]);
  });

  test('B3. TECH_CARD_INACTIVE: нельзя создать заказ на скрытой техкарте', async () => {
    const tc = await createTechCard(t, cookies.manager, {
      code: 'TC-INACTIVE',
      name: 'Скрытая',
      materialLines: [{ name: 'A', unit: 'м', qtyPerUnit: '1' }],
    });
    await request(t.app.getHttpServer())
      .patch(`/api/tech-cards/${tc.id}`)
      .set('Cookie', cookies.manager)
      .send({ isActive: false })
      .expect(200);

    const r = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookies.manager)
      .send({
        orderDate: '2026-04-15T00:00:00.000Z',
        productId: seed.product.id,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 1 }],
        techCardId: tc.id,
      });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('TECH_CARD_INACTIVE');
  });

  test('C. Snapshot independence: правка техкарты после start() не меняет старый snapshot', async () => {
    const tc = await createTechCard(t, cookies.manager, {
      code: 'TC-INDEP',
      name: 'Снапшот сам по себе',
      materialLines: [{ name: 'Старое имя', unit: 'м', qtyPerUnit: '2' }],
      outsourceLines: [{ name: 'OldOut', unit: 'шт', qtyPerUnit: '1' }],
    });
    const orderId = await createOrderWithTechCard(
      t,
      seed,
      cookies.manager,
      [{ sizeId: seed.sizes.M, qtyPlan: 4 }],
      tc.id,
    );
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start`)
      .set('Cookie', cookies.manager)
      .expect(201);

    const beforeEdit = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(beforeEdit.body.materialRequirements[0].name).toBe('Старое имя');
    expect(Number(beforeEdit.body.materialRequirements[0].totalQty)).toBeCloseTo(
      2 * 4,
      4,
    );

    // Полностью заменяем все строки, плюс деактивируем.
    await request(t.app.getHttpServer())
      .patch(`/api/tech-cards/${tc.id}`)
      .set('Cookie', cookies.manager)
      .send({
        isActive: false,
        materialLines: [{ name: 'Новое имя', unit: 'кг', qtyPerUnit: '0.99' }],
        outsourceLines: [],
      })
      .expect(200);

    const afterEdit = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    // Снапшот заказа — независимый, имена и totalQty НЕ меняются.
    expect(afterEdit.body.materialRequirements).toHaveLength(1);
    expect(afterEdit.body.materialRequirements[0].name).toBe('Старое имя');
    expect(Number(afterEdit.body.materialRequirements[0].totalQty)).toBeCloseTo(
      2 * 4,
      4,
    );
    expect(afterEdit.body.outsourceRequirements).toHaveLength(1);
    expect(afterEdit.body.outsourceRequirements[0].name).toBe('OldOut');
  });
});

// ===========================================================================
// helpers
// ===========================================================================

async function createTechCard(
  t: TestApp,
  cookie: string,
  body: {
    code: string;
    name: string;
    isActive?: boolean;
    materialLines?: Array<{
      name: string;
      unit: string;
      qtyPerUnit: string;
      note?: string | null;
    }>;
    outsourceLines?: Array<{
      name: string;
      unit?: string | null;
      qtyPerUnit?: string | null;
      vendorName?: string | null;
      note?: string | null;
    }>;
  },
): Promise<{ id: string }> {
  const r = await request(t.app.getHttpServer())
    .post('/api/tech-cards')
    .set('Cookie', cookie)
    .send(body)
    .expect(201);
  return { id: r.body.id };
}

async function createOrderWithTechCard(
  t: TestApp,
  seed: SeedResult,
  cookie: string,
  items: Array<{ sizeId: string; qtyPlan: number }>,
  techCardId: string,
): Promise<string> {
  const r = await request(t.app.getHttpServer())
    .post('/api/orders')
    .set('Cookie', cookie)
    .send({
      orderDate: '2026-04-15T00:00:00.000Z',
      productId: seed.product.id,
      items,
      techCardId,
    })
    .expect(201);
  return r.body.id;
}
