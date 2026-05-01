/**
 * Integration-тест нового агрегата `GET /api/shopfloor/display`
 * (Шаг 10b, экран `/shopfloor/display` — light-theme dashboard).
 *
 * Проверяем:
 *   1. KPI-блок (`producedToday`, `inWork`, `waiting`, `qc`, `wto`,
 *      `packing`, `finished`, `defect`) корректно собирается из
 *      `Passport`/`PassportEvent`.
 *   2. Матрица «цвет × размер × stage» группирует по нормализованному
 *      цвету (черный/белый сворачиваются вне зависимости от регистра
 *      и языка) и по размерам.
 *   3. `equipment[].kind` выводится из категорий разрешённых операций.
 *   4. Endpoint доступен роли `DISPLAY` (большой монитор) — это его
 *      основной потребитель.
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

describeWithDb('integration — /api/shopfloor/display (display dashboard)', () => {
  let t: TestApp;
  let seed: SeedResult;

  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await stopTestApp(t);
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    seed = await seedMinimal(t.prisma);
  });

  test('агрегирует KPI + матрицу цвет × размер × stage из живых паспортов', async () => {
    const today = new Date();
    // Заказ ЧЁРНЫЙ — два паспорта разных размеров на разных стадиях.
    const orderBlack = await t.prisma.order.create({
      data: {
        number: 'O-DSP-BLK',
        orderDate: today,
        color: 'Чёрный',
        status: 'IN_PRODUCTION',
        items: {
          create: [
            { productId: seed.product.id, sizeId: seed.sizes.S, qtyPlan: 10 },
            { productId: seed.product.id, sizeId: seed.sizes.M, qtyPlan: 10 },
          ],
        },
      },
    });
    // Чёрный, размер S, 4 шт — крой готов, ждёт швею (CREATED).
    await t.prisma.passport.create({
      data: {
        number: 'P-DSP-BLK-S',
        qrCode: 'passport:dsp-blk-s',
        orderId: orderBlack.id,
        productId: seed.product.id,
        sizeId: seed.sizes.S,
        color: 'Чёрный',
        rollNumber: 'R-1',
        cutDate: today,
        qtyPlan: 4,
        qtyCut: 4,
        qtyGood: 4,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
        status: 'CREATED',
      },
    });
    // Чёрный, размер M, 3 шт — в шитье.
    await t.prisma.passport.create({
      data: {
        number: 'P-DSP-BLK-M',
        qrCode: 'passport:dsp-blk-m',
        orderId: orderBlack.id,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: 'Чёрный',
        rollNumber: 'R-2',
        cutDate: today,
        qtyPlan: 3,
        qtyCut: 3,
        qtyGood: 3,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
        status: 'IN_PROGRESS',
        currentOperationId: seed.operations.SEW_OVERLOCK_1.id,
      },
    });

    // Заказ БЕЛЫЙ — один паспорт, паковали сегодня (= producedToday).
    const orderWhite = await t.prisma.order.create({
      data: {
        number: 'O-DSP-WHT',
        orderDate: today,
        color: 'Белый',
        status: 'IN_PRODUCTION',
        items: {
          create: [
            { productId: seed.product.id, sizeId: seed.sizes.M, qtyPlan: 5 },
          ],
        },
      },
    });
    const packedPassport = await t.prisma.passport.create({
      data: {
        number: 'P-DSP-WHT-M',
        qrCode: 'passport:dsp-wht-m',
        orderId: orderWhite.id,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: 'белый',
        rollNumber: 'R-3',
        cutDate: today,
        qtyPlan: 5,
        qtyCut: 5,
        qtyGood: 5,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
        status: 'PACKED',
      },
    });
    await t.prisma.passportEvent.create({
      data: {
        passportId: packedPassport.id,
        type: 'PACKED',
        employeeId: seed.employees.packer.id,
        qty: 5,
        createdAt: today,
      },
    });

    const res = await request(t.app.getHttpServer())
      .get('/api/shopfloor/display')
      .set('Cookie', t.adminCookie);
    expect(res.status).toBe(200);

    const body = res.body as {
      kpi: {
        producedToday: number;
        inWork: number;
        waiting: number;
        qc: number;
        finished: number;
        defect: number;
      };
      colors: Array<{
        colorKey: string;
        colorLabel: string;
        rows: Array<{ sizeCode: string; qtyCut: number; qtySewing: number }>;
        totals: { qtyCut: number; qtySewing: number; qtyFinished: number };
      }>;
      totals: { qtyCut: number; qtySewing: number; qtyFinished: number };
      equipment: Array<{
        code: string;
        status: string;
        kind: string;
      }>;
    };

    // KPI «Выпущено сегодня» = qtyGood по PACKED-событию (5 шт).
    expect(body.kpi.producedToday).toBe(5);
    // «Ждёт» = qtyCut по CREATED-паспорту (4 шт).
    expect(body.kpi.waiting).toBe(4);
    // «В работе» = qtySewing (3 шт). Финиш не считается «в работе».
    expect(body.kpi.inWork).toBe(3);
    expect(body.kpi.finished).toBe(5);
    expect(body.kpi.defect).toBe(0);

    // Матрица: чёрный сверху, затем белый. Кириллица «Чёрный»/«Белый»
    // и латиница «белый» сворачиваются в канонические `black`/`white`.
    expect(body.colors.map((c) => c.colorKey)).toEqual(['black', 'white']);
    expect(body.colors[0].colorLabel).toBe('Чёрный');
    expect(body.colors[1].colorLabel).toBe('Белый');

    const black = body.colors[0];
    expect(black.rows.map((r) => r.sizeCode)).toEqual(['S', 'M']);
    expect(black.totals.qtyCut).toBe(4);
    expect(black.totals.qtySewing).toBe(3);

    const white = body.colors[1];
    expect(white.rows.map((r) => r.sizeCode)).toEqual(['M']);
    expect(white.totals.qtyFinished).toBe(5);

    // Глобальный итог по всем цветам.
    expect(body.totals.qtyCut).toBe(4);
    expect(body.totals.qtySewing).toBe(3);
    expect(body.totals.qtyFinished).toBe(5);

    // Оборудование: каждое имеет `kind`. Категория должна совпадать с
    // категорией хотя бы одной разрешённой операции (см. `pickEquipmentKind`).
    expect(body.equipment.length).toBeGreaterThan(0);
    const overlock = body.equipment.find((e) => e.code === 'overlock-01');
    expect(overlock?.kind).toBe('SEWING');
    const cuttingTable = body.equipment.find((e) => e.code === 'cutting-table-01');
    expect(cuttingTable?.kind).toBe('CUTTING');
    const qcStation = body.equipment.find((e) => e.code === 'qc-station-01');
    expect(qcStation?.kind).toBe('QC');
    const ironingStation = body.equipment.find(
      (e) => e.code === 'ironing-station-01',
    );
    expect(ironingStation?.kind).toBe('IRONING');
    const packingStation = body.equipment.find(
      (e) => e.code === 'packing-station-01',
    );
    expect(packingStation?.kind).toBe('PACKING');
  });

  test('sewing-колонки динамические: только ненулевые операции, стабильный sortOrder', async () => {
    const today = new Date();
    const order = await t.prisma.order.create({
      data: {
        number: 'O-DSP-SEW',
        orderDate: today,
        color: 'Чёрный',
        status: 'IN_PRODUCTION',
        items: {
          create: [
            { productId: seed.product.id, sizeId: seed.sizes.S, qtyPlan: 20 },
            { productId: seed.product.id, sizeId: seed.sizes.M, qtyPlan: 20 },
          ],
        },
      },
    });
    // 4 шт на Оверлоке 1 (sortOrder=80).
    await t.prisma.passport.create({
      data: {
        number: 'P-SEW-O1',
        qrCode: 'passport:sew-o1',
        orderId: order.id,
        productId: seed.product.id,
        sizeId: seed.sizes.S,
        color: 'Чёрный',
        rollNumber: 'R-SEW-1',
        cutDate: today,
        qtyPlan: 4,
        qtyCut: 4,
        qtyGood: 4,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
        status: 'IN_PROGRESS',
        currentOperationId: seed.operations.SEW_OVERLOCK_1.id,
      },
    });
    // 7 шт на Оверлоке 2 (sortOrder=100) — должны идти после Оверлока 1.
    await t.prisma.passport.create({
      data: {
        number: 'P-SEW-O2',
        qrCode: 'passport:sew-o2',
        orderId: order.id,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: 'Чёрный',
        rollNumber: 'R-SEW-2',
        cutDate: today,
        qtyPlan: 7,
        qtyCut: 7,
        qtyGood: 7,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
        status: 'IN_PROGRESS',
        currentOperationId: seed.operations.SEW_OVERLOCK_2.id,
      },
    });

    // Используем seed-эмплоя (shop-chief) вместо `t.adminCookie`, потому что
    // `resetDatabase` truncate'ит таблицу `Employee` в `beforeEach`, а
    // системный админ создаётся один раз в `beforeAll` и после первого
    // reset'а перестаёт существовать. seed-сотрудник пересоздаётся каждый
    // раз и его cookie всегда валиден.
    const cookie = loginAs(t, seed.employees['shop-chief']);
    const res = await request(t.app.getHttpServer())
      .get('/api/shopfloor/display')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);

    const body = res.body as {
      sewingColumns: Array<{ key: string; label: string; sortOrder: number }>;
      colors: Array<{
        rows: Array<{ sizeCode: string; qtySewing: number; sewingByOp: Record<string, number> }>;
        totals: { qtySewing: number; sewingByOp: Record<string, number> };
      }>;
      totals: { qtySewing: number; sewingByOp: Record<string, number> };
    };

    // Только ненулевые sewing-операции попадают в `sewingColumns`,
    // порядок — по `sortOrder` операций (Оверлок 1 → Оверлок 2).
    expect(body.sewingColumns.map((c) => c.label)).toEqual([
      'Оверлок 1',
      'Оверлок 2',
    ]);
    expect(body.sewingColumns[0].sortOrder).toBe(80);
    expect(body.sewingColumns[1].sortOrder).toBe(100);

    const op1Key = body.sewingColumns[0].key;
    const op2Key = body.sewingColumns[1].key;

    // Grand totals: 4 + 7 = 11 в пошиве, разбивка хранится в `sewingByOp`.
    expect(body.totals.qtySewing).toBe(11);
    expect(body.totals.sewingByOp[op1Key]).toBe(4);
    expect(body.totals.sewingByOp[op2Key]).toBe(7);

    // Per-color totals и per-row значения сохраняют разбивку.
    const black = body.colors[0];
    expect(black.totals.sewingByOp[op1Key]).toBe(4);
    expect(black.totals.sewingByOp[op2Key]).toBe(7);
    const rowS = black.rows.find((r) => r.sizeCode === 'S');
    const rowM = black.rows.find((r) => r.sizeCode === 'M');
    expect(rowS?.sewingByOp[op1Key]).toBe(4);
    expect(rowS?.sewingByOp[op2Key]).toBeFalsy();
    expect(rowM?.sewingByOp[op2Key]).toBe(7);
    expect(rowM?.sewingByOp[op1Key]).toBeFalsy();

    // Ни одной паразитной колонки сверх двух занятых операций.
    expect(body.sewingColumns.length).toBe(2);
  });

  // Регрессия: до фикса этот сценарий был основной причиной, по которой
  // на дисплее «всё уходило в Ожидает». Швея открывает смену на
  // конкретной sewing-операции (Оверлок), нажимает «Принять крой» —
  // и `Passport.currentOperationId` остаётся CUT_DIVISION (CUTTING)
  // до её отдельного OPERATION_SCAN. Доменно правильная sewing-операция
  // в этот момент живёт только в открытой `ShiftSession` швеи.
  // Display-проекция теперь подбирает sewing-колонку из shift'а, а не
  // оставляет паспорт в pending.
  test('issued (без OPERATION_SCAN) попадает в колонку sewing-операции открытой смены швеи', async () => {
    const today = new Date();
    const order = await t.prisma.order.create({
      data: {
        number: 'O-DSP-ISSUE',
        orderDate: today,
        color: 'Чёрный',
        status: 'IN_PRODUCTION',
        items: {
          create: [
            { productId: seed.product.id, sizeId: seed.sizes.M, qtyPlan: 6 },
          ],
        },
      },
    });
    // Швея открыла смену на Оверлоке 1, паспорт ей выдан, но ещё не
    // отсканирован → currentOperation остаётся «Деление кроя» (CUTTING),
    // currentEmployeeId уже указывает на швею. Это и есть состояние
    // после `PassportsService.issueToEmployee`.
    await t.prisma.shiftSession.create({
      data: {
        employeeId: seed.employees.seamstress.id,
        equipmentId: seed.equipment['overlock-01'].id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
        startedAt: today,
      },
    });
    await t.prisma.passport.create({
      data: {
        number: 'P-DSP-ISSUE',
        qrCode: 'passport:dsp-issue',
        orderId: order.id,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: 'Чёрный',
        rollNumber: 'R-ISSUE',
        cutDate: today,
        qtyPlan: 6,
        qtyCut: 6,
        qtyGood: 6,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
        status: 'IN_PROGRESS',
        currentOperationId: seed.operations.CUT_DIVISION.id,
        currentEmployeeId: seed.employees.seamstress.id,
      },
    });

    const cookie = loginAs(t, seed.employees['shop-chief']);
    const res = await request(t.app.getHttpServer())
      .get('/api/shopfloor/display')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);

    const body = res.body as {
      sewingColumns: Array<{ key: string; label: string }>;
      totals: { qtySewing: number; sewingByOp: Record<string, number> };
    };

    // Колонка одна — Оверлок 1, никакой «Ожидает».
    expect(body.sewingColumns.map((c) => c.label)).toEqual(['Оверлок 1']);
    expect(body.sewingColumns[0]!.key).toBe(seed.operations.SEW_OVERLOCK_1.id);
    expect(body.totals.qtySewing).toBe(6);
    expect(body.totals.sewingByOp[seed.operations.SEW_OVERLOCK_1.id]).toBe(6);
  });

  test('доступен роли DISPLAY (основной потребитель экрана)', async () => {
    // Создаём учётку роли DISPLAY и логинимся ею.
    const display = await t.prisma.employee.create({
      data: {
        login: 'display-1',
        fullName: 'Display Terminal',
        role: 'DISPLAY',
        paymentType: 'SALARY',
        active: true,
        pinHash: '$2a$04$abcdefghijklmnopqrstuv',
      },
    });
    const cookie = loginAs(t, {
      id: display.id,
      role: 'DISPLAY',
      login: display.login,
      fullName: display.fullName,
    });

    const res = await request(t.app.getHttpServer())
      .get('/api/shopfloor/display')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('kpi');
    expect(res.body).toHaveProperty('colors');
    expect(res.body).toHaveProperty('equipment');
  });

  test('отсутствие активных паспортов даёт пустую матрицу и нулевые KPI', async () => {
    const res = await request(t.app.getHttpServer())
      .get('/api/shopfloor/display')
      .set('Cookie', t.adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.colors).toEqual([]);
    expect(res.body.kpi.producedToday).toBe(0);
    expect(res.body.kpi.inWork).toBe(0);
    expect(res.body.kpi.waiting).toBe(0);
    expect(res.body.kpi.defect).toBe(0);
    // Оборудование всё равно отдаётся — оно есть из seed'а.
    expect(res.body.equipment.length).toBeGreaterThan(0);
  });
});
