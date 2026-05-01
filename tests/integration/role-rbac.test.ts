/**
 * Integration-тест RBAC для разделов /qc, /packing, /orders.
 *
 * Источник истины — backend (`@Roles(...)` на контроллерах). Этот сьют
 * проверяет, что:
 *
 *   1. /api/qc/*           → QC, SHOP_MANAGER, ADMIN.
 *   2. /api/defect-types   → QC, SHOP_MANAGER, ADMIN.
 *   3. /api/packing/boxes  → PACKING, SHOP_MANAGER, ADMIN
 *      (включая GET-list — раньше он был открыт всем авторизованным).
 *   4. /api/orders         → SHOP_MANAGER, ADMIN на запись, плюс
 *      CUTTER_ASSISTANT на чтение (GET list/detail и подресурс
 *      `/orders/:id/passports`) — это нужно помощнику раскройщика,
 *      чтобы найти заказ для выпуска паспорта.
 *
 * Дополнительно фиксируем, что:
 *   - SHOP_MANAGER действительно проходит туда, куда мы его пускаем;
 *   - публичные `/qr` и `/label` упаковки остаются доступны без
 *     сессии (нужны принтер-станции, ADR-0010).
 *
 * Полный production flow (создание заказа → паспорт → пошив → ОТК →
 * упаковка) уже покрыт `production-flow.test.ts`. Здесь мы строим
 * минимальное состояние и бьём непосредственно по контроллерам.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import {
  loginAs,
  startTestApp,
  stopTestApp,
  type TestApp,
} from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

describeWithDb('integration — role-based RBAC for /qc, /packing, /orders', () => {
  let t: TestApp;
  let seed: SeedResult;
  let cookies: Record<string, string>;
  let cutterAssistantId: string;

  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await stopTestApp(t);
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    seed = await seedMinimal(t.prisma);

    // Системного admin поднимаем заново — `resetDatabase` сносит и его.
    const adminPin = await bcrypt.hash('rbac-admin', 4);
    const admin = await t.prisma.employee.upsert({
      where: { login: 'rbac-admin' },
      create: {
        login: 'rbac-admin',
        fullName: 'RBAC Admin',
        role: 'ADMIN',
        paymentType: 'SALARY',
        active: true,
        pinHash: adminPin,
      },
      update: { active: true, role: 'ADMIN', fullName: 'RBAC Admin' },
    });

    // CUTTER_ASSISTANT в `seedMinimal` нет — добавляем точечно: он
    // нужен только этому сьюту, для проверки read-доступа к /orders.
    const assistantPin = await bcrypt.hash('rbac-assistant', 4);
    const assistant = await t.prisma.employee.upsert({
      where: { login: 'rbac-assistant' },
      create: {
        login: 'rbac-assistant',
        fullName: 'RBAC Cutter Assistant',
        role: 'CUTTER_ASSISTANT',
        paymentType: 'SALARY',
        active: true,
        pinHash: assistantPin,
      },
      update: {
        active: true,
        role: 'CUTTER_ASSISTANT',
        fullName: 'RBAC Cutter Assistant',
      },
    });
    cutterAssistantId = assistant.id;

    cookies = {
      manager: loginAs(t, seed.employees['shop-chief']),
      cutter: loginAs(t, seed.employees['cutter']),
      seamstress: loginAs(t, seed.employees['seamstress']),
      qc: loginAs(t, seed.employees['qc']),
      ironing: loginAs(t, seed.employees['ironing']),
      packer: loginAs(t, seed.employees['packer']),
      assistant: loginAs(t, {
        id: assistant.id,
        login: assistant.login,
        role: assistant.role,
        fullName: assistant.fullName,
      }),
      admin: loginAs(t, {
        id: admin.id,
        login: admin.login,
        role: admin.role,
        fullName: admin.fullName,
      }),
    };
  });

  // -------------------------------------------------------------------------
  // 1. /api/qc/*
  // -------------------------------------------------------------------------

  test('QC list: QC и SHOP_MANAGER и ADMIN — 200', async () => {
    for (const who of ['qc', 'manager', 'admin'] as const) {
      const res = await request(t.app.getHttpServer())
        .get('/api/qc/passports')
        .set('Cookie', cookies[who]);
      expect(res.status, `role=${who}`).toBe(200);
    }
  });

  test('QC list: SEAMSTRESS — 403 FORBIDDEN_ROLE', async () => {
    const res = await request(t.app.getHttpServer())
      .get('/api/qc/passports')
      .set('Cookie', cookies.seamstress);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN_ROLE');
  });

  test('QC list: CUTTER, PACKING, IRONING, CUTTER_ASSISTANT — 403', async () => {
    for (const who of ['cutter', 'packer', 'ironing', 'assistant'] as const) {
      const res = await request(t.app.getHttpServer())
        .get('/api/qc/passports')
        .set('Cookie', cookies[who]);
      expect(res.status, `role=${who}`).toBe(403);
    }
  });

  test('QC defect-types: только QC/SM/ADMIN', async () => {
    for (const who of ['qc', 'manager', 'admin'] as const) {
      const ok = await request(t.app.getHttpServer())
        .get('/api/defect-types')
        .set('Cookie', cookies[who]);
      expect(ok.status, `role=${who}`).toBe(200);
    }
    for (const who of ['seamstress', 'cutter', 'packer', 'assistant'] as const) {
      const forbidden = await request(t.app.getHttpServer())
        .get('/api/defect-types')
        .set('Cookie', cookies[who]);
      expect(forbidden.status, `role=${who}`).toBe(403);
    }
  });

  test('QC defect record (POST): SEAMSTRESS — 403, до сервиса не доходит', async () => {
    // Реального паспорта здесь не нужно — guard срабатывает раньше
    // бизнес-логики, и контроллер вернёт 403 ещё до Prisma.
    const res = await request(t.app.getHttpServer())
      .post('/api/qc/passports/00000000-0000-0000-0000-000000000000/defects')
      .set('Cookie', cookies.seamstress)
      .send({ defectTypeId: seed.defectType.id, qty: 1 });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN_ROLE');
  });

  test('QC complete (POST /qc/passports/:id/complete): RBAC = тот же, что у /qc', async () => {
    // Сюда же ложится новый scan-driven endpoint «Проверка выполнена».
    // С несуществующим id ожидаем 404 (а не 403/401) у разрешённых ролей,
    // и 403 у остальных — guard срабатывает до сервиса.
    for (const who of ['qc', 'manager', 'admin'] as const) {
      const res = await request(t.app.getHttpServer())
        .post('/api/qc/passports/00000000-0000-0000-0000-000000000000/complete')
        .set('Cookie', cookies[who])
        .send({});
      expect(res.status, `role=${who}`).toBe(404);
    }
    for (const who of ['seamstress', 'cutter', 'packer', 'assistant'] as const) {
      const res = await request(t.app.getHttpServer())
        .post('/api/qc/passports/00000000-0000-0000-0000-000000000000/complete')
        .set('Cookie', cookies[who])
        .send({});
      expect(res.status, `role=${who}`).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN_ROLE');
    }
  });

  // -------------------------------------------------------------------------
  // 1b. /api/wto/* (role-terminal ВТО — полный аналог /api/qc/*)
  // -------------------------------------------------------------------------

  test('WTO get: IRONING и SHOP_MANAGER и ADMIN — 404 (а не 403) на несуществующем id', async () => {
    // Страховка от регрессии guard'а: разрешённые роли проходят дальше
    // RBAC и упираются в `PASSPORT_NOT_FOUND` (404). 403 здесь = регрессия.
    for (const who of ['ironing', 'manager', 'admin'] as const) {
      const res = await request(t.app.getHttpServer())
        .get('/api/wto/passports/00000000-0000-0000-0000-000000000000')
        .set('Cookie', cookies[who]);
      expect(res.status, `role=${who}`).toBe(404);
    }
  });

  test('WTO get: SEAMSTRESS / QC / CUTTER / PACKING / CUTTER_ASSISTANT — 403', async () => {
    for (const who of [
      'seamstress',
      'qc',
      'cutter',
      'packer',
      'assistant',
    ] as const) {
      const res = await request(t.app.getHttpServer())
        .get('/api/wto/passports/00000000-0000-0000-0000-000000000000')
        .set('Cookie', cookies[who]);
      expect(res.status, `role=${who}`).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN_ROLE');
    }
  });

  test('WTO complete (POST /wto/passports/:id/complete): RBAC = тот же, что у /wto', async () => {
    for (const who of ['ironing', 'manager', 'admin'] as const) {
      const res = await request(t.app.getHttpServer())
        .post('/api/wto/passports/00000000-0000-0000-0000-000000000000/complete')
        .set('Cookie', cookies[who])
        .send({});
      expect(res.status, `role=${who}`).toBe(404);
    }
    for (const who of [
      'seamstress',
      'qc',
      'cutter',
      'packer',
      'assistant',
    ] as const) {
      const res = await request(t.app.getHttpServer())
        .post('/api/wto/passports/00000000-0000-0000-0000-000000000000/complete')
        .set('Cookie', cookies[who])
        .send({});
      expect(res.status, `role=${who}`).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN_ROLE');
    }
  });

  // -------------------------------------------------------------------------
  // 2. /api/packing/boxes
  // -------------------------------------------------------------------------

  test('Packing list: PACKING и SHOP_MANAGER и ADMIN — 200', async () => {
    for (const who of ['packer', 'manager', 'admin'] as const) {
      const res = await request(t.app.getHttpServer())
        .get('/api/packing/boxes')
        .set('Cookie', cookies[who]);
      expect(res.status, `role=${who}`).toBe(200);
    }
  });

  test('Packing list: SEAMSTRESS, QC, CUTTER, CUTTER_ASSISTANT — 403', async () => {
    for (const who of ['seamstress', 'qc', 'cutter', 'assistant'] as const) {
      const res = await request(t.app.getHttpServer())
        .get('/api/packing/boxes')
        .set('Cookie', cookies[who]);
      expect(res.status, `role=${who}`).toBe(403);
    }
  });

  test('Packing create: SEAMSTRESS — 403', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/packing/boxes')
      .set('Cookie', cookies.seamstress)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN_ROLE');
  });

  test('Packing label / qr остаются публичными (печать с принтер-станции)', async () => {
    // 404 — потому что коробки нет; важно, что НЕ 401/403.
    const label = await request(t.app.getHttpServer()).get(
      '/api/packing/boxes/missing/label',
    );
    expect([200, 404]).toContain(label.status);
    expect(label.status).not.toBe(401);
    expect(label.status).not.toBe(403);

    const qr = await request(t.app.getHttpServer()).get(
      '/api/packing/boxes/missing/qr',
    );
    expect([200, 404]).toContain(qr.status);
    expect(qr.status).not.toBe(401);
    expect(qr.status).not.toBe(403);
  });

  // -------------------------------------------------------------------------
  // 3. /api/orders
  // -------------------------------------------------------------------------

  test('Orders list: SHOP_MANAGER и ADMIN — 200', async () => {
    for (const who of ['manager', 'admin'] as const) {
      const res = await request(t.app.getHttpServer())
        .get('/api/orders')
        .set('Cookie', cookies[who]);
      expect(res.status, `role=${who}`).toBe(200);
    }
  });

  test('Orders list: CUTTER_ASSISTANT — 200 (read-режим для выпуска паспорта)', async () => {
    const res = await request(t.app.getHttpServer())
      .get('/api/orders')
      .set('Cookie', cookies.assistant);
    expect(res.status).toBe(200);
  });

  test('Orders list: SEAMSTRESS / QC / CUTTER / PACKING — 403', async () => {
    for (const who of ['seamstress', 'qc', 'cutter', 'packer'] as const) {
      const res = await request(t.app.getHttpServer())
        .get('/api/orders')
        .set('Cookie', cookies[who]);
      expect(res.status, `role=${who}`).toBe(403);
    }
  });

  test('Orders create: только SHOP_MANAGER (и ADMIN). CUTTER_ASSISTANT и SEAMSTRESS — 403', async () => {
    const ok = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookies.manager)
      .send({
        orderDate: '2026-04-15T00:00:00.000Z',
        productId: seed.product.id,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 1 }],
      });
    expect(ok.status).toBe(201);

    for (const who of ['assistant', 'seamstress', 'qc', 'cutter'] as const) {
      const forbidden = await request(t.app.getHttpServer())
        .post('/api/orders')
        .set('Cookie', cookies[who])
        .send({
          orderDate: '2026-04-15T00:00:00.000Z',
          productId: seed.product.id,
          items: [{ sizeId: seed.sizes.M, qtyPlan: 1 }],
        });
      expect(forbidden.status, `role=${who}`).toBe(403);
    }
  });

  test('Orders detail и /orders/:id/passports: CUTTER_ASSISTANT — 200', async () => {
    const created = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookies.manager)
      .send({
        orderDate: '2026-04-15T00:00:00.000Z',
        productId: seed.product.id,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 1 }],
      })
      .expect(201);
    const orderId: string = created.body.id;

    const detail = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}`)
      .set('Cookie', cookies.assistant);
    expect(detail.status).toBe(200);

    const passports = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}/passports`)
      .set('Cookie', cookies.assistant);
    expect(passports.status).toBe(200);
    expect(Array.isArray(passports.body)).toBe(true);
  });

  test('Orders detail / passports: SEAMSTRESS — 403', async () => {
    const created = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookies.manager)
      .send({
        orderDate: '2026-04-15T00:00:00.000Z',
        productId: seed.product.id,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 1 }],
      })
      .expect(201);
    const orderId: string = created.body.id;

    const detail = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}`)
      .set('Cookie', cookies.seamstress);
    expect(detail.status).toBe(403);

    const passports = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}/passports`)
      .set('Cookie', cookies.seamstress);
    expect(passports.status).toBe(403);
  });

  // -------------------------------------------------------------------------
  // 4. Принципиальная страховка: ADMIN ходит везде.
  // -------------------------------------------------------------------------

  test('ADMIN всегда проходит во все три раздела', async () => {
    expect(cutterAssistantId).toBeDefined();
    const qc = await request(t.app.getHttpServer())
      .get('/api/qc/passports')
      .set('Cookie', cookies.admin);
    const packing = await request(t.app.getHttpServer())
      .get('/api/packing/boxes')
      .set('Cookie', cookies.admin);
    const orders = await request(t.app.getHttpServer())
      .get('/api/orders')
      .set('Cookie', cookies.admin);
    expect(qc.status).toBe(200);
    expect(packing.status).toBe(200);
    expect(orders.status).toBe(200);
  });
});
