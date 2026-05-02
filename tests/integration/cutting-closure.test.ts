/**
 * Integration-тест ADR-0018 — «Закрытие раскроя по размеру через
 * заявку».
 *
 * Покрываем end-to-end сценарий и узкие места:
 *
 *   1. CUTTER_ASSISTANT может подать заявку на закрытие раскроя по
 *      существующей строке `(orderId, productId, sizeId)`.
 *   2. Партиал-уникальный индекс не позволяет двум одновременным
 *      `REQUESTED`-заявкам по одной строке.
 *   3. SHOP_MANAGER может approve / reject. Терминальную заявку
 *      повторно решать нельзя.
 *   4. После APPROVED `POST /api/passports` режется бизнес-ошибкой
 *      `CUTTING_CLOSED` (источник истины — backend, ADR-0018).
 *   5. После REJECTED помощник снова может подать новую заявку.
 *   6. RBAC: SEAMSTRESS / QC / PACKING / CUTTER не могут ни approve,
 *      ни reject; SEAMSTRESS не может подать заявку.
 *   7. Подресурс паспорта `GET /passports/:id/cutting-closure-request`
 *      возвращает «текущую» заявку (приоритет APPROVED → REQUESTED →
 *      последняя REJECTED).
 *   8. План/факт/остаток в DTO заявки совпадают с агрегатом по
 *      живым паспортам той же строки.
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

describeWithDb('integration — cutting closure requests (ADR-0018)', () => {
  let t: TestApp;
  let seed: SeedResult;
  let cookies: Record<string, string>;
  let assistantId: string;

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
    const adminPin = await bcrypt.hash('cc-admin', 4);
    const admin = await t.prisma.employee.upsert({
      where: { login: 'cc-admin' },
      create: {
        login: 'cc-admin',
        fullName: 'Closure Admin',
        role: 'ADMIN',
        active: true,
        pinHash: adminPin,
      },
      update: { active: true, role: 'ADMIN', fullName: 'Closure Admin' },
    });

    // CUTTER_ASSISTANT — главная роль сценария.
    const assistantPin = await bcrypt.hash('cc-assistant', 4);
    const assistant = await t.prisma.employee.upsert({
      where: { login: 'cc-assistant' },
      create: {
        login: 'cc-assistant',
        fullName: 'Closure Cutter Assistant',
        role: 'CUTTER_ASSISTANT',
        active: true,
        pinHash: assistantPin,
      },
      update: {
        active: true,
        role: 'CUTTER_ASSISTANT',
        fullName: 'Closure Cutter Assistant',
      },
    });
    assistantId = assistant.id;

    cookies = {
      manager: loginAs(t, seed.employees['shop-chief']),
      cutter: loginAs(t, seed.employees['cutter']),
      seamstress: loginAs(t, seed.employees['seamstress']),
      qc: loginAs(t, seed.employees['qc']),
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

  // ---------------------------------------------------------------------------
  // 1. Создание заявки + 2. partial unique index
  // ---------------------------------------------------------------------------

  test('CUTTER_ASSISTANT подаёт заявку, второй REQUESTED по той же строке — 409', async () => {
    const orderId = await createOrder(t, seed, cookies.manager, [
      { sizeId: seed.sizes.M, qtyPlan: 10 },
    ]);
    await startOrder(t, orderId, cookies.manager);
    // Накроили часть плана — типичный кейс «факт < план».
    await createPassport(
      t,
      cookies.manager,
      orderId,
      seed.sizes.M,
      7,
      seed.employees.cutter.id,
    );

    const created = await request(t.app.getHttpServer())
      .post('/api/cutting-close-requests')
      .set('Cookie', cookies.assistant)
      .send({
        orderId,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        reason: 'Ткани больше нет',
      });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('REQUESTED');
    expect(created.body.requestedByEmployeeId).toBe(assistantId);
    expect(created.body.planFact).toEqual({
      qtyPlan: 10,
      qtyCut: 7,
      qtyRemaining: 3,
    });

    // Параллельная попытка → ловим CUTTING_CLOSURE_ALREADY_REQUESTED.
    const dup = await request(t.app.getHttpServer())
      .post('/api/cutting-close-requests')
      .set('Cookie', cookies.assistant)
      .send({
        orderId,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
      });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('CUTTING_CLOSURE_ALREADY_REQUESTED');
  });

  test('Заявка на несуществующую размерную строку — 400', async () => {
    const orderId = await createOrder(t, seed, cookies.manager, [
      { sizeId: seed.sizes.M, qtyPlan: 5 },
    ]);
    await startOrder(t, orderId, cookies.manager);

    const res = await request(t.app.getHttpServer())
      .post('/api/cutting-close-requests')
      .set('Cookie', cookies.assistant)
      .send({
        orderId,
        productId: seed.product.id,
        sizeId: seed.sizes.S, // в заказе нет
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CUTTING_CLOSURE_SIZE_NOT_IN_ORDER');
  });

  // ---------------------------------------------------------------------------
  // 3. Approve / Reject + 4. backend enforcement при выпуске паспорта
  // ---------------------------------------------------------------------------

  test('SHOP_MANAGER approve → новые паспорта по размеру 409 CUTTING_CLOSED', async () => {
    const orderId = await createOrder(t, seed, cookies.manager, [
      { sizeId: seed.sizes.M, qtyPlan: 10 },
    ]);
    await startOrder(t, orderId, cookies.manager);
    await createPassport(
      t,
      cookies.manager,
      orderId,
      seed.sizes.M,
      6,
      seed.employees.cutter.id,
    );

    const created = await postRequest(t, cookies.assistant, orderId, seed.sizes.M);
    const reqId = created.body.id as string;

    const approved = await request(t.app.getHttpServer())
      .post(`/api/cutting-close-requests/${reqId}/approve`)
      .set('Cookie', cookies.manager)
      .send({ note: 'Подтверждаю, ткани больше не будет' });
    expect(approved.status).toBe(201);
    expect(approved.body.status).toBe('APPROVED');
    expect(approved.body.reviewerNote).toBe('Подтверждаю, ткани больше не будет');
    expect(approved.body.reviewedByEmployeeId).toBe(seed.employees['shop-chief'].id);

    // Backend cuts: новый паспорт по этой строке запрещён.
    const blocked = await request(t.app.getHttpServer())
      .post('/api/passports')
      .set('Cookie', cookies.manager)
      .send({
        orderId,
        sizeId: seed.sizes.M,
        rollNumber: 'R-AFTER',
        cutDate: '2026-04-15T00:00:00.000Z',
        qtyCut: 1,
        cutterId: seed.employees.cutter.id,
      });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('CUTTING_CLOSED');

    // Повторно подать заявку нельзя.
    const second = await postRequest(
      t,
      cookies.assistant,
      orderId,
      seed.sizes.M,
      201,
      false,
    );
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('CUTTING_CLOSURE_ALREADY_APPROVED');

    // Approve того же id повторно — 409.
    const reapprove = await request(t.app.getHttpServer())
      .post(`/api/cutting-close-requests/${reqId}/approve`)
      .set('Cookie', cookies.manager)
      .send({});
    expect(reapprove.status).toBe(409);
    expect(reapprove.body.code).toBe('CUTTING_CLOSURE_REQUEST_NOT_PENDING');
  });

  test('SHOP_MANAGER reject → CUTTER_ASSISTANT может подать новую заявку', async () => {
    const orderId = await createOrder(t, seed, cookies.manager, [
      { sizeId: seed.sizes.M, qtyPlan: 4 },
    ]);
    await startOrder(t, orderId, cookies.manager);
    await createPassport(
      t,
      cookies.manager,
      orderId,
      seed.sizes.M,
      2,
      seed.employees.cutter.id,
    );

    const first = await postRequest(t, cookies.assistant, orderId, seed.sizes.M);
    const rejected = await request(t.app.getHttpServer())
      .post(`/api/cutting-close-requests/${first.body.id}/reject`)
      .set('Cookie', cookies.manager)
      .send({ note: 'Ещё накройте 1 шт.' });
    expect(rejected.status).toBe(201);
    expect(rejected.body.status).toBe('REJECTED');

    // Новый паспорт всё ещё можно выпускать (REJECTED не блокирует).
    await createPassport(
      t,
      cookies.manager,
      orderId,
      seed.sizes.M,
      1,
      seed.employees.cutter.id,
    );

    // Помощник может подать заявку повторно.
    const again = await postRequest(t, cookies.assistant, orderId, seed.sizes.M);
    expect(again.status).toBe(201);
    expect(again.body.status).toBe('REQUESTED');
    expect(again.body.planFact).toEqual({
      qtyPlan: 4,
      qtyCut: 3, // 2 + 1
      qtyRemaining: 1,
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Заявка по заказу не в производстве — 409
  // ---------------------------------------------------------------------------

  test('Order DRAFT → заявка на закрытие 409', async () => {
    const orderId = await createOrder(t, seed, cookies.manager, [
      { sizeId: seed.sizes.M, qtyPlan: 3 },
    ]);

    const res = await request(t.app.getHttpServer())
      .post('/api/cutting-close-requests')
      .set('Cookie', cookies.assistant)
      .send({
        orderId,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
      });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CUTTING_CLOSURE_ORDER_NOT_IN_PRODUCTION');
  });

  // ---------------------------------------------------------------------------
  // 6. RBAC
  // ---------------------------------------------------------------------------

  test('RBAC: чужие роли не могут подать/approve/reject', async () => {
    const orderId = await createOrder(t, seed, cookies.manager, [
      { sizeId: seed.sizes.M, qtyPlan: 5 },
    ]);
    await startOrder(t, orderId, cookies.manager);

    // Подать заявку: SEAMSTRESS / QC / PACKING / CUTTER — 403.
    for (const who of ['seamstress', 'qc', 'packer', 'cutter'] as const) {
      const res = await request(t.app.getHttpServer())
        .post('/api/cutting-close-requests')
        .set('Cookie', cookies[who])
        .send({
          orderId,
          productId: seed.product.id,
          sizeId: seed.sizes.M,
        });
      expect(res.status, `submit role=${who}`).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN_ROLE');
    }

    // Подать может SHOP_MANAGER (в т.ч. от имени помощника), чтобы потом
    // сам же и подтвердить — это разрешённый сценарий.
    const created = await postRequest(t, cookies.manager, orderId, seed.sizes.M);
    const reqId = created.body.id as string;

    // Approve / reject: всем кроме SHOP_MANAGER / ADMIN — 403.
    for (const who of [
      'seamstress',
      'qc',
      'packer',
      'cutter',
      'assistant',
    ] as const) {
      for (const action of ['approve', 'reject'] as const) {
        const res = await request(t.app.getHttpServer())
          .post(`/api/cutting-close-requests/${reqId}/${action}`)
          .set('Cookie', cookies[who])
          .send({});
        expect(res.status, `${action} role=${who}`).toBe(403);
        expect(res.body.code).toBe('FORBIDDEN_ROLE');
      }
    }

    // ADMIN всегда проходит.
    const adminApprove = await request(t.app.getHttpServer())
      .post(`/api/cutting-close-requests/${reqId}/approve`)
      .set('Cookie', cookies.admin)
      .send({});
    expect(adminApprove.status).toBe(201);
    expect(adminApprove.body.status).toBe('APPROVED');
  });

  // ---------------------------------------------------------------------------
  // 7. List + 8. Подресурс паспорта
  // ---------------------------------------------------------------------------

  test('GET список и подресурс /passports/:id/cutting-closure-request', async () => {
    const orderId = await createOrder(t, seed, cookies.manager, [
      { sizeId: seed.sizes.M, qtyPlan: 8 },
      { sizeId: seed.sizes.L, qtyPlan: 4 },
    ]);
    await startOrder(t, orderId, cookies.manager);
    const passportM = await createPassport(
      t,
      cookies.manager,
      orderId,
      seed.sizes.M,
      5,
      seed.employees.cutter.id,
    );
    const passportL = await createPassport(
      t,
      cookies.manager,
      orderId,
      seed.sizes.L,
      4,
      seed.employees.cutter.id,
    );

    // По L подаём + reject + повторно reject (через новую заявку),
    // чтобы проверить fallback на «последний REJECTED».
    const lReq1 = await postRequest(t, cookies.assistant, orderId, seed.sizes.L);
    await request(t.app.getHttpServer())
      .post(`/api/cutting-close-requests/${lReq1.body.id}/reject`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);
    const lReq2 = await postRequest(t, cookies.assistant, orderId, seed.sizes.L);
    await request(t.app.getHttpServer())
      .post(`/api/cutting-close-requests/${lReq2.body.id}/reject`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);

    // По M — текущая REQUESTED.
    await postRequest(t, cookies.assistant, orderId, seed.sizes.M);

    // List — менеджер видит обе строки.
    const list = await request(t.app.getHttpServer())
      .get('/api/cutting-close-requests')
      .set('Cookie', cookies.manager);
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body)).toBe(true);
    expect(list.body.length).toBe(3);

    // Фильтр по статусу.
    const requestedOnly = await request(t.app.getHttpServer())
      .get('/api/cutting-close-requests')
      .query({ status: 'REQUESTED' })
      .set('Cookie', cookies.manager);
    expect(requestedOnly.status).toBe(200);
    expect(requestedOnly.body.length).toBe(1);
    expect(requestedOnly.body[0].sizeId).toBe(seed.sizes.M);

    // Подресурс паспорта M → REQUESTED.
    const subM = await request(t.app.getHttpServer())
      .get(`/api/passports/${passportM}/cutting-closure-request`)
      .set('Cookie', cookies.assistant);
    expect(subM.status).toBe(200);
    expect(subM.body?.status).toBe('REQUESTED');
    expect(subM.body?.planFact).toEqual({
      qtyPlan: 8,
      qtyCut: 5,
      qtyRemaining: 3,
    });

    // Подресурс паспорта L → fallback на последнюю REJECTED (lReq2).
    const subL = await request(t.app.getHttpServer())
      .get(`/api/passports/${passportL}/cutting-closure-request`)
      .set('Cookie', cookies.assistant);
    expect(subL.status).toBe(200);
    expect(subL.body?.status).toBe('REJECTED');
    expect(subL.body?.id).toBe(lReq2.body.id);
  });

  // ---------------------------------------------------------------------------
  // 9. Combined flow: помощник раскройщика выпускает паспорт и сразу подаёт
  //    заявку на закрытие из той же формы (см. `apps/web/.../actions.ts`).
  //
  //    Web-action делает два API-вызова подряд (`POST /api/passports`, затем
  //    `POST /api/cutting-close-requests`). Здесь воспроизводим его
  //    оркестрацию на уровне HTTP, чтобы убедиться, что:
  //      - happy path работает в этой последовательности;
  //      - mixed-result (паспорт ОК, заявка падает) не откатывает паспорт
  //        — он остаётся в БД и видим обоим ролям.
  // ---------------------------------------------------------------------------

  test('combined: CUTTER_ASSISTANT создаёт паспорт и сразу заявку (happy path)', async () => {
    const orderId = await createOrder(t, seed, cookies.manager, [
      { sizeId: seed.sizes.M, qtyPlan: 4 },
    ]);
    await startOrder(t, orderId, cookies.manager);

    // Помощник создаёт паспорт.
    const passportRes = await request(t.app.getHttpServer())
      .post('/api/passports')
      .set('Cookie', cookies.assistant)
      .send({
        orderId,
        sizeId: seed.sizes.M,
        rollNumber: 'R-COMBINED-1',
        cutDate: '2026-04-15T00:00:00.000Z',
        qtyCut: 4,
        cutterId: seed.employees.cutter.id,
      });
    expect(passportRes.status).toBe(201);
    const passportId = passportRes.body.id as string;

    // Сразу подаёт заявку на закрытие по той же строке.
    const closureRes = await request(t.app.getHttpServer())
      .post('/api/cutting-close-requests')
      .set('Cookie', cookies.assistant)
      .send({
        orderId,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        reason: 'План добили целиком',
      });
    expect(closureRes.status).toBe(201);
    expect(closureRes.body.status).toBe('REQUESTED');

    // Подресурс паспорта подтверждает связь по строке.
    const sub = await request(t.app.getHttpServer())
      .get(`/api/passports/${passportId}/cutting-closure-request`)
      .set('Cookie', cookies.assistant);
    expect(sub.status).toBe(200);
    expect(sub.body?.status).toBe('REQUESTED');
    expect(sub.body?.planFact).toEqual({
      qtyPlan: 4,
      qtyCut: 4,
      qtyRemaining: 0,
    });
  });

  test('combined: паспорт остаётся, если заявка падает (mixed result)', async () => {
    const orderId = await createOrder(t, seed, cookies.manager, [
      { sizeId: seed.sizes.M, qtyPlan: 8 },
    ]);
    await startOrder(t, orderId, cookies.manager);

    // 1) По строке уже есть APPROVED-заявка от прошлой попытки.
    await createPassport(
      t,
      cookies.manager,
      orderId,
      seed.sizes.M,
      5,
      seed.employees.cutter.id,
    );
    const first = await postRequest(t, cookies.assistant, orderId, seed.sizes.M);
    await request(t.app.getHttpServer())
      .post(`/api/cutting-close-requests/${first.body.id}/approve`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);

    // 2) Помощник пытается выпустить ещё один паспорт по этой строке —
    //    backend режет CUTTING_CLOSED ещё до закрытия. Проверяем, что
    //    UI-action в этом сценарии получает обычную ошибку create
    //    passport и до closure-вызова не доходит (см. ТЗ, сценарий A).
    const blocked = await request(t.app.getHttpServer())
      .post('/api/passports')
      .set('Cookie', cookies.assistant)
      .send({
        orderId,
        sizeId: seed.sizes.M,
        rollNumber: 'R-COMBINED-2',
        cutDate: '2026-04-15T00:00:00.000Z',
        qtyCut: 1,
        cutterId: seed.employees.cutter.id,
      });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('CUTTING_CLOSED');

    // 3) Симулируем «mixed result» по другому размеру: паспорт создаётся
    //    ОК, но заявка падает CUTTING_CLOSURE_SIZE_NOT_IN_ORDER (помощник
    //    случайно подменил sizeId). Паспорт по правильному размеру
    //    должен остаться.
    const orderId2 = await createOrder(t, seed, cookies.manager, [
      { sizeId: seed.sizes.L, qtyPlan: 3 },
    ]);
    await startOrder(t, orderId2, cookies.manager);

    const passportRes = await request(t.app.getHttpServer())
      .post('/api/passports')
      .set('Cookie', cookies.assistant)
      .send({
        orderId: orderId2,
        sizeId: seed.sizes.L,
        rollNumber: 'R-COMBINED-3',
        cutDate: '2026-04-15T00:00:00.000Z',
        qtyCut: 3,
        cutterId: seed.employees.cutter.id,
      });
    expect(passportRes.status).toBe(201);
    const goodPassportId = passportRes.body.id as string;

    const badClosure = await request(t.app.getHttpServer())
      .post('/api/cutting-close-requests')
      .set('Cookie', cookies.assistant)
      .send({
        orderId: orderId2,
        productId: seed.product.id,
        sizeId: seed.sizes.M, // нет в этом заказе
      });
    expect(badClosure.status).toBe(400);
    expect(badClosure.body.code).toBe('CUTTING_CLOSURE_SIZE_NOT_IN_ORDER');

    // Паспорт всё ещё доступен — UI скажет «создан, но заявку не удалось».
    const stillThere = await request(t.app.getHttpServer())
      .get(`/api/passports/${goodPassportId}`)
      .set('Cookie', cookies.assistant);
    expect(stillThere.status).toBe(200);
    expect(stillThere.body.status).not.toBe('CANCELLED');

    // По правильной строке заявок нет — помощник может зайти на карточку
    // паспорта и подать вручную.
    const sub = await request(t.app.getHttpServer())
      .get(`/api/passports/${goodPassportId}/cutting-closure-request`)
      .set('Cookie', cookies.assistant);
    expect(sub.status).toBe(200);
    expect(
      sub.body == null || sub.body === '' || Object.keys(sub.body).length === 0,
    ).toBe(true);
  });

  test('Подресурс возвращает null, если заявок по строке нет', async () => {
    const orderId = await createOrder(t, seed, cookies.manager, [
      { sizeId: seed.sizes.M, qtyPlan: 2 },
    ]);
    await startOrder(t, orderId, cookies.manager);
    const passportId = await createPassport(
      t,
      cookies.manager,
      orderId,
      seed.sizes.M,
      2,
      seed.employees.cutter.id,
    );
    const res = await request(t.app.getHttpServer())
      .get(`/api/passports/${passportId}/cutting-closure-request`)
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    // null или пустое тело — оба валидны (Nest сериализует null как 'null'/пусто).
    expect(res.body == null || res.body === '' || Object.keys(res.body).length === 0).toBe(true);
  });
});

// ===========================================================================
// helpers
// ===========================================================================

async function createOrder(
  t: TestApp,
  seed: SeedResult,
  cookie: string,
  items: Array<{ sizeId: string; qtyPlan: number }>,
): Promise<string> {
  const r = await request(t.app.getHttpServer())
    .post('/api/orders')
    .set('Cookie', cookie)
    .send({
      orderDate: '2026-04-15T00:00:00.000Z',
      productId: seed.product.id,
      items,
    })
    .expect(201);
  return r.body.id;
}

async function startOrder(
  t: TestApp,
  orderId: string,
  cookie: string,
): Promise<void> {
  await request(t.app.getHttpServer())
    .post(`/api/orders/${orderId}/start`)
    .set('Cookie', cookie)
    .expect(201);
}

async function createPassport(
  t: TestApp,
  cookie: string,
  orderId: string,
  sizeId: string,
  qtyCut: number,
  cutterId?: string,
): Promise<string> {
  const r = await request(t.app.getHttpServer())
    .post('/api/passports')
    .set('Cookie', cookie)
    .send({
      orderId,
      sizeId,
      rollNumber: `R-${Math.floor(Math.random() * 1e6)}`,
      cutDate: '2026-04-15T00:00:00.000Z',
      qtyCut,
      // PHASE 2 STEP 3: cutterId обязателен для не-CUTTER ролей
      // (CUTTER_ASSISTANT / SHOP_MANAGER). Помощник/менеджер выпускает
      // паспорт за раскройщика — указываем явно, чтобы immediate-
      // начисление пошло именно ему. Tests, которым плевать на конкретную
      // атрибуцию, передают `seed.employees.cutter.id`.
      ...(cutterId ? { cutterId } : {}),
    })
    .expect(201);
  return r.body.id;
}

async function postRequest(
  t: TestApp,
  cookie: string,
  orderId: string,
  sizeId: string,
  expected = 201,
  assertStatus = true,
): Promise<request.Response> {
  const r = await request(t.app.getHttpServer())
    .post('/api/cutting-close-requests')
    .set('Cookie', cookie)
    .send({
      orderId,
      productId: (await productIdFor(t, orderId, sizeId)),
      sizeId,
    });
  if (assertStatus) expect(r.status).toBe(expected);
  return r;
}

async function productIdFor(
  t: TestApp,
  orderId: string,
  sizeId: string,
): Promise<string> {
  const item = await t.prisma.orderItem.findFirst({
    where: { orderId, sizeId },
    select: { productId: true },
  });
  if (!item) throw new Error(`OrderItem not found for ${orderId}/${sizeId}`);
  return item.productId;
}
