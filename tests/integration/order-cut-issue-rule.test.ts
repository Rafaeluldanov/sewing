/**
 * Integration-тесты модуля «Очередь выдачи кроя по размерам»
 * (`OrderCutIssueRule`).
 *
 * Контракт (см. `docs/domain.md §«Очередь выдачи кроя»`,
 * `apps/api/src/modules/order-cut-issue-rules/*`,
 * `apps/api/src/modules/passports/passports.service.ts::issueToEmployee`,
 * `docs/production-flow.md §«Issue: очередь выдачи кроя»`):
 *
 *   T1. Без правила issue работает как раньше (нет 409, нет ничего
 *       лишнего в audit-логе).
 *   T2. Размер «не очередной» (L) запрещён, пока не выполнены
 *       очередные строки (S/M); сообщение содержит человекочитаемый
 *       список «осталось … шт» в нужном порядке.
 *   T3. Размер из очереди можно выдавать только до `requiredQty`;
 *       лишний паспорт за пределами лимита блокируется.
 *   T4. После выполнения всех активных строк выдача остальных
 *       размеров становится свободной (issue проходит без 409).
 *   T5. Параллельные issue не превышают `requiredQty` (race по
 *       conditional `updateMany`).
 *   T6. Bulk-upsert: первая форма создаёт строки, повторный bulk
 *       без какой-то строки помечает её `isActive = false`.
 *   T7. `disable-all` гасит все строки заказа и снимает блокировку.
 *   T8. `requiredQty < issuedQty` запрещён (422).
 *   T9. RBAC: `SHOP_MANAGER` пишет, `SEAMSTRESS` получает
 *       `403 FORBIDDEN_ROLE` на write-эндпоинты, GET доступен
 *       любой авторизованной роли.
 *  T10. Audit `ORDER_CUT_ISSUE_RULE_*` пишется на каждое целевое
 *       событие.
 *
 * Маршрут заказа: `SEW_OVERLOCK_1 → SEW_OVERLOCK_2 → QC` — швея
 * с активной сменой на `overlock-01/SEW_OVERLOCK_1` встаёт ровно
 * на ПЕРВУЮ операцию маршрута, чтобы попасть под правило очереди
 * (см. ТЗ §6 «применять только на первой операции маршрута /
 * CUTTING»). Зеркально с `cut-release-policy.test.ts`.
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

describeWithDb('integration — order cut issue rules', () => {
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
      master: loginAs(t, seed.employees['master']),
      seamstress: loginAs(t, seed.employees['seamstress']),
    };
  });

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  /**
   * Создаёт RouteTemplate (`SEW_OVERLOCK_1 → SEW_OVERLOCK_2 → QC`),
   * заводит заказ под этот шаблон с заданным набором строк
   * `items` (массив `{ sizeKey, qtyPlan }`), стартует заказ.
   */
  async function setupOrderWithRoute(
    items: Array<{ sizeKey: 'S' | 'M' | 'L'; qtyPlan: number }>,
  ): Promise<{ orderId: string; sizeIdByKey: Record<string, string> }> {
    const tplCode = `OCR-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    const tpl = await request(t.app.getHttpServer())
      .post('/api/routes')
      .set('Cookie', cookies.manager)
      .send({
        code: tplCode,
        name: tplCode,
        steps: [
          { operationId: seed.operations.SEW_OVERLOCK_1.id },
          { operationId: seed.operations.SEW_OVERLOCK_2.id },
          { operationId: seed.operations.QC.id },
        ],
      })
      .expect(201);

    const sizeIdByKey: Record<string, string> = {};
    const orderItems = items.map((it) => {
      const sizeId = seed.sizes[it.sizeKey]!;
      sizeIdByKey[it.sizeKey] = sizeId;
      return { sizeId, qtyPlan: it.qtyPlan };
    });

    const order = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookies.manager)
      .send({
        orderDate: '2026-04-15T00:00:00.000Z',
        productId: seed.product.id,
        color: 'Чёрный',
        items: orderItems,
        routeTemplateId: tpl.body.id,
      })
      .expect(201);

    await request(t.app.getHttpServer())
      .post(`/api/orders/${order.body.id}/start`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);

    return { orderId: order.body.id, sizeIdByKey };
  }

  async function createAndPlace(
    orderId: string,
    sizeId: string,
    qtyCut = 5,
    rollNumber = `R-${Math.random().toString(36).slice(2, 8)}`,
  ): Promise<string> {
    const passport = await request(t.app.getHttpServer())
      .post('/api/passports')
      .set('Cookie', cookies.manager)
      .send({
        orderId,
        sizeId,
        rollNumber,
        cutDate: '2026-04-15T00:00:00.000Z',
        qtyCut,
      })
      .expect(201);
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passport.body.id}/place`)
      .set('Cookie', cookies.manager)
      .send({ cellId: seed.cells.A1.id })
      .expect(201);
    return passport.body.id;
  }

  async function startSeamstressShift(): Promise<void> {
    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.seamstress)
      .send({
        equipmentId: seed.equipment['overlock-01'].id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
      })
      .expect(201);
  }

  function bulkUpsertRules(
    orderId: string,
    rows: Array<{ sizeId: string; requiredQty: number; sortOrder?: number }>,
    cookie: string = cookies.manager,
  ): request.Test {
    return request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/cut-issue-rules`)
      .set('Cookie', cookie)
      .send({ rows });
  }

  // ---------------------------------------------------------------------------
  // T1. без правила issue работает как раньше
  // ---------------------------------------------------------------------------

  test('T1. без правила issue работает как раньше', async () => {
    const { orderId, sizeIdByKey } = await setupOrderWithRoute([
      { sizeKey: 'M', qtyPlan: 5 },
    ]);
    const passportId = await createAndPlace(orderId, sizeIdByKey.M!, 5);
    await startSeamstressShift();

    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);

    // Никаких строк очереди — никакого audit от ORDER_CUT_ISSUE_RULE_*.
    const audits = await t.prisma.auditLog.findMany({
      where: { entityType: 'ORDER_CUT_ISSUE_RULE' },
    });
    expect(audits).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // T2. L запрещён, пока не выполнены S/M
  // ---------------------------------------------------------------------------

  test('T2. размер «не очередной» (L) запрещён, пока не выполнены S/M', async () => {
    const { orderId, sizeIdByKey } = await setupOrderWithRoute([
      { sizeKey: 'S', qtyPlan: 10 },
      { sizeKey: 'M', qtyPlan: 10 },
      { sizeKey: 'L', qtyPlan: 10 },
    ]);
    await bulkUpsertRules(orderId, [
      { sizeId: sizeIdByKey.S!, requiredQty: 5 },
      { sizeId: sizeIdByKey.M!, requiredQty: 4 },
    ]).expect(201);

    const passportL = await createAndPlace(orderId, sizeIdByKey.L!, 3);
    await startSeamstressShift();

    const res = await request(t.app.getHttpServer())
      .post(`/api/passports/${passportL}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(409);
    expect(res.body?.code).toBe('ORDER_CUT_ISSUE_RULE_VIOLATION');
    expect(res.body?.message).toBe(
      'Сначала нужно выдать: S — осталось 5 шт, M — осталось 4 шт',
    );
    // L остался в ячейке.
    const inDb = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passportL },
    });
    expect(inDb.currentCellId).toBe(seed.cells.A1.id);
    expect(inDb.status).toBe('CREATED');
  });

  // ---------------------------------------------------------------------------
  // T3. размер из очереди можно выдать только до requiredQty
  // ---------------------------------------------------------------------------

  test('T3. лимит по очередному размеру: лишние штуки блокируются', async () => {
    const { orderId, sizeIdByKey } = await setupOrderWithRoute([
      { sizeKey: 'S', qtyPlan: 20 },
    ]);
    await bulkUpsertRules(orderId, [
      { sizeId: sizeIdByKey.S!, requiredQty: 5 },
    ]).expect(201);

    const passportA = await createAndPlace(orderId, sizeIdByKey.S!, 3, 'R-T3-A');
    const passportB = await createAndPlace(orderId, sizeIdByKey.S!, 4, 'R-T3-B');
    await startSeamstressShift();

    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportA}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);

    // Уже выдано 3, осталось 2; 4 шт нельзя.
    const res = await request(t.app.getHttpServer())
      .post(`/api/passports/${passportB}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(409);
    expect(res.body?.code).toBe('ORDER_CUT_ISSUE_RULE_VIOLATION');
    expect(res.body?.message).toBe('Сначала нужно выдать: S — осталось 2 шт');

    const rule = await t.prisma.orderCutIssueRule.findFirstOrThrow({
      where: { orderId, sizeId: sizeIdByKey.S! },
    });
    expect(rule.issuedQty).toBe(3);
  });

  // ---------------------------------------------------------------------------
  // T4. после выполнения всех строк выдача свободна
  // ---------------------------------------------------------------------------

  test('T4. после выполнения всех активных строк L свободно', async () => {
    const { orderId, sizeIdByKey } = await setupOrderWithRoute([
      { sizeKey: 'S', qtyPlan: 10 },
      { sizeKey: 'L', qtyPlan: 10 },
    ]);
    await bulkUpsertRules(orderId, [
      { sizeId: sizeIdByKey.S!, requiredQty: 3 },
    ]).expect(201);

    const passportS = await createAndPlace(orderId, sizeIdByKey.S!, 3, 'R-T4-S');
    const passportL = await createAndPlace(orderId, sizeIdByKey.L!, 4, 'R-T4-L');
    await startSeamstressShift();

    // Выполняем строку S (3 шт = requiredQty) → правило «гаснет».
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportS}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);

    // Теперь L разрешён — issue проходит без 409.
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportL}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);

    // issuedQty по строке L не появилось — правило L не вело.
    const rules = await t.prisma.orderCutIssueRule.findMany({
      where: { orderId },
    });
    expect(rules).toHaveLength(1);
    expect(rules[0]!.sizeId).toBe(sizeIdByKey.S);
    expect(rules[0]!.issuedQty).toBe(3);

    // Summary в DONE.
    const summary = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}/cut-issue-rules`)
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(summary.body.status).toBe('DONE');
  });

  // ---------------------------------------------------------------------------
  // T5. параллельные issue не превышают requiredQty
  // ---------------------------------------------------------------------------

  test('T5. параллельные issue не превышают requiredQty', async () => {
    const { orderId, sizeIdByKey } = await setupOrderWithRoute([
      { sizeKey: 'S', qtyPlan: 20 },
    ]);
    await bulkUpsertRules(orderId, [
      { sizeId: sizeIdByKey.S!, requiredQty: 5 },
    ]).expect(201);

    const passportA = await createAndPlace(orderId, sizeIdByKey.S!, 3, 'R-T5-A');
    const passportB = await createAndPlace(orderId, sizeIdByKey.S!, 3, 'R-T5-B');
    await startSeamstressShift();

    // Параллельный issue: оба запроса уходят одновременно.
    const [resA, resB] = await Promise.all([
      request(t.app.getHttpServer())
        .post(`/api/passports/${passportA}/issue`)
        .set('Cookie', cookies.seamstress)
        .send({}),
      request(t.app.getHttpServer())
        .post(`/api/passports/${passportB}/issue`)
        .set('Cookie', cookies.seamstress)
        .send({}),
    ]);
    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([201, 409]);
    const rejected = resA.status === 409 ? resA : resB;
    expect(rejected.body?.code).toBe('ORDER_CUT_ISSUE_RULE_VIOLATION');

    const rule = await t.prisma.orderCutIssueRule.findFirstOrThrow({
      where: { orderId, sizeId: sizeIdByKey.S! },
    });
    // Прошедший issue инкрементил counter ровно на 3 (один из двух).
    expect(rule.issuedQty).toBe(3);
    expect(rule.issuedQty).toBeLessThanOrEqual(rule.requiredQty);
  });

  // ---------------------------------------------------------------------------
  // T6. bulk upsert: повторный bulk без строки → isActive = false
  // ---------------------------------------------------------------------------

  test('T6. bulk upsert: первый POST создаёт, второй без размера деактивирует строку', async () => {
    const { orderId, sizeIdByKey } = await setupOrderWithRoute([
      { sizeKey: 'S', qtyPlan: 10 },
      { sizeKey: 'M', qtyPlan: 10 },
    ]);

    await bulkUpsertRules(orderId, [
      { sizeId: sizeIdByKey.S!, requiredQty: 5 },
      { sizeId: sizeIdByKey.M!, requiredQty: 4 },
    ]).expect(201);

    let rules = await t.prisma.orderCutIssueRule.findMany({
      where: { orderId },
      orderBy: { createdAt: 'asc' },
    });
    expect(rules).toHaveLength(2);
    expect(rules.every((r) => r.isActive)).toBe(true);

    // Повторный bulk оставляет только S → M помечается isActive=false.
    const second = await bulkUpsertRules(orderId, [
      { sizeId: sizeIdByKey.S!, requiredQty: 6 },
    ]).expect(201);
    expect(second.body.status).toBe('IN_PROGRESS');
    expect(second.body.rules).toHaveLength(2);
    const mAfter = (
      second.body.rules as Array<{ sizeId: string; isActive: boolean }>
    ).find((r) => r.sizeId === sizeIdByKey.M)!;
    expect(mAfter.isActive).toBe(false);

    rules = await t.prisma.orderCutIssueRule.findMany({
      where: { orderId },
    });
    const sRule = rules.find((r) => r.sizeId === sizeIdByKey.S)!;
    const mRule = rules.find((r) => r.sizeId === sizeIdByKey.M)!;
    expect(sRule.requiredQty).toBe(6);
    expect(sRule.isActive).toBe(true);
    expect(mRule.isActive).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // T7. disable-all гасит все строки заказа и снимает блокировку
  // ---------------------------------------------------------------------------

  test('T7. disable-all: сначала L блокируется, после disable — issue проходит', async () => {
    const { orderId, sizeIdByKey } = await setupOrderWithRoute([
      { sizeKey: 'S', qtyPlan: 10 },
      { sizeKey: 'L', qtyPlan: 10 },
    ]);
    await bulkUpsertRules(orderId, [
      { sizeId: sizeIdByKey.S!, requiredQty: 5 },
    ]).expect(201);

    const passportL = await createAndPlace(orderId, sizeIdByKey.L!, 3);
    await startSeamstressShift();

    // Под правилом L блокируется.
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportL}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(409);

    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/cut-issue-rules/disable-all`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);

    const audits = await t.prisma.auditLog.findMany({
      where: {
        entityType: 'ORDER_CUT_ISSUE_RULE',
        entityId: orderId,
        event: 'ORDER_CUT_ISSUE_RULE_DISABLED',
      },
    });
    expect(audits).toHaveLength(1);

    // Теперь L проходит.
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportL}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);
  });

  // ---------------------------------------------------------------------------
  // T8. requiredQty < issuedQty → 422
  // ---------------------------------------------------------------------------

  test('T8. нельзя уменьшить requiredQty ниже issuedQty (422)', async () => {
    const { orderId, sizeIdByKey } = await setupOrderWithRoute([
      { sizeKey: 'S', qtyPlan: 10 },
    ]);
    await bulkUpsertRules(orderId, [
      { sizeId: sizeIdByKey.S!, requiredQty: 5 },
    ]).expect(201);

    const passportS = await createAndPlace(orderId, sizeIdByKey.S!, 3);
    await startSeamstressShift();
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportS}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);

    // Сейчас issuedQty=3; пытаемся requiredQty=2 → 422.
    const res = await bulkUpsertRules(orderId, [
      { sizeId: sizeIdByKey.S!, requiredQty: 2 },
    ]).expect(422);
    expect(res.body?.code).toBe('ORDER_CUT_ISSUE_RULE_REQUIRED_BELOW_ISSUED');

    // А requiredQty > qtyPlan → 422 другой код.
    const res2 = await bulkUpsertRules(orderId, [
      { sizeId: sizeIdByKey.S!, requiredQty: 99 },
    ]).expect(422);
    expect(res2.body?.code).toBe('ORDER_CUT_ISSUE_RULE_REQUIRED_ABOVE_PLAN');
  });

  // ---------------------------------------------------------------------------
  // T9. RBAC
  // ---------------------------------------------------------------------------

  test('T9. RBAC: SHOP_MANAGER пишет, SEAMSTRESS получает 403, GET доступен любой роли', async () => {
    const { orderId, sizeIdByKey } = await setupOrderWithRoute([
      { sizeKey: 'S', qtyPlan: 10 },
    ]);

    // SHOP_MANAGER — happy path.
    await bulkUpsertRules(orderId, [
      { sizeId: sizeIdByKey.S!, requiredQty: 5 },
    ]).expect(201);

    // SEAMSTRESS write → 403.
    const post = await bulkUpsertRules(
      orderId,
      [{ sizeId: sizeIdByKey.S!, requiredQty: 1 }],
      cookies.seamstress,
    ).expect(403);
    expect(post.body?.code).toBe('FORBIDDEN_ROLE');

    const disable = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/cut-issue-rules/disable-all`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(403);
    expect(disable.body?.code).toBe('FORBIDDEN_ROLE');

    // GET доступен seamstress (any auth).
    const get = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}/cut-issue-rules`)
      .set('Cookie', cookies.seamstress)
      .expect(200);
    expect(get.body?.orderId).toBe(orderId);
    expect(Array.isArray(get.body?.rules)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // T10. Audit
  // ---------------------------------------------------------------------------

  test('T10. audit: UPSERT + CONSUMED + DISABLED пишутся в правильных entityId', async () => {
    const { orderId, sizeIdByKey } = await setupOrderWithRoute([
      { sizeKey: 'S', qtyPlan: 10 },
    ]);
    await bulkUpsertRules(orderId, [
      { sizeId: sizeIdByKey.S!, requiredQty: 5 },
    ]).expect(201);

    const passportId = await createAndPlace(orderId, sizeIdByKey.S!, 3);
    await startSeamstressShift();
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);

    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/cut-issue-rules/disable-all`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);

    const upsertAudits = await t.prisma.auditLog.findMany({
      where: {
        entityType: 'ORDER_CUT_ISSUE_RULE',
        entityId: orderId,
        event: 'ORDER_CUT_ISSUE_RULE_UPSERT',
      },
    });
    expect(upsertAudits).toHaveLength(1);

    const rule = await t.prisma.orderCutIssueRule.findFirstOrThrow({
      where: { orderId, sizeId: sizeIdByKey.S! },
    });
    const consumedAudits = await t.prisma.auditLog.findMany({
      where: {
        entityType: 'ORDER_CUT_ISSUE_RULE',
        entityId: rule.id,
        event: 'ORDER_CUT_ISSUE_RULE_CONSUMED',
      },
    });
    expect(consumedAudits).toHaveLength(1);
    expect(consumedAudits[0]!.payload).toMatchObject({
      orderId,
      passportId,
      sizeCode: 'S',
      qty: 3,
      beforeIssued: 0,
      afterIssued: 3,
    });

    const disabledAudits = await t.prisma.auditLog.findMany({
      where: {
        entityType: 'ORDER_CUT_ISSUE_RULE',
        entityId: orderId,
        event: 'ORDER_CUT_ISSUE_RULE_DISABLED',
      },
    });
    expect(disabledAudits).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // T11. Inline-message helper и формат сообщения совпадают
  // ---------------------------------------------------------------------------

  test('T11. raw error code: ORDER_CUT_ISSUE_RULE_VIOLATION у фронта помечен как «без префикса»', async () => {
    // Это лёгкий smoke-тест константы фронта — гарантия, что новое
    // сообщение бэка не получит UI-префикс `[CODE] ` (см.
    // `apps/web/app/work/actions.ts::RAW_API_ERROR_CODES`).
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const filePath = path.resolve(
      here,
      '../../apps/web/app/work/actions.ts',
    );
    const source = await fs.readFile(filePath, 'utf-8');
    expect(source).toMatch(/ORDER_CUT_ISSUE_RULE_VIOLATION/);
    expect(source).toMatch(/RAW_API_ERROR_CODES/);
  });
});
