/**
 * Integration-тесты Stage 3 «Мастер цеха» — политика выдачи кроя
 * (`CutReleasePolicy`).
 *
 * Контракт (см. `docs/domain.md §«Мастер цеха»`,
 * `apps/api/src/modules/cut-release-policy/*`,
 * `apps/api/src/modules/passports/passports.service.ts::issueToEmployee`):
 *
 *   A. activeПолитика блокирует выдачу при несовпадении цвета;
 *   B. activeПолитика блокирует выдачу при несовпадении размера;
 *   C. activeПолитика блокирует выдачу при превышении лимита;
 *   D. activeПолитика пропускает корректный паспорт и инкрементит
 *      `consumedQty` в той же транзакции;
 *   E. снятие политики (`POST /:id/disable`) убирает ограничение —
 *      следующий issue уходит без 409;
 *   F. RBAC: `SHOPFLOOR_MASTER` / `SHOP_MANAGER` / `ADMIN` могут
 *      управлять политикой; `SEAMSTRESS` получает `403 FORBIDDEN_ROLE`;
 *   G. Single-active инвариант MVP: новый POST деактивирует все
 *      предыдущие активные политики (через `updateMany`);
 *   H. Audit `CUT_RELEASE_POLICY_*` пишется на каждое целевое событие;
 *   I. Stage 3 НЕ блокирует scan / complete-operation — только issue.
 *      Это сознательная граница ТЗ §11 «НЕ ДЕЛАТЬ».
 *
 * Заказ строим с маршрутом `SEW_OVERLOCK_1 → SEW_OVERLOCK_2 → QC`
 * (без CUT_DIVISION — нам нужно, чтобы швея с активной сменой на
 * `overlock-01/SEW_OVERLOCK_1` смогла встать на ПЕРВОЙ операции
 * маршрута и попасть под политику Stage 3 на честный issue).
 * Цвет паспорта берём из `Order.color = 'Чёрный'` (см.
 * `passports.service.ts::create` — `color = order.color ?? product.color`),
 * чтобы тестировать exact-match по цвету.
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

describeWithDb('integration — cut release policy (Stage 3)', () => {
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
      qc: loginAs(t, seed.employees['qc']),
    };
  });

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  /**
   * Создаёт RouteTemplate с шагами `SEW_OVERLOCK_1 → SEW_OVERLOCK_2 → QC`,
   * заводит заказ под этот шаблон с заданным `color` и `qtyPlan` по `M`,
   * стартует заказ. Возвращает `orderId`.
   */
  async function setupOrderWithRoute(opts?: {
    color?: string;
    qtyPlan?: number;
    sizeKey?: 'S' | 'M' | 'L';
  }): Promise<{ orderId: string; sizeId: string }> {
    const sizeKey = opts?.sizeKey ?? 'M';
    const sizeId = seed.sizes[sizeKey]!;
    const tplCode = `CRP-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
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

    const order = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookies.manager)
      .send({
        orderDate: '2026-04-15T00:00:00.000Z',
        productId: seed.product.id,
        color: opts?.color ?? 'Чёрный',
        items: [{ sizeId, qtyPlan: opts?.qtyPlan ?? 10 }],
        routeTemplateId: tpl.body.id,
      })
      .expect(201);

    await request(t.app.getHttpServer())
      .post(`/api/orders/${order.body.id}/start`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);

    return { orderId: order.body.id, sizeId };
  }

  /**
   * Создаёт паспорт + кладёт его в ячейку `A1`. Возвращает passportId.
   */
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
        // PHASE 2 STEP 3: cutterId обязателен у не-CUTTER ролей.
        cutterId: seed.employees.cutter.id,
      })
      .expect(201);
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passport.body.id}/place`)
      .set('Cookie', cookies.manager)
      .send({ cellId: seed.cells.A1.id })
      .expect(201);
    return passport.body.id;
  }

  /**
   * Открывает смену швеи на overlock-01 / SEW_OVERLOCK_1. Идемпотентен
   * не нужен — `beforeEach` каждый раз заново заводит БД.
   */
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

  /**
   * Создаёт активную политику от лица мастера. Возвращает policy.id.
   * Бросаем 201, чтобы помощник сам страховал нас от регрессии RBAC.
   */
  async function createPolicy(input: {
    color?: string | null;
    sizeId?: string | null;
    limitQty: number;
  }): Promise<{ id: string }> {
    const res = await request(t.app.getHttpServer())
      .post('/api/cut-release-policy')
      .set('Cookie', cookies.master)
      .send(input)
      .expect(201);
    return { id: res.body.id };
  }

  // ---------------------------------------------------------------------------
  // A. wrong color → 409
  // ---------------------------------------------------------------------------

  test('A. policy blocks issue: цвет паспорта не совпадает с фильтром', async () => {
    const { orderId, sizeId } = await setupOrderWithRoute({
      color: 'Чёрный',
      qtyPlan: 5,
    });
    const passportId = await createAndPlace(orderId, sizeId, 5);
    await startSeamstressShift();
    await createPolicy({ color: 'Белый', sizeId: null, limitQty: 100 });

    const res = await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(409);
    expect(res.body?.code).toBe('CUT_RELEASE_POLICY_VIOLATION');
    expect(res.body?.message).toBe(
      'Сейчас разрешена выдача только: Белый, лимит 100 шт.',
    );

    // Паспорт остался в ячейке, не у швеи, политика consumedQty не
    // сдвинулась. (`currentEmployeeId` после `place` хранит creator-а
    // паспорта — это не важно: важно, что paspport всё ещё лежит в
    // ячейке и не перешёл к швее.)
    const inDb = await t.prisma.passport.findUnique({
      where: { id: passportId },
    });
    expect(inDb?.currentCellId).toBe(seed.cells.A1.id);
    expect(inDb?.currentEmployeeId).not.toBe(seed.employees.seamstress.id);
    expect(inDb?.status).toBe('CREATED');
    const policyAfter = await t.prisma.cutReleasePolicy.findFirst({
      where: { isActive: true },
    });
    expect(policyAfter?.consumedQty).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // B. wrong size → 409
  // ---------------------------------------------------------------------------

  test('B. policy blocks issue: размер паспорта не совпадает с фильтром', async () => {
    const { orderId, sizeId } = await setupOrderWithRoute({
      color: 'Чёрный',
      sizeKey: 'M',
      qtyPlan: 5,
    });
    const passportId = await createAndPlace(orderId, sizeId, 5);
    await startSeamstressShift();
    // Политика — только размер L; паспорт на M → reject.
    await createPolicy({
      color: null,
      sizeId: seed.sizes.L,
      limitQty: 50,
    });

    const res = await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(409);
    expect(res.body?.code).toBe('CUT_RELEASE_POLICY_VIOLATION');
    expect(res.body?.message).toBe(
      'Сейчас разрешена выдача только: L, лимит 50 шт.',
    );
  });

  // ---------------------------------------------------------------------------
  // C. limit exceeded → 409 (и сообщение содержит лимит)
  // ---------------------------------------------------------------------------

  test('C. policy blocks issue: consumedQty + qtyCut > limitQty', async () => {
    const { orderId, sizeId } = await setupOrderWithRoute({
      color: 'Чёрный',
      qtyPlan: 20,
    });
    // Лимит 5, а паспорт на 7 штук — превышаем сразу.
    const passportId = await createAndPlace(orderId, sizeId, 7);
    await startSeamstressShift();
    await createPolicy({ color: 'Чёрный', sizeId, limitQty: 5 });

    const res = await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(409);
    expect(res.body?.code).toBe('CUT_RELEASE_POLICY_VIOLATION');
    expect(res.body?.message).toBe(
      'Сейчас разрешена выдача только: Чёрный M, лимит 5 шт.',
    );
  });

  // ---------------------------------------------------------------------------
  // D. correct passport allowed + consumedQty инкрементится
  // ---------------------------------------------------------------------------

  test('D. policy allows correct passport и инкрементит consumedQty', async () => {
    const { orderId, sizeId } = await setupOrderWithRoute({
      color: 'Чёрный',
      qtyPlan: 20,
    });
    const passportA = await createAndPlace(orderId, sizeId, 3, 'R-D-A');
    const passportB = await createAndPlace(orderId, sizeId, 4, 'R-D-B');
    await startSeamstressShift();
    const { id: policyId } = await createPolicy({
      color: 'Чёрный',
      sizeId,
      limitQty: 10,
    });

    // Первый issue — 3 шт, идёт без 409.
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportA}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);

    let policy = await t.prisma.cutReleasePolicy.findUniqueOrThrow({
      where: { id: policyId },
    });
    expect(policy.consumedQty).toBe(3);

    // Второй issue — 4 шт, в сумме 7 ≤ 10 → проходит.
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportB}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);

    policy = await t.prisma.cutReleasePolicy.findUniqueOrThrow({
      where: { id: policyId },
    });
    expect(policy.consumedQty).toBe(7);

    // Audit: на каждый issue одна запись CUT_RELEASE_POLICY_CONSUMED.
    const consumedAudits = await t.prisma.auditLog.findMany({
      where: {
        entityType: 'CUT_RELEASE_POLICY',
        entityId: policyId,
        event: 'CUT_RELEASE_POLICY_CONSUMED',
      },
      orderBy: { createdAt: 'asc' },
    });
    expect(consumedAudits).toHaveLength(2);
    const firstPayload = consumedAudits[0]!.payload as {
      passportId: string;
      qty: number;
      beforeConsumed: number;
      afterConsumed: number;
    };
    expect(firstPayload).toMatchObject({
      passportId: passportA,
      qty: 3,
      beforeConsumed: 0,
      afterConsumed: 3,
    });
    const secondPayload = consumedAudits[1]!.payload as {
      passportId: string;
      qty: number;
      beforeConsumed: number;
      afterConsumed: number;
    };
    expect(secondPayload).toMatchObject({
      passportId: passportB,
      qty: 4,
      beforeConsumed: 3,
      afterConsumed: 7,
    });
  });

  test('D2. третий issue, который перевалит лимит, отклоняется (consumedQty не растёт)', async () => {
    const { orderId, sizeId } = await setupOrderWithRoute({
      color: 'Чёрный',
      qtyPlan: 20,
    });
    const passportA = await createAndPlace(orderId, sizeId, 5, 'R-D2-A');
    const passportB = await createAndPlace(orderId, sizeId, 4, 'R-D2-B');
    await startSeamstressShift();
    const { id: policyId } = await createPolicy({
      color: 'Чёрный',
      sizeId,
      limitQty: 6,
    });

    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportA}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);
    // Сейчас consumed=5, лимит=6, новый паспорт на 4 → 5+4=9 > 6.
    const res = await request(t.app.getHttpServer())
      .post(`/api/passports/${passportB}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(409);
    expect(res.body?.code).toBe('CUT_RELEASE_POLICY_VIOLATION');

    const policy = await t.prisma.cutReleasePolicy.findUniqueOrThrow({
      where: { id: policyId },
    });
    expect(policy.consumedQty).toBe(5);
  });

  // ---------------------------------------------------------------------------
  // E. disable policy убирает ограничение
  // ---------------------------------------------------------------------------

  test('E. disable policy: следующий issue идёт без 409', async () => {
    const { orderId, sizeId } = await setupOrderWithRoute({
      color: 'Чёрный',
      qtyPlan: 20,
    });
    const passportId = await createAndPlace(orderId, sizeId, 5);
    await startSeamstressShift();
    const { id: policyId } = await createPolicy({
      color: 'Белый',
      sizeId: null,
      limitQty: 50,
    });

    // Под политикой issue падает.
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(409);

    // Снимаем политику и проверяем audit DISABLED.
    await request(t.app.getHttpServer())
      .post(`/api/cut-release-policy/${policyId}/disable`)
      .set('Cookie', cookies.master)
      .send({})
      .expect(201);
    const disabledAudit = await t.prisma.auditLog.findFirst({
      where: {
        entityType: 'CUT_RELEASE_POLICY',
        entityId: policyId,
        event: 'CUT_RELEASE_POLICY_DISABLED',
      },
    });
    expect(disabledAudit).not.toBeNull();

    // Теперь issue проходит — ограничения нет, consumedQty не пишется.
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);
    const policy = await t.prisma.cutReleasePolicy.findUniqueOrThrow({
      where: { id: policyId },
    });
    expect(policy.isActive).toBe(false);
    expect(policy.consumedQty).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // F. RBAC: SHOPFLOOR_MASTER ok, SEAMSTRESS forbidden
  // ---------------------------------------------------------------------------

  test('F. RBAC: SHOPFLOOR_MASTER создаёт политику, SEAMSTRESS получает 403', async () => {
    // SHOPFLOOR_MASTER — happy path (был покрыт неявно в createPolicy выше,
    // но фиксируем явно: GET тоже доступен мастеру и возвращает policy).
    const created = await request(t.app.getHttpServer())
      .post('/api/cut-release-policy')
      .set('Cookie', cookies.master)
      .send({ color: 'Чёрный', limitQty: 10 })
      .expect(201);
    expect(created.body.isActive).toBe(true);

    const get = await request(t.app.getHttpServer())
      .get('/api/cut-release-policy')
      .set('Cookie', cookies.master)
      .expect(200);
    expect(get.body.policy?.id).toBe(created.body.id);

    // SEAMSTRESS — все четыре endpoints отклоняются `FORBIDDEN_ROLE`.
    const post = await request(t.app.getHttpServer())
      .post('/api/cut-release-policy')
      .set('Cookie', cookies.seamstress)
      .send({ color: 'Чёрный', limitQty: 10 })
      .expect(403);
    expect(post.body?.code).toBe('FORBIDDEN_ROLE');

    const getForbidden = await request(t.app.getHttpServer())
      .get('/api/cut-release-policy')
      .set('Cookie', cookies.seamstress)
      .expect(403);
    expect(getForbidden.body?.code).toBe('FORBIDDEN_ROLE');

    const disable = await request(t.app.getHttpServer())
      .post(`/api/cut-release-policy/${created.body.id}/disable`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(403);
    expect(disable.body?.code).toBe('FORBIDDEN_ROLE');
  });

  // ---------------------------------------------------------------------------
  // G. single-active инвариант: новый POST деактивирует предыдущую
  // ---------------------------------------------------------------------------

  test('G. POST новой политики деактивирует предыдущую активную', async () => {
    const first = await createPolicy({ color: 'Чёрный', limitQty: 10 });
    const second = await createPolicy({ color: 'Белый', limitQty: 20 });
    expect(first.id).not.toBe(second.id);

    const firstRow = await t.prisma.cutReleasePolicy.findUniqueOrThrow({
      where: { id: first.id },
    });
    const secondRow = await t.prisma.cutReleasePolicy.findUniqueOrThrow({
      where: { id: second.id },
    });
    expect(firstRow.isActive).toBe(false);
    expect(secondRow.isActive).toBe(true);

    // GET возвращает только новую (active=true).
    const get = await request(t.app.getHttpServer())
      .get('/api/cut-release-policy')
      .set('Cookie', cookies.master)
      .expect(200);
    expect(get.body.policy?.id).toBe(second.id);

    // Audit: ровно одна CREATED-запись на каждую политику.
    const createdAudits = await t.prisma.auditLog.findMany({
      where: {
        entityType: 'CUT_RELEASE_POLICY',
        event: 'CUT_RELEASE_POLICY_CREATED',
      },
    });
    expect(createdAudits).toHaveLength(2);
  });

  // ---------------------------------------------------------------------------
  // I. Stage 3 НЕ блокирует scan / complete-operation
  // ---------------------------------------------------------------------------

  test('I. scan / complete-operation НЕ блокируются политикой (граница ТЗ §11)', async () => {
    // Сценарий: паспорт уже у швеи (issue прошёл ДО политики), сразу
    // после этого мастер выкатывает «несовместимую» политику. Дальнейшие
    // движения паспорта по маршруту (scan на следующей операции +
    // complete-operation) обязаны проходить — политика касается ТОЛЬКО
    // выдачи кроя из ячейки.
    const { orderId, sizeId } = await setupOrderWithRoute({
      color: 'Чёрный',
      qtyPlan: 10,
    });
    const passportId = await createAndPlace(orderId, sizeId, 5);
    await startSeamstressShift();
    // Issue без политики — берём паспорт с ячейки.
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);
    // Сразу после выдачи мастер ставит политику, явно несовместимую с
    // паспортом (другой цвет). На scan / complete это влиять не должно.
    await createPolicy({ color: 'Белый', sizeId: null, limitQty: 1 });

    // scan на той же операции (idempotent) — 201.
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/scan`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);

    // complete-operation на текущей операции — 201, движение по маршруту.
    const complete = await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/complete-operation`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);
    expect(complete.body.id).toBe(passportId);

    // Никакого CUT_RELEASE_POLICY_CONSUMED по политике после issue —
    // только сам issue инкрементит лимит, scan/complete нет.
    const consumed = await t.prisma.auditLog.findMany({
      where: {
        entityType: 'CUT_RELEASE_POLICY',
        event: 'CUT_RELEASE_POLICY_CONSUMED',
      },
    });
    expect(consumed).toHaveLength(0);
  });
});
