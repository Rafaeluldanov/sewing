/**
 * Integration-тесты этапа «Нанесение на заказе покупателя».
 *
 * Покрытие — минимально достаточный contract-floor:
 *
 *   1. PUT /api/orders/:id/applications в DRAFT — создаёт нанесения,
 *      повторный PUT делает full-replace (delete + createMany);
 *   2. GET /api/orders/:id/applications — отдаёт список с лейблами;
 *   3. GET /api/orders/:id — карточка содержит applications[];
 *   4. CutReadiness, case 1: CUT_PARTS с НЕЗАПОЛНЕННЫМИ данными →
 *      `ready=false`, в `blockers` — «Нанесение на крое не заполнено»;
 *   5. CutReadiness, case 2: CUT_PARTS с заполненными данными →
 *      `ready` зависит от других блокеров; в `warnings` или
 *      `sections.applications` есть строка «Нанесение на крое»
 *      (не блокер);
 *   6. CutReadiness, case 3: FINISHED_ITEM → нет блокера от
 *      нанесения, есть INFO-строка про готовое изделие;
 *   7. WorkshopNeed: после `start-calculation` создаётся строка
 *      с `sourceType = ORDER_APPLICATION` и
 *      `materialRole = APPLICATION`;
 *   8. После CALCULATION PUT /applications отбивается 409
 *      `ORDER_APPLICATION_ORDER_LOCKED`;
 *   9. RBAC: рабочая роль (QC) → 403 на PUT.
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

describeWithDb('integration — order applications', () => {
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
      qc: loginAs(t, seed.employees['qc']),
    };
  });

  // ---------------------------------------------------------------------------
  // 1. PUT/GET happy-path
  // ---------------------------------------------------------------------------

  test('PUT/GET /applications в DRAFT — full replace', async () => {
    const orderId = await createDraftOrder(t, seed, cookies.manager);

    // Первый PUT: одно нанесение.
    const putA = await request(t.app.getHttpServer())
      .put(`/api/orders/${orderId}/applications`)
      .set('Cookie', cookies.manager)
      .send({
        applications: [
          {
            type: 'SCREEN_PRINT',
            stage: 'CUT_PARTS',
            placement: 'грудь',
            widthMm: 200,
            heightMm: 150,
            colorsCount: 2,
            quantity: '10',
            unit: 'шт',
            colorText: 'белый',
            description: 'Логотип SEWING',
          },
        ],
      });
    expect(putA.status).toBe(200);
    expect(Array.isArray(putA.body)).toBe(true);
    expect(putA.body.length).toBe(1);
    expect(putA.body[0].type).toBe('SCREEN_PRINT');
    expect(putA.body[0].typeLabel).toBe('Шелкография');
    expect(putA.body[0].stage).toBe('CUT_PARTS');
    expect(putA.body[0].stageLabel).toBe('На крое');

    // Второй PUT: два других нанесения — старое исчезло, новые остались.
    const putB = await request(t.app.getHttpServer())
      .put(`/api/orders/${orderId}/applications`)
      .set('Cookie', cookies.manager)
      .send({
        applications: [
          { type: 'DTF', stage: 'CUT_PARTS', placement: 'спина' },
          { type: 'EMBROIDERY', stage: 'FINISHED_ITEM' },
        ],
      });
    expect(putB.status).toBe(200);
    expect(putB.body.length).toBe(2);

    const get = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}/applications`)
      .set('Cookie', cookies.manager);
    expect(get.status).toBe(200);
    expect(get.body.length).toBe(2);
    expect(get.body.map((a: any) => a.type).sort()).toEqual([
      'DTF',
      'EMBROIDERY',
    ]);

    // В БД ровно 2 строки, со связкой на orderId.
    const inDb = await t.prisma.orderApplication.findMany({
      where: { orderId },
    });
    expect(inDb.length).toBe(2);

    // Audit ORDER_APPLICATIONS_REPLACED — есть как минимум один.
    const audit = await t.prisma.auditLog.findFirst({
      where: { event: 'ORDER_APPLICATIONS_REPLACED', entityId: orderId },
    });
    expect(audit).not.toBeNull();
  });

  // ---------------------------------------------------------------------------
  // 2. OrderDetail.applications
  // ---------------------------------------------------------------------------

  test('GET /orders/:id отдаёт applications[] в OrderDetailDto', async () => {
    const orderId = await createDraftOrder(t, seed, cookies.manager);
    await request(t.app.getHttpServer())
      .put(`/api/orders/${orderId}/applications`)
      .set('Cookie', cookies.manager)
      .send({
        applications: [
          { type: 'OTHER', stage: 'CUT_PARTS', placement: 'рукав' },
        ],
      })
      .expect(200);

    const r = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}`)
      .set('Cookie', cookies.manager);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.applications)).toBe(true);
    expect(r.body.applications.length).toBe(1);
    expect(r.body.applications[0].placement).toBe('рукав');
    expect(r.body.applications[0].typeLabel).toBe('Другое');
  });

  // ---------------------------------------------------------------------------
  // 3. Cut readiness, case 1: CUT_PARTS без данных → BLOCKER
  // ---------------------------------------------------------------------------

  test('CutReadiness: CUT_PARTS без параметров → ready=false + blocker', async () => {
    const orderId = await prepareReadyOrder(t, seed, cookies.manager);
    await request(t.app.getHttpServer())
      .put(`/api/orders/${orderId}/applications`)
      .set('Cookie', cookies.manager)
      .send({
        applications: [
          { type: 'SCREEN_PRINT', stage: 'CUT_PARTS' /* данные пустые */ },
        ],
      })
      .expect(200);

    const r = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}/cut-readiness`)
      .set('Cookie', cookies.manager);
    expect(r.status).toBe(200);
    expect(r.body.ready).toBe(false);
    const blockerTitles = r.body.blockers.map((b: any) => b.title);
    expect(blockerTitles).toContain('Нанесение на крое не заполнено');
  });

  // ---------------------------------------------------------------------------
  // 4. Cut readiness, case 2: CUT_PARTS с данными → нет блокера от
  //    нанесения, есть warning «Нанесение на крое»
  // ---------------------------------------------------------------------------

  test('CutReadiness: CUT_PARTS с данными → нет блокера от нанесения', async () => {
    const orderId = await prepareReadyOrder(t, seed, cookies.manager);
    await request(t.app.getHttpServer())
      .put(`/api/orders/${orderId}/applications`)
      .set('Cookie', cookies.manager)
      .send({
        applications: [
          {
            type: 'SCREEN_PRINT',
            stage: 'CUT_PARTS',
            placement: 'грудь',
            widthMm: 200,
            heightMm: 150,
          },
        ],
      })
      .expect(200);

    const r = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}/cut-readiness`)
      .set('Cookie', cookies.manager);
    expect(r.status).toBe(200);
    // Нет блокера именно от нанесения.
    const blockerTitles = r.body.blockers.map((b: any) => b.title);
    expect(blockerTitles).not.toContain('Нанесение на крое не заполнено');
    // Warning «Нанесение на крое» присутствует.
    const warningTitles = r.body.warnings.map((w: any) => w.title);
    expect(warningTitles).toContain('Нанесение на крое');
    // В sections.applications есть наша строка.
    const appsSection: any[] = r.body.sections?.applications ?? [];
    expect(appsSection.length).toBe(1);
    expect(appsSection[0].status).toBe('WARNING');
  });

  // ---------------------------------------------------------------------------
  // 5. Cut readiness, case 3: FINISHED_ITEM → нет блокера, есть INFO
  // ---------------------------------------------------------------------------

  test('CutReadiness: FINISHED_ITEM → крой не блокируется, info присутствует', async () => {
    const orderId = await prepareReadyOrder(t, seed, cookies.manager);
    await request(t.app.getHttpServer())
      .put(`/api/orders/${orderId}/applications`)
      .set('Cookie', cookies.manager)
      .send({
        applications: [
          { type: 'EMBROIDERY', stage: 'FINISHED_ITEM' },
        ],
      })
      .expect(200);

    const r = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}/cut-readiness`)
      .set('Cookie', cookies.manager);
    expect(r.status).toBe(200);
    const blockerTitles = r.body.blockers.map((b: any) => b.title);
    expect(blockerTitles).not.toContain('Нанесение на крое не заполнено');
    const appsSection: any[] = r.body.sections?.applications ?? [];
    expect(appsSection.length).toBe(1);
    expect(appsSection[0].status).toBe('INFO');
    expect(appsSection[0].title).toBe('Нанесение на готовом изделии');
  });

  // ---------------------------------------------------------------------------
  // 6. WorkshopNeed: после start-calculation появляется ORDER_APPLICATION
  // ---------------------------------------------------------------------------

  test('start-calculation создаёт WorkshopNeed по нанесению (sourceType=ORDER_APPLICATION)', async () => {
    const orderId = await prepareReadyOrder(t, seed, cookies.manager);
    await request(t.app.getHttpServer())
      .put(`/api/orders/${orderId}/applications`)
      .set('Cookie', cookies.manager)
      .send({
        applications: [
          {
            type: 'SCREEN_PRINT',
            stage: 'CUT_PARTS',
            placement: 'грудь',
            quantity: '7',
            colorText: 'белый',
          },
        ],
      })
      .expect(200);

    const r = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start-calculation`)
      .set('Cookie', cookies.manager)
      .send({});
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('CALCULATION');

    const needs = await t.prisma.workshopNeed.findMany({ where: { orderId } });
    // Одна потребность от техкарты + одна от OrderApplication.
    expect(needs.length).toBeGreaterThanOrEqual(2);
    const appNeed = needs.find((n) => n.sourceType === 'ORDER_APPLICATION');
    expect(appNeed).toBeDefined();
    expect(appNeed?.materialRole).toBe('APPLICATION');
    expect(Number(appNeed!.calculatedQty)).toBeCloseTo(7, 4);
    expect(appNeed!.description).toMatch(/Шелкография/);
  });

  // ---------------------------------------------------------------------------
  // 7. После CALCULATION PUT /applications → 409 ORDER_APPLICATION_ORDER_LOCKED
  // ---------------------------------------------------------------------------

  test('После CALCULATION PUT /applications → 409 ORDER_APPLICATION_ORDER_LOCKED', async () => {
    const orderId = await prepareReadyOrder(t, seed, cookies.manager);
    await request(t.app.getHttpServer())
      .put(`/api/orders/${orderId}/applications`)
      .set('Cookie', cookies.manager)
      .send({
        applications: [{ type: 'OTHER', stage: 'CUT_PARTS', placement: 'спина' }],
      })
      .expect(200);

    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start-calculation`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);

    const r = await request(t.app.getHttpServer())
      .put(`/api/orders/${orderId}/applications`)
      .set('Cookie', cookies.manager)
      .send({
        applications: [{ type: 'DTF', stage: 'CUT_PARTS', placement: 'грудь' }],
      });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('ORDER_APPLICATION_ORDER_LOCKED');
  });

  // ---------------------------------------------------------------------------
  // 7b. Atomic create — POST /api/orders с applications
  // ---------------------------------------------------------------------------

  test('POST /api/orders с applications создаёт OrderApplication[] атомарно', async () => {
    // Контракт: на форме `/admin/orders/new` редактор пишет
    // `applicationsJson` в FormData, server action парсит JSON и
    // кладёт в `dto.applications`. Backend `OrdersService.create()`
    // должен создать заказ + строки нанесений в одной транзакции.
    const r = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookies.manager)
      .send({
        orderDate: '2026-04-15T00:00:00.000Z',
        productId: seed.product.id,
        items: [{ sizeId: seed.sizes.S, qtyPlan: 4 }],
        applications: [
          {
            type: 'SCREEN_PRINT',
            stage: 'CUT_PARTS',
            placement: 'грудь',
            widthMm: 200,
            heightMm: 150,
            quantity: '4',
            colorText: 'белый',
          },
          {
            type: 'EMBROIDERY',
            stage: 'FINISHED_ITEM',
          },
        ],
      });
    expect(r.status).toBe(201);
    const orderId = r.body.id as string;

    // OrderDetailDto.applications сразу содержит обе строки
    // (`OrdersService.getOne` подгружает `applications` через include).
    expect(Array.isArray(r.body.applications)).toBe(true);
    expect(r.body.applications.length).toBe(2);

    // В БД ровно 2 строки и связаны с этим заказом.
    const inDb = await t.prisma.orderApplication.findMany({
      where: { orderId },
      orderBy: { createdAt: 'asc' },
    });
    expect(inDb.length).toBe(2);
    expect(inDb[0].type).toBe('SCREEN_PRINT');
    expect(inDb[0].stage).toBe('CUT_PARTS');
    expect(inDb[0].placement).toBe('грудь');
    expect(inDb[0].unit).toBe('шт');
    expect(inDb[0].status).toBe('PLANNED');
    expect(inDb[1].type).toBe('EMBROIDERY');
    expect(inDb[1].stage).toBe('FINISHED_ITEM');

    // Audit ORDER_CREATED содержит applicationsCount.
    const audit = await t.prisma.auditLog.findFirst({
      where: { event: 'ORDER_CREATED', entityId: orderId },
    });
    expect(audit).not.toBeNull();
    const payload = audit!.payload as Record<string, unknown>;
    expect(payload.applicationsCount).toBe(2);
  });

  test('POST /api/orders без applications работает как раньше (legacy)', async () => {
    // Legacy `/orders/new` форма не передаёт `applications`. Backend
    // должен создать заказ без нанесений и не упасть.
    const r = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookies.manager)
      .send({
        orderDate: '2026-04-15T00:00:00.000Z',
        productId: seed.product.id,
        items: [{ sizeId: seed.sizes.S, qtyPlan: 3 }],
      })
      .expect(201);
    expect(r.body.applications).toEqual([]);
    const orderId = r.body.id as string;
    const inDb = await t.prisma.orderApplication.count({
      where: { orderId },
    });
    expect(inDb).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // 8. RBAC: рабочая роль не имеет доступа
  // ---------------------------------------------------------------------------

  test('Рабочая роль (QC) → 403 на PUT /applications', async () => {
    const orderId = await createDraftOrder(t, seed, cookies.manager);
    const r = await request(t.app.getHttpServer())
      .put(`/api/orders/${orderId}/applications`)
      .set('Cookie', cookies.qc)
      .send({ applications: [] });
    expect(r.status).toBe(403);
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
    materialLines?: Array<{
      name: string;
      unit: string;
      qtyPerUnit: string;
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

async function createOrder(
  t: TestApp,
  seed: SeedResult,
  cookie: string,
  options: {
    items: Array<{ sizeId: string; qtyPlan: number }>;
    techCardId?: string | null;
    patternItemId?: string | null;
  },
): Promise<string> {
  const r = await request(t.app.getHttpServer())
    .post('/api/orders')
    .set('Cookie', cookie)
    .send({
      orderDate: '2026-04-15T00:00:00.000Z',
      productId: seed.product.id,
      items: options.items,
      techCardId: options.techCardId ?? undefined,
      patternItemId: options.patternItemId ?? undefined,
    })
    .expect(201);
  return r.body.id as string;
}

/**
 * Минимально достаточный DRAFT-заказ: размер S с qtyPlan = 5.
 * Без техкарты / лекала — для проверок CRUD applications.
 */
async function createDraftOrder(
  t: TestApp,
  seed: SeedResult,
  cookie: string,
): Promise<string> {
  return createOrder(t, seed, cookie, {
    items: [{ sizeId: seed.sizes.S, qtyPlan: 5 }],
  });
}

/**
 * Готовый к расчёту заказ: DRAFT + techCard + pattern + qtyPlan > 0.
 * Используется для start-calculation / cut-readiness тестов.
 */
async function prepareReadyOrder(
  t: TestApp,
  seed: SeedResult,
  cookie: string,
): Promise<string> {
  const tc = await createTechCard(t, cookie, {
    code: 'TC-APP-1',
    name: 'Application demo TC',
    materialLines: [{ name: 'Нитки', unit: 'м', qtyPerUnit: '1.5' }],
  });
  const pattern = await t.prisma.patternItem.create({
    data: {
      name: 'Лекало demo',
      article: 'P-APP-1',
      status: 'ACTIVE',
    },
  });
  return createOrder(t, seed, cookie, {
    items: [{ sizeId: seed.sizes.M, qtyPlan: 10 }],
    techCardId: tc.id,
    patternItemId: pattern.id,
  });
}
