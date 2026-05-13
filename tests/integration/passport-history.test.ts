/**
 * Integration-тест `GET /api/passports/:id/history` — endpoint
 * хронологии `PassportEvent` для экрана `/master` («Посмотреть
 * историю паспорта» в `PassportActionsSheet`).
 *
 * Покрываем:
 *   A. Стабильный хронологический порядок (createdAt asc, tie-break
 *      по id) + подтянутые имена operation/employee/cell.
 *   B. Поле `manual=true` для событий с id-префиксом `man_`
 *      (соглашение для ручных правок админа, см. инциденты 12.05.2026).
 *   C. RBAC: SHOPFLOOR_MASTER / SHOP_MANAGER / ADMIN — 200,
 *      SEAMSTRESS / CUTTER — 403.
 *   D. Несуществующий passportId → 404 PASSPORT_NOT_FOUND.
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

describeWithDb('integration — GET /api/passports/:id/history', () => {
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
      master: loginAs(t, seed.employees['master']),
      manager: loginAs(t, seed.employees['shop-chief']),
      seamstress: loginAs(t, seed.employees['seamstress']),
      cutter: loginAs(t, seed.employees['cutter']),
    };
  });

  /**
   * Создаёт паспорт со списком готовых событий разных типов: CREATED,
   * CELL_PLACED, ISSUED_TO_EMPLOYEE, OPERATION_FINISHED — этого
   * достаточно для проверки порядка и подтягивания связных сущностей.
   * Возвращает passportId и id события OPERATION_FINISHED (мы пишем
   * его с префиксом `man_*`, чтобы проверить флаг `manual`).
   */
  async function setup(): Promise<{
    passportId: string;
    manualEventId: string;
  }> {
    const today = new Date();
    const order = await t.prisma.order.create({
      data: {
        number: `O-HIST-${Math.random().toString(36).slice(2, 6)}`,
        orderDate: today,
        color: 'Чёрный',
        status: 'IN_PRODUCTION',
        items: {
          create: [
            { productId: seed.product.id, sizeId: seed.sizes.M, qtyPlan: 4 },
          ],
        },
      },
    });
    const passport = await t.prisma.passport.create({
      data: {
        number: `P-HIST-${Math.random().toString(36).slice(2, 6)}`,
        qrCode: `passport:hist-${Math.random().toString(36).slice(2, 6)}`,
        orderId: order.id,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: 'Чёрный',
        rollNumber: 'R-HIST',
        cutDate: today,
        qtyPlan: 4,
        qtyCut: 4,
        qtyGood: 4,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
        status: 'IN_PROGRESS',
      },
    });
    // События пишем явными ISO-датами через `createdAt`, чтобы порядок
    // не зависел от точности timestamp'а БД.
    const base = today.getTime();
    await t.prisma.passportEvent.create({
      data: {
        passportId: passport.id,
        type: 'CREATED',
        operationId: seed.operations.CUT_DIVISION.id,
        employeeId: seed.employees.cutter.id,
        qty: 4,
        createdAt: new Date(base + 1000),
      },
    });
    await t.prisma.passportEvent.create({
      data: {
        passportId: passport.id,
        type: 'CELL_PLACED',
        cellId: seed.cells.A1.id,
        qty: 4,
        createdAt: new Date(base + 2000),
      },
    });
    await t.prisma.passportEvent.create({
      data: {
        passportId: passport.id,
        type: 'ISSUED_TO_EMPLOYEE',
        operationId: seed.operations.SEW_OVERLOCK_1.id,
        employeeId: seed.employees.seamstress.id,
        cellId: seed.cells.A1.id,
        qty: 4,
        createdAt: new Date(base + 3000),
      },
    });
    const manualEvent = await t.prisma.passportEvent.create({
      data: {
        // ВАЖНО: префикс `man_*` — соглашение для ручных правок
        // админа. Сервис ставит `manual = true` для таких записей,
        // и UI помечает их «(ручная правка)». См. JSDoc у getHistory.
        id: 'man_test_history_' + Math.random().toString(36).slice(2, 10),
        passportId: passport.id,
        type: 'OPERATION_FINISHED',
        operationId: seed.operations.SEW_OVERLOCK_1.id,
        employeeId: seed.employees.seamstress.id,
        qty: 4,
        createdAt: new Date(base + 4000),
      },
    });
    return { passportId: passport.id, manualEventId: manualEvent.id };
  }

  // ---------------------------------------------------------------------
  // A. Порядок + подтянутые имена
  // ---------------------------------------------------------------------

  test('A. возвращает события в хронологическом порядке с именами operation/employee/cell', async () => {
    const { passportId } = await setup();
    const res = await request(t.app.getHttpServer())
      .get(`/api/passports/${passportId}/history`)
      .set('Cookie', cookies.master)
      .expect(200);
    expect(res.body.passportId).toBe(passportId);
    const events = res.body.events as Array<{
      type: string;
      typeLabel: string;
      operation: { name: string } | null;
      employee: { fullName: string } | null;
      cell: { code: string } | null;
      manual: boolean;
    }>;
    expect(events.map((e) => e.type)).toEqual([
      'CREATED',
      'CELL_PLACED',
      'ISSUED_TO_EMPLOYEE',
      'OPERATION_FINISHED',
    ]);
    // Подписи (typeLabel) из shared/passports.ts → PASSPORT_EVENT_LABELS.
    expect(events[0]?.typeLabel).toBe('Паспорт выпущен');
    expect(events[1]?.typeLabel).toBe('Положен в ячейку');
    expect(events[2]?.typeLabel).toBe('Выдан сотруднику');
    expect(events[3]?.typeLabel).toBe('Операция завершена');
    // Подтянутые имена.
    expect(events[0]?.operation?.name).toBe('Деление кроя');
    expect(events[0]?.employee?.fullName).toBe('Test Cutter');
    expect(events[1]?.cell?.code).toBe('A1');
    expect(events[1]?.employee).toBeNull();
    expect(events[2]?.operation?.name).toBe('Оверлок 1');
    expect(events[2]?.employee?.fullName).toBe('Test Seamstress');
    expect(events[2]?.cell?.code).toBe('A1');
  });

  // ---------------------------------------------------------------------
  // B. Manual flag
  // ---------------------------------------------------------------------

  test('B. событие с id-префиксом man_ помечается manual=true', async () => {
    const { passportId, manualEventId } = await setup();
    const res = await request(t.app.getHttpServer())
      .get(`/api/passports/${passportId}/history`)
      .set('Cookie', cookies.master)
      .expect(200);
    const events = res.body.events as Array<{ id: string; manual: boolean }>;
    const created = events.find((e) => e.id !== manualEventId && !e.manual);
    const manual = events.find((e) => e.id === manualEventId);
    expect(created?.manual).toBe(false);
    expect(manual?.manual).toBe(true);
  });

  // ---------------------------------------------------------------------
  // C. RBAC
  // ---------------------------------------------------------------------

  test('C. RBAC: master/manager — 200, seamstress/cutter — 403', async () => {
    const { passportId } = await setup();
    await request(t.app.getHttpServer())
      .get(`/api/passports/${passportId}/history`)
      .set('Cookie', cookies.master)
      .expect(200);
    await request(t.app.getHttpServer())
      .get(`/api/passports/${passportId}/history`)
      .set('Cookie', cookies.manager)
      .expect(200);
    await request(t.app.getHttpServer())
      .get(`/api/passports/${passportId}/history`)
      .set('Cookie', cookies.seamstress)
      .expect(403);
    await request(t.app.getHttpServer())
      .get(`/api/passports/${passportId}/history`)
      .set('Cookie', cookies.cutter)
      .expect(403);
  });

  // ---------------------------------------------------------------------
  // D. 404
  // ---------------------------------------------------------------------

  test('D. несуществующий passportId → 404 PASSPORT_NOT_FOUND', async () => {
    const res = await request(t.app.getHttpServer())
      .get('/api/passports/no-such-id/history')
      .set('Cookie', cookies.master)
      .expect(404);
    expect(res.body?.code).toBe('PASSPORT_NOT_FOUND');
  });
});
