/**
 * Integration-тесты явной атрибуции раскройщика (PHASE 2 STEP 3).
 *
 * Покрытие контракта `POST /api/passports` (см.
 * `apps/api/src/modules/passports/passports.service.ts::create`,
 * `docs/api.md §13 «Cutter attribution»`):
 *
 *   1. creator с ролью CUTTER без `cutterId` → начисление creator-у
 *      (исторический happy-path рабочего места раскройщика).
 *   2. creator с ролью SHOP_MANAGER без `cutterId` → 400
 *      `CUTTER_REQUIRED` (UI обязан показать select).
 *   3. `cutterId` указан явно (любая creator-роль с правом выпуска) →
 *      начисление пишется выбранному CUTTER, НЕ creator-у.
 *   4. `cutterId` указан, но сотрудник не имеет роли CUTTER → 400
 *      `CUTTER_NOT_FOUND` (общий код для «нет сотрудника» и «не CUTTER»,
 *      чтобы не светить enum-сравнения наружу).
 *   5. `cutterId` указан, сотрудник CUTTER, но `active = false` → 400
 *      `CUTTER_INACTIVE`.
 *   6. fallback на seed-учётку `Employee.login = 'cutter'` НЕ
 *      используется: даже если она существует, без явного `cutterId`
 *      / creator-CUTTER backend всё равно отвечает `CUTTER_REQUIRED`
 *      (регрессия на удалённый legacy lookup).
 *
 * Полный сквозной поток (issue → scan → pack → начисления швее)
 * покрыт `production-flow.test.ts` — тут только контракт атрибуции
 * раскройщика и форма immediate-начисления.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import {
  loginAs,
  refreshAdminCookie,
  startTestApp,
  stopTestApp,
  type TestApp,
} from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

describeWithDb('integration — cutter attribution (PHASE 2 STEP 3)', () => {
  let t: TestApp;
  let seed: SeedResult;
  let cookies: { manager: string; cutter: string };
  let orderId: string;
  let sizeId: string;

  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await stopTestApp(t);
  });

  beforeEach(async () => {
    await resetDatabase(t.prisma);
    seed = await seedMinimal(t.prisma);
    await refreshAdminCookie(t);
    cookies = {
      manager: loginAs(t, seed.employees['shop-chief']),
      cutter: loginAs(t, seed.employees['cutter']),
    };
    sizeId = seed.sizes.M;

    // Заказ в IN_PRODUCTION — это единственное, что нужно
    // `PassportsService.create` для самого выпуска. Маршрут не
    // проставляем — атрибуция раскройщика от него не зависит.
    const created = await t.prisma.order.create({
      data: {
        number: `O-CUT-ATTR-${Math.random().toString(36).slice(2, 8)}`,
        orderDate: new Date(),
        color: seed.product.color,
        status: 'IN_PRODUCTION',
        companyDivisionId: seed.companyDivisions.OTHER.id,
        items: {
          create: { productId: seed.product.id, sizeId, qtyPlan: 50 },
        },
      },
    });
    orderId = created.id;
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function passportBody(
    extra: Partial<{ cutterId: string; qtyCut: number }> = {},
  ): Record<string, unknown> {
    const { cutterId, qtyCut = 5 } = extra;
    return {
      orderId,
      sizeId,
      rollNumber: `R-${Math.floor(Math.random() * 1e6)}`,
      cutDate: '2026-04-15T00:00:00.000Z',
      qtyCut,
      ...(cutterId ? { cutterId } : {}),
    };
  }

  /**
   * После успешного `POST /api/passports` immediate-начисление за
   * раскрой пишется в `OperationEntry` (см.
   * `EarningsService.createImmediateForCutter`). Helper возвращает
   * `employeeId` записи для проверки атрибуции.
   */
  async function immediateCutterEntryEmployee(
    passportId: string,
  ): Promise<string | null> {
    const entry = await t.prisma.operationEntry.findFirst({
      where: {
        passportId,
        sourceEventType: 'PASSPORT_CREATED',
      },
      select: { employeeId: true },
    });
    return entry?.employeeId ?? null;
  }

  // ---------------------------------------------------------------------------
  // 1. creator-CUTTER без cutterId → начисление creator-у
  // ---------------------------------------------------------------------------

  test('creator-CUTTER без cutterId → паспорт создан, начисление на creator', async () => {
    const r = await request(t.app.getHttpServer())
      .post('/api/passports')
      .set('Cookie', cookies.cutter)
      .send(passportBody());
    expect(r.status).toBe(201);

    const passportId: string = r.body.id;
    expect(r.body.cutterId).toBe(seed.employees['cutter'].id);

    const attributed = await immediateCutterEntryEmployee(passportId);
    expect(attributed).toBe(seed.employees['cutter'].id);
  });

  // ---------------------------------------------------------------------------
  // 2. creator-NOT-CUTTER без cutterId → CUTTER_REQUIRED
  // ---------------------------------------------------------------------------

  test('SHOP_MANAGER без cutterId → 400 CUTTER_REQUIRED, паспорт не создан', async () => {
    const r = await request(t.app.getHttpServer())
      .post('/api/passports')
      .set('Cookie', cookies.manager)
      .send(passportBody());
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('CUTTER_REQUIRED');

    const count = await t.prisma.passport.count({ where: { orderId } });
    expect(count).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // 3. cutterId явно указан → начисление выбранному CUTTER
  // ---------------------------------------------------------------------------

  test('SHOP_MANAGER с явным cutterId → начисление идёт выбранному CUTTER, не creator-у', async () => {
    // Заводим второго CUTTER, чтобы проверка не сработала «случайно»
    // потому что cutterId совпал с seed-cutter-ом.
    const anotherCutter = await t.prisma.employee.create({
      data: {
        login: 'cutter-2',
        fullName: 'Test Cutter Second',
        role: 'CUTTER',
        active: true,
        pinHash: seed.employees['cutter'].id, // любое значение, в этом тесте PIN не используется
      },
    });

    const r = await request(t.app.getHttpServer())
      .post('/api/passports')
      .set('Cookie', cookies.manager)
      .send(passportBody({ cutterId: anotherCutter.id }));
    expect(r.status).toBe(201);

    const passportId: string = r.body.id;
    expect(r.body.cutterId).toBe(anotherCutter.id);

    const attributed = await immediateCutterEntryEmployee(passportId);
    expect(attributed).toBe(anotherCutter.id);

    // Самое главное — точно НЕ пишем seed-cutter-у и НЕ creator-у.
    expect(attributed).not.toBe(seed.employees['cutter'].id);
    expect(attributed).not.toBe(seed.employees['shop-chief'].id);
  });

  // ---------------------------------------------------------------------------
  // 4. cutterId указан, но сотрудник НЕ CUTTER → CUTTER_NOT_FOUND
  // ---------------------------------------------------------------------------

  test('cutterId указывает на сотрудника не-CUTTER (швея) → 400 CUTTER_NOT_FOUND', async () => {
    const r = await request(t.app.getHttpServer())
      .post('/api/passports')
      .set('Cookie', cookies.manager)
      .send(passportBody({ cutterId: seed.employees['seamstress'].id }));
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('CUTTER_NOT_FOUND');

    const count = await t.prisma.passport.count({ where: { orderId } });
    expect(count).toBe(0);
  });

  test('cutterId — несуществующий id → 400 CUTTER_NOT_FOUND', async () => {
    const r = await request(t.app.getHttpServer())
      .post('/api/passports')
      .set('Cookie', cookies.manager)
      .send(passportBody({ cutterId: 'non-existent-employee-id' }));
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('CUTTER_NOT_FOUND');
  });

  // ---------------------------------------------------------------------------
  // 5. cutterId указан, сотрудник CUTTER, но active=false → CUTTER_INACTIVE
  // ---------------------------------------------------------------------------

  test('cutterId — деактивированный CUTTER → 400 CUTTER_INACTIVE', async () => {
    const inactive = await t.prisma.employee.create({
      data: {
        login: 'cutter-inactive',
        fullName: 'Inactive Cutter',
        role: 'CUTTER',
        active: false,
        pinHash: seed.employees['cutter'].id,
      },
    });
    const r = await request(t.app.getHttpServer())
      .post('/api/passports')
      .set('Cookie', cookies.manager)
      .send(passportBody({ cutterId: inactive.id }));
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('CUTTER_INACTIVE');
  });

  // ---------------------------------------------------------------------------
  // 6. Регрессия: legacy fallback по login='cutter' удалён
  // ---------------------------------------------------------------------------

  test('seed-сотрудник login=cutter существует, но без cutterId фолбэка нет → CUTTER_REQUIRED', async () => {
    // Sanity: seed-cutter существует и активен (см. EMPLOYEE_SEEDS),
    // но именно его наличия раньше хватало `PassportsService.create`,
    // чтобы атрибутировать раскрой кому угодно. PHASE 2 STEP 3 этот
    // фолбэк убирает — менеджер обязан явно указать cutterId.
    const seedCutter = await t.prisma.employee.findUnique({
      where: { login: 'cutter' },
      select: { id: true, role: true, active: true },
    });
    expect(seedCutter).not.toBeNull();
    expect(seedCutter!.role).toBe('CUTTER');
    expect(seedCutter!.active).toBe(true);

    const r = await request(t.app.getHttpServer())
      .post('/api/passports')
      .set('Cookie', cookies.manager)
      .send(passportBody());
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('CUTTER_REQUIRED');
  });
});
