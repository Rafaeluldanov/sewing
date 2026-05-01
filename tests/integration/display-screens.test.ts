/**
 * Integration-тесты модуля «Display screens»
 * (`POST /api/display-screens`, `GET /api/display-screens`,
 * + auto-division в `/api/shopfloor/display`).
 *
 * Источник истины контракта — `docs/api.md §11`,
 * UI-зеркало — `docs/screens.md §10e`,
 * доменная связка — `prisma/schema.prisma → DisplayScreenConfig`.
 *
 * Сценарии:
 *   1. Happy-path: SHOP_MANAGER создаёт экран → одной транзакцией
 *      появляется `Employee(role=DISPLAY)` + `DisplayScreenConfig` с
 *      нужным division/isActive; под этим логином сразу можно войти.
 *   2. Уникальность login → `409 DISPLAY_LOGIN_TAKEN` и НИ ОДНА из
 *      двух сущностей не создаётся (rollback транзакции).
 *   3. RBAC: рабочие роли (SEAMSTRESS / DISPLAY) → 403; админский
 *      листинг им не открывается.
 *   4. Auto-division: DISPLAY-пользователь без `?division=` получает
 *      агрегат своего подразделения, query-param перекрывает его,
 *      `isActive=false` отключает auto-detection.
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

describeWithDb('integration — display screens', () => {
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
      seamstress: loginAs(t, seed.employees['seamstress']),
    };
  });

  // ---------------------------------------------------------------------------
  // 1. Happy-path
  // ---------------------------------------------------------------------------

  test('SHOP_MANAGER создаёт display-экран → Employee(DISPLAY) + DisplayScreenConfig в одной транзакции', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/display-screens')
      .set('Cookie', cookies.manager)
      .send({
        name: 'ТВ маркетплейс у выхода',
        division: 'MARKETPLACE',
        login: 'display-mp',
        pin: 'pin-1234',
        isActive: true,
      });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: 'ТВ маркетплейс у выхода',
      division: 'MARKETPLACE',
      isActive: true,
      employeeLogin: 'display-mp',
    });
    expect(typeof res.body.id).toBe('string');
    expect(typeof res.body.employeeId).toBe('string');
    // PIN наружу не отдаём ни в одном виде.
    expect(res.body.pin).toBeUndefined();
    expect(res.body.pinHash).toBeUndefined();

    // Employee создан с правильной ролью и хешем.
    const emp = await t.prisma.employee.findUnique({
      where: { login: 'display-mp' },
    });
    expect(emp).not.toBeNull();
    expect(emp!.role).toBe('DISPLAY');
    expect(emp!.fullName).toBe('Display: ТВ маркетплейс у выхода');
    expect(emp!.active).toBe(true);
    expect(emp!.pinHash.startsWith('$2')).toBe(true);
    expect(await bcrypt.compare('pin-1234', emp!.pinHash)).toBe(true);

    // Конфиг ссылается на этого employee (employeeId UNIQUE).
    const config = await t.prisma.displayScreenConfig.findUnique({
      where: { employeeId: emp!.id },
    });
    expect(config).not.toBeNull();
    expect(config!.division).toBe('MARKETPLACE');
    expect(config!.isActive).toBe(true);
    expect(config!.name).toBe('ТВ маркетплейс у выхода');

    // Под логином экрана можно сразу залогиниться (тот же AuthService).
    const login = await request(t.app.getHttpServer())
      .post('/api/auth/login')
      .send({ login: 'display-mp', password: 'pin-1234' });
    expect(login.status).toBe(200);
    expect(login.body).toMatchObject({
      user: { login: 'display-mp', role: 'DISPLAY' },
    });
  });

  test('GET /api/display-screens отдаёт свежесозданный экран SHOP_MANAGER-у', async () => {
    await request(t.app.getHttpServer())
      .post('/api/display-screens')
      .set('Cookie', cookies.manager)
      .send({
        name: 'Дисплей у раскройщиков',
        division: 'OTHER',
        login: 'display-cut',
        pin: 'pin-2222',
        isActive: true,
      });

    const list = await request(t.app.getHttpServer())
      .get('/api/display-screens')
      .set('Cookie', cookies.manager);
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body)).toBe(true);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({
      name: 'Дисплей у раскройщиков',
      division: 'OTHER',
      isActive: true,
      employeeLogin: 'display-cut',
    });
    // PHASE 1: список содержит привязку к карточке `CompanyDivision`.
    expect(list.body[0].companyDivisionId).toBe(
      seed.companyDivisions.OTHER.id,
    );
    expect(list.body[0].companyDivision).toMatchObject({
      id: seed.companyDivisions.OTHER.id,
      code: 'OTHER',
      name: 'B2B',
    });
  });

  // ---------------------------------------------------------------------------
  // PHASE 1 «CompanyDivision как master-справочник»
  // ---------------------------------------------------------------------------

  test('PHASE 1: создание экрана через companyDivisionId синхронизирует legacy division', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/display-screens')
      .set('Cookie', cookies.manager)
      .send({
        name: 'PHASE1 экран',
        companyDivisionId: seed.companyDivisions.MARKETPLACE.id,
        login: 'display-phase1',
        pin: 'pin-1234',
        isActive: true,
      });
    expect(res.status).toBe(201);
    expect(res.body.companyDivisionId).toBe(
      seed.companyDivisions.MARKETPLACE.id,
    );
    expect(res.body.division).toBe('MARKETPLACE');
    expect(res.body.companyDivision).toMatchObject({
      code: 'MARKETPLACE',
      name: 'Маркетплейс',
    });
  });

  test('PHASE 1: legacy `division` без `companyDivisionId` находит карточку по `code`', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/display-screens')
      .set('Cookie', cookies.manager)
      .send({
        name: 'Legacy экран',
        division: 'OTHER',
        login: 'display-legacy',
        pin: 'pin-1234',
        isActive: true,
      });
    expect(res.status).toBe(201);
    expect(res.body.division).toBe('OTHER');
    expect(res.body.companyDivisionId).toBe(
      seed.companyDivisions.OTHER.id,
    );
  });

  // ---------------------------------------------------------------------------
  // 2. Уникальность login + rollback
  // ---------------------------------------------------------------------------

  test('повторный login → 409 DISPLAY_LOGIN_TAKEN, новой пары Employee+Config не создаётся', async () => {
    const ok = await request(t.app.getHttpServer())
      .post('/api/display-screens')
      .set('Cookie', cookies.manager)
      .send({
        name: 'Первый',
        division: 'MARKETPLACE',
        login: 'display-dup',
        pin: 'pin-1234',
        isActive: true,
      });
    expect(ok.status).toBe(201);

    const dup = await request(t.app.getHttpServer())
      .post('/api/display-screens')
      .set('Cookie', cookies.manager)
      .send({
        name: 'Второй',
        division: 'OTHER',
        login: 'DISPLAY-DUP',
        pin: 'pin-9999',
        isActive: true,
      });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('DISPLAY_LOGIN_TAKEN');

    // В БД ровно одна DISPLAY-учётка по этому логину и ровно один config.
    const employees = await t.prisma.employee.findMany({
      where: { login: 'display-dup' },
    });
    expect(employees).toHaveLength(1);
    const configs = await t.prisma.displayScreenConfig.findMany({
      where: { name: { in: ['Первый', 'Второй'] } },
    });
    expect(configs).toHaveLength(1);
    expect(configs[0]!.name).toBe('Первый');
  });

  test('коллизия login с не-DISPLAY Employee → тоже 409 DISPLAY_LOGIN_TAKEN, ничего не создаётся', async () => {
    // Логин уже занят обычным сотрудником (seed: 'shop-chief').
    const res = await request(t.app.getHttpServer())
      .post('/api/display-screens')
      .set('Cookie', cookies.manager)
      .send({
        name: 'Конфликтный',
        division: 'OTHER',
        login: 'shop-chief',
        pin: 'pin-1234',
        isActive: true,
      });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DISPLAY_LOGIN_TAKEN');

    // shop-chief не превратился в DISPLAY и его pinHash не перезаписан.
    const emp = await t.prisma.employee.findUnique({
      where: { login: 'shop-chief' },
    });
    expect(emp!.role).toBe('SHOP_MANAGER');
    const configs = await t.prisma.displayScreenConfig.findMany({
      where: { name: 'Конфликтный' },
    });
    expect(configs).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // 3. RBAC
  // ---------------------------------------------------------------------------

  test('RBAC: SEAMSTRESS → 403 на POST и GET /api/display-screens', async () => {
    const post = await request(t.app.getHttpServer())
      .post('/api/display-screens')
      .set('Cookie', cookies.seamstress)
      .send({
        name: 'Hack',
        division: 'MARKETPLACE',
        login: 'evil',
        pin: 'pin-1234',
        isActive: true,
      });
    expect(post.status).toBe(403);
    expect(post.body.code).toBe('FORBIDDEN_ROLE');

    const get = await request(t.app.getHttpServer())
      .get('/api/display-screens')
      .set('Cookie', cookies.seamstress);
    expect(get.status).toBe(403);
  });

  test('RBAC: DISPLAY-роль не имеет доступа к admin-эндпоинту', async () => {
    // Заводим DISPLAY-учётку через сам endpoint — это и так полпути
    // happy-path'а, но здесь нам нужен ровно её session-cookie.
    const created = await request(t.app.getHttpServer())
      .post('/api/display-screens')
      .set('Cookie', cookies.manager)
      .send({
        name: 'Self',
        division: 'OTHER',
        login: 'display-self',
        pin: 'pin-1234',
        isActive: true,
      });
    expect(created.status).toBe(201);
    const displayCookie = loginAs(t, {
      id: created.body.employeeId,
      login: created.body.employeeLogin,
      role: 'DISPLAY',
      fullName: 'Display: Self',
    });

    const post = await request(t.app.getHttpServer())
      .post('/api/display-screens')
      .set('Cookie', displayCookie)
      .send({
        name: 'Hack',
        division: 'MARKETPLACE',
        login: 'display-evil',
        pin: 'pin-1234',
        isActive: true,
      });
    expect(post.status).toBe(403);
  });

  // ---------------------------------------------------------------------------
  // 4. Auto-division в /api/shopfloor/display
  // ---------------------------------------------------------------------------

  test('DISPLAY без query.division получает агрегат СВОЕГО подразделения; query.division перекрывает', async () => {
    const today = new Date();

    // Создаём по одному заказу/паспорту в каждом подразделении.
    const orderMp = await t.prisma.order.create({
      data: {
        number: 'O-DSC-MP',
        orderDate: today,
        color: 'Чёрный',
        status: 'IN_PRODUCTION',
        division: 'MARKETPLACE',
        items: {
          create: [
            { productId: seed.product.id, sizeId: seed.sizes.S, qtyPlan: 4 },
          ],
        },
      },
    });
    await t.prisma.passport.create({
      data: {
        number: 'P-DSC-MP-S',
        qrCode: 'passport:dsc-mp-s',
        orderId: orderMp.id,
        productId: seed.product.id,
        sizeId: seed.sizes.S,
        color: 'Чёрный',
        rollNumber: 'R-MP',
        cutDate: today,
        qtyPlan: 4,
        qtyCut: 4,
        qtyGood: 4,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
        status: 'CREATED',
      },
    });

    const orderOther = await t.prisma.order.create({
      data: {
        number: 'O-DSC-OTH',
        orderDate: today,
        color: 'Белый',
        status: 'IN_PRODUCTION',
        division: 'OTHER',
        items: {
          create: [
            { productId: seed.product.id, sizeId: seed.sizes.M, qtyPlan: 7 },
          ],
        },
      },
    });
    await t.prisma.passport.create({
      data: {
        number: 'P-DSC-OTH-M',
        qrCode: 'passport:dsc-oth-m',
        orderId: orderOther.id,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: 'Белый',
        rollNumber: 'R-OTH',
        cutDate: today,
        qtyPlan: 7,
        qtyCut: 7,
        qtyGood: 7,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
        status: 'CREATED',
      },
    });

    // Заводим display-экран MARKETPLACE.
    const created = await request(t.app.getHttpServer())
      .post('/api/display-screens')
      .set('Cookie', cookies.manager)
      .send({
        name: 'MP Screen',
        division: 'MARKETPLACE',
        login: 'display-mp-auto',
        pin: 'pin-1234',
        isActive: true,
      });
    expect(created.status).toBe(201);
    const displayCookie = loginAs(t, {
      id: created.body.employeeId,
      login: created.body.employeeLogin,
      role: 'DISPLAY',
      fullName: 'Display: MP Screen',
    });

    // 1) DISPLAY без query → только MARKETPLACE.
    const auto = await request(t.app.getHttpServer())
      .get('/api/shopfloor/display')
      .set('Cookie', displayCookie);
    expect(auto.status).toBe(200);
    expect(auto.body.colors.map((c: { colorKey: string }) => c.colorKey)).toEqual([
      'black',
    ]);
    expect(auto.body.kpi.waiting).toBe(4);

    // 2) DISPLAY с явным query → query побеждает (старый контракт).
    const overridden = await request(t.app.getHttpServer())
      .get('/api/shopfloor/display?division=OTHER')
      .set('Cookie', displayCookie);
    expect(overridden.status).toBe(200);
    expect(
      overridden.body.colors.map((c: { colorKey: string }) => c.colorKey),
    ).toEqual(['white']);
    expect(overridden.body.kpi.waiting).toBe(7);

    // 3) Не-DISPLAY роль без query → как раньше: оба подразделения.
    const all = await request(t.app.getHttpServer())
      .get('/api/shopfloor/display')
      .set('Cookie', cookies.manager);
    expect(all.status).toBe(200);
    expect(
      all.body.colors
        .map((c: { colorKey: string }) => c.colorKey)
        .sort(),
    ).toEqual(['black', 'white']);
    expect(all.body.kpi.waiting).toBe(11);
  });

  test('DISPLAY с isActive=false → auto-detection отключён, отдаётся «общий» агрегат', async () => {
    const today = new Date();
    const orderMp = await t.prisma.order.create({
      data: {
        number: 'O-DSC-OFF',
        orderDate: today,
        color: 'Чёрный',
        status: 'IN_PRODUCTION',
        division: 'MARKETPLACE',
        items: {
          create: [
            { productId: seed.product.id, sizeId: seed.sizes.S, qtyPlan: 3 },
          ],
        },
      },
    });
    await t.prisma.passport.create({
      data: {
        number: 'P-DSC-OFF-S',
        qrCode: 'passport:dsc-off-s',
        orderId: orderMp.id,
        productId: seed.product.id,
        sizeId: seed.sizes.S,
        color: 'Чёрный',
        rollNumber: 'R-OFF',
        cutDate: today,
        qtyPlan: 3,
        qtyCut: 3,
        qtyGood: 3,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
        status: 'CREATED',
      },
    });
    const orderOther = await t.prisma.order.create({
      data: {
        number: 'O-DSC-OFF2',
        orderDate: today,
        color: 'Белый',
        status: 'IN_PRODUCTION',
        division: 'OTHER',
        items: {
          create: [
            { productId: seed.product.id, sizeId: seed.sizes.M, qtyPlan: 5 },
          ],
        },
      },
    });
    await t.prisma.passport.create({
      data: {
        number: 'P-DSC-OFF2-M',
        qrCode: 'passport:dsc-off2-m',
        orderId: orderOther.id,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: 'Белый',
        rollNumber: 'R-OFF2',
        cutDate: today,
        qtyPlan: 5,
        qtyCut: 5,
        qtyGood: 5,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
        status: 'CREATED',
      },
    });

    const created = await request(t.app.getHttpServer())
      .post('/api/display-screens')
      .set('Cookie', cookies.manager)
      .send({
        name: 'Off Screen',
        division: 'MARKETPLACE',
        login: 'display-off',
        pin: 'pin-1234',
        isActive: false,
      });
    expect(created.status).toBe(201);
    expect(created.body.isActive).toBe(false);

    const displayCookie = loginAs(t, {
      id: created.body.employeeId,
      login: created.body.employeeLogin,
      role: 'DISPLAY',
      fullName: 'Display: Off Screen',
    });

    const res = await request(t.app.getHttpServer())
      .get('/api/shopfloor/display')
      .set('Cookie', displayCookie);
    expect(res.status).toBe(200);
    // Видит оба подразделения (3 + 5), потому что isActive=false
    // выключает auto-detection.
    expect(res.body.kpi.waiting).toBe(3 + 5);
  });
});
