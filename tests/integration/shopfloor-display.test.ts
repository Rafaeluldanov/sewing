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
  refreshAdminCookie,
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
    // `resetDatabase` TRUNCATE'ит Employee, поэтому системный admin
    // из `startTestApp` исчезает, и старая `t.adminCookie` начинает
    // возвращать 401 (см. блок-комментарий у `refreshAdminCookie`).
    // Восстанавливаем admin'а и cookie в одном шаге.
    await refreshAdminCookie(t);
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

  // ---------------------------------------------------------------------
  // Маршрутный sewing-блок (`sewingRoute`) и `equipment.currentSizes`
  // ---------------------------------------------------------------------

  test('sewingRoute: считает ▶/✔ по новой WIP-buffer семантике (▶ — кто физически в работе, ✔ — буфер до следующего step)', async () => {
    const today = new Date();
    // Маршрут: Оверлок 1 (sewing) → ОТК → Оверлок 2 (sewing) → Упаковка.
    // sewingRoute должен содержать только sewing-операции (Оверлок 1
    // и Оверлок 2). Семантика split-колонок:
    //   ▶ = паспорт сейчас физически работается на этой операции
    //       (resolver через активную смену / OPERATION_SCAN);
    //   ✔ = паспорт завершил эту операцию (employee=null,
    //       currentRouteStepIndex == step.index) и ждёт следующего
    //       шага. Если паспорт уже двинулся дальше (idx > step.index)
    //       — старая операция БОЛЬШЕ ЕГО НЕ ПОКАЗЫВАЕТ.
    const tpl = await t.prisma.routeTemplate.create({
      data: {
        code: 'TPL-DSP-ROUTE',
        name: 'Маршрут для display',
        steps: {
          create: [
            { index: 0, operationId: seed.operations.SEW_OVERLOCK_1.id },
            { index: 1, operationId: seed.operations.QC.id },
            { index: 2, operationId: seed.operations.SEW_OVERLOCK_2.id },
            { index: 3, operationId: seed.operations.PACKING.id },
          ],
        },
      },
    });
    // Заказ создан и запущен — snapshot маршрута фиксируется в
    // OrderRouteStep[]. Создаём snapshot напрямую (минуя `start()`),
    // чтобы тест не зависел от полного flow заказа.
    const order = await t.prisma.order.create({
      data: {
        number: 'O-DSP-RT',
        orderDate: today,
        color: 'Чёрный',
        status: 'IN_PRODUCTION',
        routeTemplateId: tpl.id,
        items: {
          create: [
            { productId: seed.product.id, sizeId: seed.sizes.S, qtyPlan: 20 },
            { productId: seed.product.id, sizeId: seed.sizes.M, qtyPlan: 20 },
          ],
        },
        routeSteps: {
          create: [
            { index: 0, operationId: seed.operations.SEW_OVERLOCK_1.id },
            { index: 1, operationId: seed.operations.QC.id },
            { index: 2, operationId: seed.operations.SEW_OVERLOCK_2.id },
            { index: 3, operationId: seed.operations.PACKING.id },
          ],
        },
      },
    });

    // Швея на Оверлоке 1 — будет источник ▶ для одного из паспортов.
    await t.prisma.shiftSession.create({
      data: {
        employeeId: seed.employees.seamstress.id,
        equipmentId: seed.equipment['overlock-01'].id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
        startedAt: today,
      },
    });

    const mkPassport = async (
      n: string,
      sizeId: string,
      idx: number | null,
      employeeId: string | null = null,
    ): Promise<void> => {
      await t.prisma.passport.create({
        data: {
          number: n,
          qrCode: `passport:${n}`,
          orderId: order.id,
          productId: seed.product.id,
          sizeId,
          color: 'Чёрный',
          rollNumber: `R-${n}`,
          cutDate: today,
          qtyPlan: 1,
          qtyCut: 1,
          qtyGood: 1,
          cutterId: seed.employees.cutter.id,
          creatorId: seed.employees.cutter.id,
          status: idx === null ? 'CREATED' : 'IN_PROGRESS',
          currentRouteStepIndex: idx,
          currentEmployeeId: employeeId,
        },
      });
    };
    // Размер S:
    //   - P-S-A: employee=seamstress (shift на Оверлоке 1) → ▶ Оверлок 1;
    //   - P-S-B: idx=0, без исполнителя → ✔ Оверлок 1 (буфер);
    //   - P-S-C: idx=1 (ОТК), без исполнителя → НЕ показывается на
    //     sewing-операциях (idx > step.index для Оверлока 1 — старая
    //     операция больше не висит, idx < step.index для Оверлока 2);
    //   - P-S-D: idx=2 (Оверлок 2), без исполнителя → ✔ Оверлок 2.
    await mkPassport('P-S-A', seed.sizes.S, 0, seed.employees.seamstress.id);
    await mkPassport('P-S-B', seed.sizes.S, 0);
    await mkPassport('P-S-C', seed.sizes.S, 1);
    await mkPassport('P-S-D', seed.sizes.S, 2);
    // Размер M:
    //   - P-M-E: idx=3 (Упаковка) → НЕ показывается ни в одной
    //     sewing-операции (паспорт ушёл за пределы sewing-маршрута);
    //   - P-M-F: idx=null, CREATED → НЕ участвует.
    await mkPassport('P-M-E', seed.sizes.M, 3);
    await mkPassport('P-M-F', seed.sizes.M, null);

    const cookie = loginAs(t, seed.employees['shop-chief']);
    const res = await request(t.app.getHttpServer())
      .get('/api/shopfloor/display')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);

    const body = res.body as {
      sewingRoute: Array<{
        operationId: string;
        operationName: string;
        operationSortOrder: number;
        rows: Array<{
          size: string;
          inProgress: number;
          done: number;
          sizeSortOrder: number;
        }>;
      }>;
    };

    // Только sewing-операции, в порядке sortOrder (Оверлок 1 → Оверлок 2);
    // ни ОТК, ни Упаковка в блок не попадают. Обе sewing-операции
    // видны, потому что они есть в snapshot маршрута активного заказа
    // (контракт «весь маршрут активных заказов»).
    expect(body.sewingRoute.map((b) => b.operationName)).toEqual([
      'Оверлок 1',
      'Оверлок 2',
    ]);

    const op1 = body.sewingRoute[0]!;
    const op2 = body.sewingRoute[1]!;
    // Оверлок 1: S — ▶=1 (P-S-A под швеёй), ✔=1 (P-S-B буфер).
    // P-S-C на ОТК (idx=1 > 0) — НЕ висит в ✔ Оверлока 1 (старая логика
    // зачитывала бы его в done, новая — нет).
    const op1S = op1.rows.find((r) => r.size === 'S')!;
    expect(op1S.inProgress).toBe(1);
    expect(op1S.done).toBe(1);

    // Оверлок 2: S — ▶=0, ✔=1 (P-S-D ждёт ОТК-операции на step=2).
    const op2S = op2.rows.find((r) => r.size === 'S')!;
    expect(op2S.inProgress).toBe(0);
    expect(op2S.done).toBe(1);

    // Размер M есть в активных паспортах заказа (P-M-E на упаковке —
    // активный, P-M-F CREATED), поэтому строка M присутствует у
    // обеих sewing-операций ровно как 0/0: на самих sewing-операциях
    // никакой работы по M сейчас нет (P-M-E ушёл в Упаковку,
    // P-M-F ещё в кройке), но row остаётся видим на матрице.
    const op1M = op1.rows.find((r) => r.size === 'M')!;
    const op2M = op2.rows.find((r) => r.size === 'M')!;
    expect(op1M).toEqual(
      expect.objectContaining({ inProgress: 0, done: 0 }),
    );
    expect(op2M).toEqual(
      expect.objectContaining({ inProgress: 0, done: 0 }),
    );
  });

  // Регрессия: до фикса `inProgress`/`done` в `sewingRoute` считали
  // ШТУКИ ПАСПОРТОВ (`+= 1`), а не сумму `qtyCut`. На дисплее это
  // вводило оператора в заблуждение: один паспорт на 21 шт показывался
  // как «1», и цифра не сходилась ни с матрицей, ни с физическим
  // количеством на полу. Должна быть Σ qtyCut по паспортам.
  test('sewingRoute: считает Σ qtyCut (штуки), а не количество паспортов', async () => {
    const today = new Date();
    const tpl = await t.prisma.routeTemplate.create({
      data: {
        code: 'TPL-DSP-PIECES',
        name: 'Маршрут — штуки vs паспорта',
        steps: {
          create: [
            { index: 0, operationId: seed.operations.SEW_OVERLOCK_1.id },
            { index: 1, operationId: seed.operations.QC.id },
            { index: 2, operationId: seed.operations.SEW_OVERLOCK_2.id },
          ],
        },
      },
    });
    const order = await t.prisma.order.create({
      data: {
        number: 'O-DSP-PIECES',
        orderDate: today,
        color: 'Чёрный',
        status: 'IN_PRODUCTION',
        routeTemplateId: tpl.id,
        items: {
          create: [
            { productId: seed.product.id, sizeId: seed.sizes.M, qtyPlan: 30 },
            { productId: seed.product.id, sizeId: seed.sizes.L, qtyPlan: 30 },
          ],
        },
        routeSteps: {
          create: [
            { index: 0, operationId: seed.operations.SEW_OVERLOCK_1.id },
            { index: 1, operationId: seed.operations.QC.id },
            { index: 2, operationId: seed.operations.SEW_OVERLOCK_2.id },
          ],
        },
      },
    });
    // Швея на Оверлоке 1 — будет источник ▶ для P-PCS-M-A.
    await t.prisma.shiftSession.create({
      data: {
        employeeId: seed.employees.seamstress.id,
        equipmentId: seed.equipment['overlock-01'].id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
        startedAt: today,
      },
    });
    const mkP = async (
      n: string,
      sizeId: string,
      qtyCut: number,
      idx: number,
      employeeId: string | null = null,
    ): Promise<void> => {
      await t.prisma.passport.create({
        data: {
          number: n,
          qrCode: `passport:${n}`,
          orderId: order.id,
          productId: seed.product.id,
          sizeId,
          color: 'Чёрный',
          rollNumber: `R-${n}`,
          cutDate: today,
          qtyPlan: qtyCut,
          qtyCut,
          qtyGood: qtyCut,
          cutterId: seed.employees.cutter.id,
          creatorId: seed.employees.cutter.id,
          status: 'IN_PROGRESS',
          currentRouteStepIndex: idx,
          currentEmployeeId: employeeId,
        },
      });
    };
    // Размер M:
    //   - 1 паспорт qtyCut=12 у швеи на Оверлоке 1 → inProgress=12 (НЕ 1).
    await mkP('P-PCS-M-A', seed.sizes.M, 12, 0, seed.employees.seamstress.id);
    // Размер L:
    //   - 2 паспорта qtyCut=5 + qtyCut=8 на step=0 без исполнителя →
    //     ✔ = 5 + 8 = 13 (буфер у Оверлока 1, ждут передачи дальше).
    await mkP('P-PCS-L-B', seed.sizes.L, 5, 0);
    await mkP('P-PCS-L-C', seed.sizes.L, 8, 0);

    const cookie = loginAs(t, seed.employees['shop-chief']);
    const res = await request(t.app.getHttpServer())
      .get('/api/shopfloor/display')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);

    const body = res.body as {
      sewingRoute: Array<{
        operationName: string;
        rows: Array<{ size: string; inProgress: number; done: number }>;
      }>;
    };
    const op1 = body.sewingRoute.find((b) => b.operationName === 'Оверлок 1')!;
    expect(op1).toBeDefined();
    const op1M = op1.rows.find((r) => r.size === 'M')!;
    const op1L = op1.rows.find((r) => r.size === 'L')!;
    // M: один паспорт на 12 шт под швеёй → inProgress=12, done=0.
    expect(op1M.inProgress).toBe(12);
    expect(op1M.done).toBe(0);
    // L: два паспорта на step=0 без исполнителя → ✔ = 5 + 8 = 13
    // (сумма qtyCut, а не +1 за паспорт), ▶=0.
    expect(op1L.inProgress).toBe(0);
    expect(op1L.done).toBe(13);
  });

  test('sewingRoute: пуст, если ни у одного активного заказа нет snapshot маршрута', async () => {
    const today = new Date();
    const order = await t.prisma.order.create({
      data: {
        number: 'O-DSP-NORT',
        orderDate: today,
        color: 'Чёрный',
        status: 'IN_PRODUCTION',
        items: {
          create: [
            { productId: seed.product.id, sizeId: seed.sizes.S, qtyPlan: 5 },
          ],
        },
      },
    });
    await t.prisma.passport.create({
      data: {
        number: 'P-NORT',
        qrCode: 'passport:nort',
        orderId: order.id,
        productId: seed.product.id,
        sizeId: seed.sizes.S,
        color: 'Чёрный',
        rollNumber: 'R-NORT',
        cutDate: today,
        qtyPlan: 5,
        qtyCut: 5,
        qtyGood: 5,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
        status: 'IN_PROGRESS',
        currentOperationId: seed.operations.SEW_OVERLOCK_1.id,
      },
    });

    const cookie = loginAs(t, seed.employees['shop-chief']);
    const res = await request(t.app.getHttpServer())
      .get('/api/shopfloor/display')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.sewingRoute).toEqual([]);
  });

  // Регрессия: до фикса split-таблица ▶/✔ опиралась только на
  // `Passport.currentRouteStepIndex`, а матричная sewing-колонка
  // — ещё и на «фактическую sewing-операцию» паспорта (через
  // `assignedShiftSewingOperationId` для свежевыданного, но ещё
  // не отсканированного крой-паспорта). Из-за этого на дисплее
  // KPI/матрица показывали «Оверлок 12 в работе», а split-таблица
  // ▶/✔ — пусто. После фикса оба источника читают одну и ту же
  // фактическую sewing-операцию, и цифры сходятся.
  test('sewingRoute: ▶ inProgress совпадает с матричной sewing-колонкой для issued-but-not-scanned', async () => {
    const today = new Date();
    const tpl = await t.prisma.routeTemplate.create({
      data: {
        code: 'TPL-DSP-ISSUED',
        name: 'Маршрут — issued-but-not-scanned',
        steps: {
          create: [
            { index: 0, operationId: seed.operations.CUT_DIVISION.id },
            { index: 1, operationId: seed.operations.SEW_OVERLOCK_1.id },
            { index: 2, operationId: seed.operations.QC.id },
          ],
        },
      },
    });
    const order = await t.prisma.order.create({
      data: {
        number: 'O-DSP-ISSUED',
        orderDate: today,
        color: 'Чёрный',
        status: 'IN_PRODUCTION',
        routeTemplateId: tpl.id,
        items: {
          create: [
            { productId: seed.product.id, sizeId: seed.sizes.M, qtyPlan: 12 },
          ],
        },
        routeSteps: {
          create: [
            { index: 0, operationId: seed.operations.CUT_DIVISION.id },
            { index: 1, operationId: seed.operations.SEW_OVERLOCK_1.id },
            { index: 2, operationId: seed.operations.QC.id },
          ],
        },
      },
    });
    // Швея открыла смену на Оверлоке 1 и приняла крой
    // (`issueToEmployee`): `currentEmployeeId` уже её, но
    // `currentOperationId` — всё ещё CUT_DIVISION (CUTTING),
    // и `currentRouteStepIndex` ещё стоит на 0 (CUT_DIVISION),
    // потому что отдельного `OPERATION_SCAN` на оверлок не было.
    // Матрица всё равно кладёт паспорт в колонку «Оверлок 1»
    // через `assignedShiftSewingOperationId`; sewingRoute
    // обязан показать то же самое в ▶ Оверлок 1.
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
        number: 'P-ISSUED-M',
        qrCode: 'passport:issued-m',
        orderId: order.id,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: 'Чёрный',
        rollNumber: 'R-ISSUED-M',
        cutDate: today,
        qtyPlan: 12,
        qtyCut: 12,
        qtyGood: 12,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
        status: 'IN_PROGRESS',
        currentOperationId: seed.operations.CUT_DIVISION.id,
        currentEmployeeId: seed.employees.seamstress.id,
        currentRouteStepIndex: 0,
      },
    });

    const cookie = loginAs(t, seed.employees['shop-chief']);
    const res = await request(t.app.getHttpServer())
      .get('/api/shopfloor/display')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);

    const body = res.body as {
      sewingColumns: Array<{ key: string; label: string }>;
      totals: { sewingByOp: Record<string, number> };
      sewingRoute: Array<{
        operationId: string;
        operationName: string;
        rows: Array<{ size: string; inProgress: number; done: number }>;
      }>;
    };
    // Sanity: матрица действительно показывает 12 шт на Оверлоке 1.
    const overlockColKey = seed.operations.SEW_OVERLOCK_1.id;
    expect(body.totals.sewingByOp[overlockColKey]).toBe(12);

    // sewingRoute должен содержать Оверлок 1 с inProgress=12 на M.
    const op1 = body.sewingRoute.find(
      (b) => b.operationId === seed.operations.SEW_OVERLOCK_1.id,
    );
    expect(op1).toBeDefined();
    const op1M = op1!.rows.find((r) => r.size === 'M');
    expect(op1M).toBeDefined();
    expect(op1M!.inProgress).toBe(12);
    expect(op1M!.done).toBe(0);
  });

  // Регрессия: после `completeOperationByEmployee` паспорт остаётся
  // `IN_PROGRESS` с прежним `currentOperationId`, но `currentEmployeeId
  // = null`. По новой WIP-buffer семантике этот паспорт показывается
  // в ✔ ТЕКУЩЕЙ операции (= step.index = idx), а не как фантомный ▶
  // или как ✔ старого, исторически пройденного шага.
  test('sewingRoute: completed-by-employee (currentEmployeeId=null) попадает в ✔ текущей операции, не ▶ и не на старый step', async () => {
    const today = new Date();
    const tpl = await t.prisma.routeTemplate.create({
      data: {
        code: 'TPL-DSP-COMPLETED',
        name: 'Маршрут — completed-by-employee',
        steps: {
          create: [
            { index: 0, operationId: seed.operations.SEW_OVERLOCK_1.id },
            { index: 1, operationId: seed.operations.SEW_OVERLOCK_2.id },
          ],
        },
      },
    });
    const order = await t.prisma.order.create({
      data: {
        number: 'O-DSP-COMPLETED',
        orderDate: today,
        color: 'Чёрный',
        status: 'IN_PRODUCTION',
        routeTemplateId: tpl.id,
        items: {
          create: [
            { productId: seed.product.id, sizeId: seed.sizes.S, qtyPlan: 7 },
          ],
        },
        routeSteps: {
          create: [
            { index: 0, operationId: seed.operations.SEW_OVERLOCK_1.id },
            { index: 1, operationId: seed.operations.SEW_OVERLOCK_2.id },
          ],
        },
      },
    });
    // Реальное состояние «Оверлок 1 завершил, Оверлок 2 ещё не взял»:
    // `completeOperationByEmployee` снял `currentEmployeeId`, но НЕ
    // двигает `currentRouteStepIndex` (его двигает только
    // `OPERATION_SCAN` следующего шага). Поэтому idx=0,
    // currentOperationId=Overlock1, employee=null.
    await t.prisma.passport.create({
      data: {
        number: 'P-DONE-OV1',
        qrCode: 'passport:done-ov1',
        orderId: order.id,
        productId: seed.product.id,
        sizeId: seed.sizes.S,
        color: 'Чёрный',
        rollNumber: 'R-DONE-OV1',
        cutDate: today,
        qtyPlan: 7,
        qtyCut: 7,
        qtyGood: 7,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
        status: 'IN_PROGRESS',
        currentOperationId: seed.operations.SEW_OVERLOCK_1.id,
        currentEmployeeId: null,
        currentRouteStepIndex: 0,
      },
    });

    const cookie = loginAs(t, seed.employees['shop-chief']);
    const res = await request(t.app.getHttpServer())
      .get('/api/shopfloor/display')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);

    const body = res.body as {
      sewingRoute: Array<{
        operationId: string;
        operationName: string;
        rows: Array<{ size: string; inProgress: number; done: number }>;
      }>;
    };
    const op1 = body.sewingRoute.find(
      (b) => b.operationId === seed.operations.SEW_OVERLOCK_1.id,
    );
    // Оверлок 1: ▶=0 (без исполнителя), ✔=7 (буфер «готово, ждёт
    // передачи следующему шагу»).
    expect(op1).toBeDefined();
    const op1S = op1!.rows.find((r) => r.size === 'S')!;
    expect(op1S.inProgress).toBe(0);
    expect(op1S.done).toBe(7);
    // Оверлок 2: появляется в sewingRoute как 0/0 — операция есть
    // в snapshot маршрута активного заказа, поэтому она ВИДНА на
    // матрице, чтобы bottleneck-эвристка могла подсветить её как
    // «следующая после ✔=7 на Оверлоке 1». Активный размер заказа
    // — S (один паспорт), поэтому ровно одна строка.
    const op2 = body.sewingRoute.find(
      (b) => b.operationId === seed.operations.SEW_OVERLOCK_2.id,
    );
    expect(op2).toBeDefined();
    const op2S = op2!.rows.find((r) => r.size === 'S')!;
    expect(op2S.inProgress).toBe(0);
    expect(op2S.done).toBe(0);
  });

  // ---------------------------------------------------------------------
  // Новая семантика split-таблицы (ТЗ §2 «WIP-buffer»):
  //   ▶ = сейчас физически в работе,
  //   ✔ = завершено и ожидает передачи следующему step'у.
  // Кейсы A–F покрывают переход паспорта по маршруту и проверяют, что
  // `done` БОЛЬШЕ НЕ накапливается на исторически пройденных шагах.
  // ---------------------------------------------------------------------

  // Маршрут для всех кейсов: CUT_DIVISION → Оверлок 1 → Оверлок 2 → QC.
  // (Seed содержит две sewing-операции; концептуально — это «оверлок →
  // следующая sewing → ОТК», как в примере ТЗ Overlock → Binding → QC.)
  const setupRoutedOrder = async (
    label: string,
    qtyCut: number,
  ): Promise<{ orderId: string; operations: typeof seed.operations }> => {
    const today = new Date();
    const tpl = await t.prisma.routeTemplate.create({
      data: {
        code: `TPL-WIP-${label}`,
        name: `Маршрут WIP ${label}`,
        steps: {
          create: [
            { index: 0, operationId: seed.operations.CUT_DIVISION.id },
            { index: 1, operationId: seed.operations.SEW_OVERLOCK_1.id },
            { index: 2, operationId: seed.operations.SEW_OVERLOCK_2.id },
            { index: 3, operationId: seed.operations.QC.id },
          ],
        },
      },
    });
    const order = await t.prisma.order.create({
      data: {
        number: `O-WIP-${label}`,
        orderDate: today,
        color: 'Чёрный',
        status: 'IN_PRODUCTION',
        routeTemplateId: tpl.id,
        items: {
          create: [
            { productId: seed.product.id, sizeId: seed.sizes.M, qtyPlan: qtyCut },
          ],
        },
        routeSteps: {
          create: [
            { index: 0, operationId: seed.operations.CUT_DIVISION.id },
            { index: 1, operationId: seed.operations.SEW_OVERLOCK_1.id },
            { index: 2, operationId: seed.operations.SEW_OVERLOCK_2.id },
            { index: 3, operationId: seed.operations.QC.id },
          ],
        },
      },
    });
    return { orderId: order.id, operations: seed.operations };
  };

  test('sewingRoute WIP-кейс A: завершено на Оверлоке 1, следующий step ещё не взял → ✔=12 на Оверлоке 1, Оверлок 2 виден как 0/0', async () => {
    const today = new Date();
    const { orderId } = await setupRoutedOrder('A', 12);
    // Оверлок 1 закончил: employee=null, idx=1 (= Оверлок 1 в маршруте).
    // currentOperationId всё ещё SEW_OVERLOCK_1 (completeOperationByEmployee
    // его не очищает) — но resolved=null, потому что employee=null.
    await t.prisma.passport.create({
      data: {
        number: 'P-WIP-A-M',
        qrCode: 'passport:wip-a-m',
        orderId,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: 'Чёрный',
        rollNumber: 'R-WIP-A',
        cutDate: today,
        qtyPlan: 12,
        qtyCut: 12,
        qtyGood: 12,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
        status: 'IN_PROGRESS',
        currentOperationId: seed.operations.SEW_OVERLOCK_1.id,
        currentEmployeeId: null,
        currentRouteStepIndex: 1,
      },
    });

    const cookie = loginAs(t, seed.employees['shop-chief']);
    const res = await request(t.app.getHttpServer())
      .get('/api/shopfloor/display')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    const body = res.body as {
      sewingRoute: Array<{
        operationId: string;
        rows: Array<{ size: string; inProgress: number; done: number }>;
      }>;
    };
    const op1 = body.sewingRoute.find(
      (b) => b.operationId === seed.operations.SEW_OVERLOCK_1.id,
    )!;
    expect(op1).toBeDefined();
    expect(op1.rows.find((r) => r.size === 'M')).toEqual(
      expect.objectContaining({ inProgress: 0, done: 12 }),
    );
    // Оверлок 2: его никто не взял, но операция ВИДНА в маршруте
    // активного заказа — блок есть с rows=0/0 (нужно для bottleneck-
    // подсветки следующей пустой операции).
    const op2 = body.sewingRoute.find(
      (b) => b.operationId === seed.operations.SEW_OVERLOCK_2.id,
    )!;
    expect(op2).toBeDefined();
    expect(op2.rows.find((r) => r.size === 'M')).toEqual(
      expect.objectContaining({ inProgress: 0, done: 0 }),
    );
  });

  test('sewingRoute WIP-кейс B: следующий step взял паспорт → старая ✔ очищается, ▶ переезжает на следующий step', async () => {
    const today = new Date();
    const { orderId } = await setupRoutedOrder('B', 12);
    // Создаём вторую швею и её смену на Оверлоке 2 — она «принимает»
    // паспорт, который только что завершил Оверлок 1.
    const seamstress2 = await t.prisma.employee.create({
      data: {
        login: 'seamstress-2',
        fullName: 'Test Seamstress 2',
        role: 'SEAMSTRESS',
        active: true,
        pinHash: '$2a$04$abcdefghijklmnopqrstuv',
      },
    });
    // Equipment не важен для sewingRoute (resolver смотрит только на
    // operationId смены) — переиспользуем overlock-01.
    await t.prisma.shiftSession.create({
      data: {
        employeeId: seamstress2.id,
        equipmentId: seed.equipment['overlock-01'].id,
        operationId: seed.operations.SEW_OVERLOCK_2.id,
        startedAt: today,
      },
    });
    // После Binder OPERATION_SCAN'а: idx двинулся на 2 (= Оверлок 2),
    // currentOperationId = Оверлок 2, currentEmployeeId = вторая швея.
    await t.prisma.passport.create({
      data: {
        number: 'P-WIP-B-M',
        qrCode: 'passport:wip-b-m',
        orderId,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: 'Чёрный',
        rollNumber: 'R-WIP-B',
        cutDate: today,
        qtyPlan: 12,
        qtyCut: 12,
        qtyGood: 12,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
        status: 'IN_PROGRESS',
        currentOperationId: seed.operations.SEW_OVERLOCK_2.id,
        currentEmployeeId: seamstress2.id,
        currentRouteStepIndex: 2,
      },
    });

    const cookie = loginAs(t, seed.employees['shop-chief']);
    const res = await request(t.app.getHttpServer())
      .get('/api/shopfloor/display')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    const body = res.body as {
      sewingRoute: Array<{
        operationId: string;
        rows: Array<{ size: string; inProgress: number; done: number }>;
      }>;
    };
    // Оверлок 1: ✔ очистилась после ухода паспорта (старая «исторически
    // пройденного шага» логика мертва), но сам блок ВИДЕН — операция
    // есть в snapshot маршрута активного заказа.
    const op1 = body.sewingRoute.find(
      (b) => b.operationId === seed.operations.SEW_OVERLOCK_1.id,
    )!;
    expect(op1).toBeDefined();
    expect(op1.rows.find((r) => r.size === 'M')).toEqual(
      expect.objectContaining({ inProgress: 0, done: 0 }),
    );
    // Оверлок 2: ▶=12.
    const op2 = body.sewingRoute.find(
      (b) => b.operationId === seed.operations.SEW_OVERLOCK_2.id,
    )!;
    expect(op2).toBeDefined();
    expect(op2.rows.find((r) => r.size === 'M')).toEqual(
      expect.objectContaining({ inProgress: 12, done: 0 }),
    );
  });

  test('sewingRoute WIP-кейс C: следующий step завершил → его ✔=12, у предыдущего пусто', async () => {
    const today = new Date();
    const { orderId } = await setupRoutedOrder('C', 12);
    // Оверлок 2 завершил: employee=null, idx=2 (= Оверлок 2),
    // currentOperationId = Оверлок 2 (не очищается).
    await t.prisma.passport.create({
      data: {
        number: 'P-WIP-C-M',
        qrCode: 'passport:wip-c-m',
        orderId,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: 'Чёрный',
        rollNumber: 'R-WIP-C',
        cutDate: today,
        qtyPlan: 12,
        qtyCut: 12,
        qtyGood: 12,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
        status: 'IN_PROGRESS',
        currentOperationId: seed.operations.SEW_OVERLOCK_2.id,
        currentEmployeeId: null,
        currentRouteStepIndex: 2,
      },
    });

    const cookie = loginAs(t, seed.employees['shop-chief']);
    const res = await request(t.app.getHttpServer())
      .get('/api/shopfloor/display')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    const body = res.body as {
      sewingRoute: Array<{
        operationId: string;
        rows: Array<{ size: string; inProgress: number; done: number }>;
      }>;
    };
    // Оверлок 1: блок ВИДЕН (есть в маршруте), но без работы → 0/0.
    const op1 = body.sewingRoute.find(
      (b) => b.operationId === seed.operations.SEW_OVERLOCK_1.id,
    )!;
    expect(op1).toBeDefined();
    expect(op1.rows.find((r) => r.size === 'M')).toEqual(
      expect.objectContaining({ inProgress: 0, done: 0 }),
    );
    const op2 = body.sewingRoute.find(
      (b) => b.operationId === seed.operations.SEW_OVERLOCK_2.id,
    )!;
    expect(op2).toBeDefined();
    expect(op2.rows.find((r) => r.size === 'M')).toEqual(
      expect.objectContaining({ inProgress: 0, done: 12 }),
    );
  });

  test('sewingRoute WIP-кейс D: паспорт ушёл в QC → обе sewing-операции остаются видимы (rows=0/0)', async () => {
    const today = new Date();
    const { orderId } = await setupRoutedOrder('D', 12);
    // OPERATION_SCAN на QC двинул idx до 3 и поставил currentOperationId
    // = QC. ОТК-сотрудник держит паспорт.
    await t.prisma.passport.create({
      data: {
        number: 'P-WIP-D-M',
        qrCode: 'passport:wip-d-m',
        orderId,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: 'Чёрный',
        rollNumber: 'R-WIP-D',
        cutDate: today,
        qtyPlan: 12,
        qtyCut: 12,
        qtyGood: 12,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
        status: 'IN_PROGRESS',
        currentOperationId: seed.operations.QC.id,
        currentEmployeeId: seed.employees.qc.id,
        currentRouteStepIndex: 3,
      },
    });

    const cookie = loginAs(t, seed.employees['shop-chief']);
    const res = await request(t.app.getHttpServer())
      .get('/api/shopfloor/display')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    const body = res.body as {
      sewingRoute: Array<{
        operationId: string;
        rows: Array<{ size: string; inProgress: number; done: number }>;
      }>;
    };
    // Никаких исторических ✔ на Оверлоках быть не должно (паспорт
    // ушёл за sewing-маршрут), но обе sewing-операции маршрута
    // остаются ВИДИМЫМИ как 0/0 — иначе bottleneck-эвристка не
    // сможет показать «следующая операция пустая, а предыдущая
    // встала». Контракт «весь маршрут активных заказов».
    const ops = body.sewingRoute.map((b) => b.operationId).sort();
    expect(ops).toEqual(
      [seed.operations.SEW_OVERLOCK_1.id, seed.operations.SEW_OVERLOCK_2.id].sort(),
    );
    for (const block of body.sewingRoute) {
      const row = block.rows.find((r) => r.size === 'M')!;
      expect(row.inProgress).toBe(0);
      expect(row.done).toBe(0);
    }
  });

  test('sewingRoute WIP-кейс E: route-WIP до scan (issueToEmployee, currentOp ещё CUT_DIVISION) → ▶ на смене швеи, никаких ✔ на старом step', async () => {
    const today = new Date();
    const { orderId } = await setupRoutedOrder('E', 12);
    // Швея открыла смену на Оверлоке 1, нажала «Принять крой» —
    // currentEmployeeId её, но currentOperationId всё ещё CUT_DIVISION
    // (нет OPERATION_SCAN на оверлок), idx стоит на 0 (CUT_DIVISION).
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
        number: 'P-WIP-E-M',
        qrCode: 'passport:wip-e-m',
        orderId,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: 'Чёрный',
        rollNumber: 'R-WIP-E',
        cutDate: today,
        qtyPlan: 12,
        qtyCut: 12,
        qtyGood: 12,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
        status: 'IN_PROGRESS',
        currentOperationId: seed.operations.CUT_DIVISION.id,
        currentEmployeeId: seed.employees.seamstress.id,
        currentRouteStepIndex: 0,
      },
    });

    const cookie = loginAs(t, seed.employees['shop-chief']);
    const res = await request(t.app.getHttpServer())
      .get('/api/shopfloor/display')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    const body = res.body as {
      sewingRoute: Array<{
        operationId: string;
        rows: Array<{ size: string; inProgress: number; done: number }>;
      }>;
    };
    const op1 = body.sewingRoute.find(
      (b) => b.operationId === seed.operations.SEW_OVERLOCK_1.id,
    )!;
    expect(op1).toBeDefined();
    expect(op1.rows.find((r) => r.size === 'M')).toEqual(
      expect.objectContaining({ inProgress: 12, done: 0 }),
    );
    // CUT_DIVISION не sewing-категория, но даже если бы был — ✔ на нём
    // не должен быть, т.к. resolved=Оверлок 1 (▶) перебивает.
    // Оверлок 2 ВИДЕН в маршруте активного заказа, но без работы → 0/0.
    const op2 = body.sewingRoute.find(
      (b) => b.operationId === seed.operations.SEW_OVERLOCK_2.id,
    )!;
    expect(op2).toBeDefined();
    expect(op2.rows.find((r) => r.size === 'M')).toEqual(
      expect.objectContaining({ inProgress: 0, done: 0 }),
    );
  });

  test('sewingRoute WIP-кейс F: один паспорт не учитывается дважды — ровно один step и ровно один бакет', async () => {
    const today = new Date();
    const { orderId } = await setupRoutedOrder('F', 12);
    // Реалистичное состояние «Оверлок 1 завершил, Оверлок 2 не взял»:
    // employee=null, idx=1, currentOperationId=Overlock1.
    await t.prisma.passport.create({
      data: {
        number: 'P-WIP-F-M',
        qrCode: 'passport:wip-f-m',
        orderId,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: 'Чёрный',
        rollNumber: 'R-WIP-F',
        cutDate: today,
        qtyPlan: 12,
        qtyCut: 12,
        qtyGood: 12,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
        status: 'IN_PROGRESS',
        currentOperationId: seed.operations.SEW_OVERLOCK_1.id,
        currentEmployeeId: null,
        currentRouteStepIndex: 1,
      },
    });

    const cookie = loginAs(t, seed.employees['shop-chief']);
    const res = await request(t.app.getHttpServer())
      .get('/api/shopfloor/display')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    const body = res.body as {
      sewingRoute: Array<{
        operationId: string;
        rows: Array<{ size: string; inProgress: number; done: number }>;
      }>;
    };
    // Σ всех ▶ + ✔ по всем sewing-операциям должно быть равно qtyCut
    // (12), а не 24 (= и ▶, и ✔ на одном паспорте) и не 36 (= и
    // ▶/✔, и старая операция «исторический ✔»).
    let totalQty = 0;
    let totalCells = 0;
    for (const block of body.sewingRoute) {
      for (const row of block.rows) {
        totalQty += row.inProgress + row.done;
        if (row.inProgress > 0) totalCells += 1;
        if (row.done > 0) totalCells += 1;
      }
    }
    expect(totalQty).toBe(12);
    // Ровно одна непустая ячейка — буфер ✔ на Оверлоке 1.
    expect(totalCells).toBe(1);
  });

  // ---------------------------------------------------------------------
  // Полный маршрут активных заказов виден на дисплее (контракт
  // «весь маршрут», включая операции с 0/0). Эти кейсы доказывают:
  //
  //   A. sewingRoute показывает СЛЕДУЮЩУЮ пустую операцию маршрута
  //      (нужно для bottleneck-подсветки);
  //   C. операция, которой нет ни в одном snapshot маршрута активных
  //      заказов, не появляется (защита от «фантомных» операций);
  //   D. одна и та же операция, упомянутая в маршрутах нескольких
  //      активных заказов, даёт ровно ОДИН блок (rows — union
  //      размеров, ▶/✔ — Σ по всем заказам).
  //
  // Кейс «B. bottleneck может подсветить пустую следующую операцию»
  // живёт во frontend smoke (`tests/smoke/shopfloor-display.smoke.test.ts`)
  // — детекция bottleneck'а чисто визуальная и не требует БД.
  // ---------------------------------------------------------------------

  test('sewingRoute [полный маршрут A]: следующая пустая sewing-операция остаётся видна (rows=0/0)', async () => {
    // Сценарий из ТЗ: маршрут CUT_DIVISION → SEW_OVERLOCK_1 → SEW_OVERLOCK_2 → QC,
    // активный заказ, размер M, qtyCut=12. Паспорт завершил
    // SEW_OVERLOCK_1 (employee=null, idx=1, status=IN_PROGRESS).
    // Ожидание: sewingRoute содержит SEW_OVERLOCK_1 с done=12 И
    // SEW_OVERLOCK_2 с inProgress=0/done=0 — на ней ещё никто не
    // работает, но операция должна быть видна, чтобы UI мог её
    // подсветить как bottleneck («следующая после ✔=12»).
    const today = new Date();
    const tpl = await t.prisma.routeTemplate.create({
      data: {
        code: 'TPL-DSP-FULL-A',
        name: 'Маршрут — следующая пустая операция',
        steps: {
          create: [
            { index: 0, operationId: seed.operations.CUT_DIVISION.id },
            { index: 1, operationId: seed.operations.SEW_OVERLOCK_1.id },
            { index: 2, operationId: seed.operations.SEW_OVERLOCK_2.id },
            { index: 3, operationId: seed.operations.QC.id },
          ],
        },
      },
    });
    const order = await t.prisma.order.create({
      data: {
        number: 'O-DSP-FULL-A',
        orderDate: today,
        color: 'Чёрный',
        status: 'IN_PRODUCTION',
        routeTemplateId: tpl.id,
        items: {
          create: [
            { productId: seed.product.id, sizeId: seed.sizes.M, qtyPlan: 12 },
          ],
        },
        routeSteps: {
          create: [
            { index: 0, operationId: seed.operations.CUT_DIVISION.id },
            { index: 1, operationId: seed.operations.SEW_OVERLOCK_1.id },
            { index: 2, operationId: seed.operations.SEW_OVERLOCK_2.id },
            { index: 3, operationId: seed.operations.QC.id },
          ],
        },
      },
    });
    await t.prisma.passport.create({
      data: {
        number: 'P-DSP-FULL-A-M',
        qrCode: 'passport:dsp-full-a-m',
        orderId: order.id,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: 'Чёрный',
        rollNumber: 'R-DSP-FULL-A',
        cutDate: today,
        qtyPlan: 12,
        qtyCut: 12,
        qtyGood: 12,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
        status: 'IN_PROGRESS',
        currentOperationId: seed.operations.SEW_OVERLOCK_1.id,
        currentEmployeeId: null,
        currentRouteStepIndex: 1,
      },
    });

    const cookie = loginAs(t, seed.employees['shop-chief']);
    const res = await request(t.app.getHttpServer())
      .get('/api/shopfloor/display')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    const body = res.body as {
      sewingRoute: Array<{
        operationId: string;
        operationName: string;
        rows: Array<{ size: string; inProgress: number; done: number }>;
      }>;
    };

    // Обе sewing-операции маршрута видны. Порядок — по
    // Operation.sortOrder (стабильный для UI / TV).
    expect(body.sewingRoute.map((b) => b.operationId)).toEqual([
      seed.operations.SEW_OVERLOCK_1.id,
      seed.operations.SEW_OVERLOCK_2.id,
    ]);

    const op1 = body.sewingRoute[0]!;
    const op1M = op1.rows.find((r) => r.size === 'M')!;
    expect(op1M.inProgress).toBe(0);
    expect(op1M.done).toBe(12);

    // Ключ всего фикса: SEW_OVERLOCK_2 видна как 0/0, хотя по ней
    // нет ни одного паспорта. Без этой строки bottleneck-эвристка
    // на UI не смогла бы подсветить «следующую за ✔=12 пустую
    // операцию».
    const op2 = body.sewingRoute[1]!;
    const op2M = op2.rows.find((r) => r.size === 'M')!;
    expect(op2M.inProgress).toBe(0);
    expect(op2M.done).toBe(0);
  });

  test('sewingRoute [инвариант B]: активный заказ БЕЗ паспортов остаётся виден с rows из OrderItem.size', async () => {
    // Регресс «исчезающей операции»: cold start заказа.
    // Был активный заказ с маршрутом и `OrderItem` (M, L), но ещё
    // не было ни одного выпуска паспорта (или все паспорта
    // CANCELLED). Раньше:
    //   1) `routeStepsPromise` фильтровал orderId по живым
    //      паспортам — заказ не попадал в выборку, его операции
    //      исчезали из sewingRoute полностью;
    //   2) даже если бы попал — `sizesByOrder` для него пуст, и
    //      Pass 1b не создавал ячеек, операция шла без rows.
    //
    // После фикса: orderIds для routeSteps берутся из активных
    // `Order` напрямую, а в Pass 1b есть fallback на `OrderItem.
    // size`. Ожидание: операция SEW_OVERLOCK_1 видна с rows=
    // [{M,0,0}, {L,0,0}].
    const today = new Date();
    const tpl = await t.prisma.routeTemplate.create({
      data: {
        code: 'TPL-DSP-INV-B',
        name: 'Маршрут — заказ без паспортов',
        steps: {
          create: [
            { index: 0, operationId: seed.operations.SEW_OVERLOCK_1.id },
            { index: 1, operationId: seed.operations.QC.id },
          ],
        },
      },
    });
    await t.prisma.order.create({
      data: {
        number: 'O-DSP-INV-B',
        orderDate: today,
        color: 'Чёрный',
        status: 'IN_PRODUCTION',
        routeTemplateId: tpl.id,
        items: {
          create: [
            { productId: seed.product.id, sizeId: seed.sizes.M, qtyPlan: 7 },
            { productId: seed.product.id, sizeId: seed.sizes.L, qtyPlan: 9 },
          ],
        },
        routeSteps: {
          create: [
            { index: 0, operationId: seed.operations.SEW_OVERLOCK_1.id },
            { index: 1, operationId: seed.operations.QC.id },
          ],
        },
      },
    });

    const cookie = loginAs(t, seed.employees['shop-chief']);
    const res = await request(t.app.getHttpServer())
      .get('/api/shopfloor/display')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    const body = res.body as {
      sewingRoute: Array<{
        operationId: string;
        rows: Array<{ size: string; inProgress: number; done: number }>;
      }>;
    };

    const overlock = body.sewingRoute.find(
      (b) => b.operationId === seed.operations.SEW_OVERLOCK_1.id,
    );
    expect(overlock).toBeDefined();
    const sizes = overlock!.rows.map((r) => r.size).sort();
    expect(sizes).toEqual(['L', 'M']);
    for (const row of overlock!.rows) {
      expect(row.inProgress).toBe(0);
      expect(row.done).toBe(0);
    }
  });

  test('sewingRoute [инвариант C]: операция остаётся видна, даже если все паспорта PACKED (rows из OrderItem.size)', async () => {
    // Сценарий «паспорт ушёл дальше — операция исчезла».
    // Заказ активен, маршрут содержит SEW_OVERLOCK_1, единственный
    // паспорт уже PACKED. Раньше:
    //   - PACKED-паспорт исключался из `sizesByOrder`,
    //   - Pass 1b не создавал ячеек, блок шёл с rows=[],
    //   - и на UI визуально выглядел как «исчезшая операция».
    //
    // После фикса fallback на OrderItem.size срабатывает, и блок
    // показывает строку M c 0/0. Это и есть инвариант, который
    // нельзя ломать: операция активного маршрута ВСЕГДА видна.
    const today = new Date();
    const tpl = await t.prisma.routeTemplate.create({
      data: {
        code: 'TPL-DSP-INV-C',
        name: 'Маршрут — паспорт PACKED',
        steps: {
          create: [
            { index: 0, operationId: seed.operations.SEW_OVERLOCK_1.id },
            { index: 1, operationId: seed.operations.QC.id },
          ],
        },
      },
    });
    const order = await t.prisma.order.create({
      data: {
        number: 'O-DSP-INV-C',
        orderDate: today,
        color: 'Чёрный',
        status: 'IN_PRODUCTION',
        routeTemplateId: tpl.id,
        items: {
          create: [
            { productId: seed.product.id, sizeId: seed.sizes.M, qtyPlan: 12 },
          ],
        },
        routeSteps: {
          create: [
            { index: 0, operationId: seed.operations.SEW_OVERLOCK_1.id },
            { index: 1, operationId: seed.operations.QC.id },
          ],
        },
      },
    });
    await t.prisma.passport.create({
      data: {
        number: 'P-DSP-INV-C-M',
        qrCode: 'passport:dsp-inv-c-m',
        orderId: order.id,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: 'Чёрный',
        rollNumber: 'R-DSP-INV-C',
        cutDate: today,
        qtyPlan: 12,
        qtyCut: 12,
        qtyGood: 12,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
        status: 'PACKED',
      },
    });

    const cookie = loginAs(t, seed.employees['shop-chief']);
    const res = await request(t.app.getHttpServer())
      .get('/api/shopfloor/display')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    const body = res.body as {
      sewingRoute: Array<{
        operationId: string;
        rows: Array<{ size: string; inProgress: number; done: number }>;
      }>;
    };

    const overlock = body.sewingRoute.find(
      (b) => b.operationId === seed.operations.SEW_OVERLOCK_1.id,
    );
    expect(overlock).toBeDefined();
    const rowM = overlock!.rows.find((r) => r.size === 'M');
    expect(rowM).toBeDefined();
    expect(rowM!.inProgress).toBe(0);
    expect(rowM!.done).toBe(0);
  });

  test('sewingRoute [полный маршрут C]: операция без active route в дисплее не появляется', async () => {
    // SEW_BINDING (на роли «следующая sewing-операция») в seed нет —
    // тестируем на реально существующей SEW_OVERLOCK_2: создаём
    // активный заказ, у которого в маршруте только SEW_OVERLOCK_1
    // (без SEW_OVERLOCK_2). SEW_OVERLOCK_2 не должна появиться в
    // sewingRoute — её нет ни в одном snapshot маршрута.
    const today = new Date();
    const tpl = await t.prisma.routeTemplate.create({
      data: {
        code: 'TPL-DSP-FULL-C',
        name: 'Маршрут — без SEW_OVERLOCK_2',
        steps: {
          create: [
            { index: 0, operationId: seed.operations.SEW_OVERLOCK_1.id },
            { index: 1, operationId: seed.operations.QC.id },
          ],
        },
      },
    });
    const order = await t.prisma.order.create({
      data: {
        number: 'O-DSP-FULL-C',
        orderDate: today,
        color: 'Чёрный',
        status: 'IN_PRODUCTION',
        routeTemplateId: tpl.id,
        items: {
          create: [
            { productId: seed.product.id, sizeId: seed.sizes.S, qtyPlan: 5 },
          ],
        },
        routeSteps: {
          create: [
            { index: 0, operationId: seed.operations.SEW_OVERLOCK_1.id },
            { index: 1, operationId: seed.operations.QC.id },
          ],
        },
      },
    });
    await t.prisma.passport.create({
      data: {
        number: 'P-DSP-FULL-C-S',
        qrCode: 'passport:dsp-full-c-s',
        orderId: order.id,
        productId: seed.product.id,
        sizeId: seed.sizes.S,
        color: 'Чёрный',
        rollNumber: 'R-DSP-FULL-C',
        cutDate: today,
        qtyPlan: 5,
        qtyCut: 5,
        qtyGood: 5,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
        status: 'IN_PROGRESS',
        currentOperationId: seed.operations.SEW_OVERLOCK_1.id,
        currentRouteStepIndex: 0,
      },
    });

    const cookie = loginAs(t, seed.employees['shop-chief']);
    const res = await request(t.app.getHttpServer())
      .get('/api/shopfloor/display')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    const body = res.body as {
      sewingRoute: Array<{ operationId: string }>;
    };
    // Только SEW_OVERLOCK_1 — это единственная sewing-операция в
    // маршруте активного заказа. Никаких «фантомных» операций.
    expect(body.sewingRoute.map((b) => b.operationId)).toEqual([
      seed.operations.SEW_OVERLOCK_1.id,
    ]);
    expect(
      body.sewingRoute.find(
        (b) => b.operationId === seed.operations.SEW_OVERLOCK_2.id,
      ),
    ).toBeUndefined();
  });

  test('sewingRoute [полный маршрут D]: одна операция в маршрутах двух заказов = один блок, rows union', async () => {
    // Два активных заказа делят SEW_OVERLOCK_1: заказ A только M,
    // заказ B только L. Ожидание: ровно один блок SEW_OVERLOCK_1
    // с двумя строками M и L (union размеров двух заказов), ▶/✔
    // суммируются по всем заказам.
    const today = new Date();
    const tpl = await t.prisma.routeTemplate.create({
      data: {
        code: 'TPL-DSP-FULL-D',
        name: 'Маршрут — общий SEW_OVERLOCK_1',
        steps: {
          create: [
            { index: 0, operationId: seed.operations.SEW_OVERLOCK_1.id },
            { index: 1, operationId: seed.operations.QC.id },
          ],
        },
      },
    });
    const orderA = await t.prisma.order.create({
      data: {
        number: 'O-DSP-FULL-D-A',
        orderDate: today,
        color: 'Чёрный',
        status: 'IN_PRODUCTION',
        routeTemplateId: tpl.id,
        items: {
          create: [
            { productId: seed.product.id, sizeId: seed.sizes.M, qtyPlan: 6 },
          ],
        },
        routeSteps: {
          create: [
            { index: 0, operationId: seed.operations.SEW_OVERLOCK_1.id },
            { index: 1, operationId: seed.operations.QC.id },
          ],
        },
      },
    });
    const orderB = await t.prisma.order.create({
      data: {
        number: 'O-DSP-FULL-D-B',
        orderDate: today,
        color: 'Чёрный',
        status: 'IN_PRODUCTION',
        routeTemplateId: tpl.id,
        items: {
          create: [
            { productId: seed.product.id, sizeId: seed.sizes.L, qtyPlan: 9 },
          ],
        },
        routeSteps: {
          create: [
            { index: 0, operationId: seed.operations.SEW_OVERLOCK_1.id },
            { index: 1, operationId: seed.operations.QC.id },
          ],
        },
      },
    });
    // Заказ A — паспорт под швеёй на Оверлоке 1 (▶=6).
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
        number: 'P-DSP-FULL-D-A-M',
        qrCode: 'passport:dsp-full-d-a-m',
        orderId: orderA.id,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: 'Чёрный',
        rollNumber: 'R-DSP-FULL-D-A',
        cutDate: today,
        qtyPlan: 6,
        qtyCut: 6,
        qtyGood: 6,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
        status: 'IN_PROGRESS',
        currentOperationId: seed.operations.SEW_OVERLOCK_1.id,
        currentEmployeeId: seed.employees.seamstress.id,
        currentRouteStepIndex: 0,
      },
    });
    // Заказ B — паспорт завершил Оверлок 1, ✔=9.
    await t.prisma.passport.create({
      data: {
        number: 'P-DSP-FULL-D-B-L',
        qrCode: 'passport:dsp-full-d-b-l',
        orderId: orderB.id,
        productId: seed.product.id,
        sizeId: seed.sizes.L,
        color: 'Чёрный',
        rollNumber: 'R-DSP-FULL-D-B',
        cutDate: today,
        qtyPlan: 9,
        qtyCut: 9,
        qtyGood: 9,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
        status: 'IN_PROGRESS',
        currentOperationId: seed.operations.SEW_OVERLOCK_1.id,
        currentEmployeeId: null,
        currentRouteStepIndex: 0,
      },
    });

    const cookie = loginAs(t, seed.employees['shop-chief']);
    const res = await request(t.app.getHttpServer())
      .get('/api/shopfloor/display')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    const body = res.body as {
      sewingRoute: Array<{
        operationId: string;
        rows: Array<{ size: string; inProgress: number; done: number }>;
      }>;
    };
    // Ровно ОДИН блок SEW_OVERLOCK_1 — операция дедуплицируется по
    // operationId между заказами.
    const overlockBlocks = body.sewingRoute.filter(
      (b) => b.operationId === seed.operations.SEW_OVERLOCK_1.id,
    );
    expect(overlockBlocks).toHaveLength(1);
    const block = overlockBlocks[0]!;
    // Rows — union размеров обоих заказов: M (заказ A) + L (заказ B).
    const sizes = block.rows.map((r) => r.size).sort();
    expect(sizes).toEqual(['L', 'M']);
    // ▶/✔ — Σ по всем заказам, разнесена по своим размерам.
    const rowM = block.rows.find((r) => r.size === 'M')!;
    expect(rowM.inProgress).toBe(6);
    expect(rowM.done).toBe(0);
    const rowL = block.rows.find((r) => r.size === 'L')!;
    expect(rowL.inProgress).toBe(0);
    expect(rowL.done).toBe(9);
  });

  // ---------------------------------------------------------------------
  // ОТК / ВТО WIP-кейсы (унификация с sewing).
  //
  // ТЗ: ОТК и ВТО на дисплее показываются split-блоками `▶/✔` —
  // одна и та же визуальная пара колонок и одна и та же семантика
  // «работается / готово, ждёт следующего». Источник истины на бэке
  // не меняется (остаётся `qtyQc/qtyQcDone/qtyWto/qtyWtoDone`),
  // но эти кейсы фиксируют переход паспорта по маршруту
  //
  //     SEWING → ОТК → ВТО → УПАКОВКА
  //
  // и доказывают «исторических done нет»:
  //   - A. ОТК завершил, ВТО не взял   → QC ▶=0, QC ✔=qtyCut
  //   - B. ВТО взял                    → QC ▶=0, QC ✔=0, WTO ▶=qtyCut
  //   - C. ВТО завершил                → WTO ▶=0, WTO ✔=qtyCut
  //   - D. Упаковка взяла              → WTO ▶=0, WTO ✔=0, qtyPacking=qtyCut
  //   - E. SHOPFLOOR_DISPLAY_MATRIX_STAGES не содержит QC/QC_DONE/
  //        WTO/WTO_DONE (контракт «нет отдельных колонок „Проверено
  //        ОТК“»; см. также соответствующий smoke-тест).
  //
  // На бэкенде «✔ на ОТК» = `hasFreshQcPassed` (PassportEvent QC_PASSED
  // новее последнего OPERATION_SCAN), для ВТО аналогично через
  // `hasFreshWtoPassed`. См. блок-комментарий у `bucketOf` в
  // `shopfloor-projection.ts`.
  // ---------------------------------------------------------------------
  const setupQcWtoOrder = async (
    label: string,
    qtyCut: number,
  ): Promise<{ orderId: string }> => {
    const today = new Date();
    const tpl = await t.prisma.routeTemplate.create({
      data: {
        code: `TPL-PROC-${label}`,
        name: `Маршрут ОТК/ВТО ${label}`,
        steps: {
          create: [
            { index: 0, operationId: seed.operations.CUT_DIVISION.id },
            { index: 1, operationId: seed.operations.SEW_OVERLOCK_1.id },
            { index: 2, operationId: seed.operations.QC.id },
            { index: 3, operationId: seed.operations.IRONING.id },
            { index: 4, operationId: seed.operations.PACKING.id },
          ],
        },
      },
    });
    const order = await t.prisma.order.create({
      data: {
        number: `O-PROC-${label}`,
        orderDate: today,
        color: 'Чёрный',
        status: 'IN_PRODUCTION',
        routeTemplateId: tpl.id,
        items: {
          create: [
            { productId: seed.product.id, sizeId: seed.sizes.M, qtyPlan: qtyCut },
          ],
        },
        routeSteps: {
          create: [
            { index: 0, operationId: seed.operations.CUT_DIVISION.id },
            { index: 1, operationId: seed.operations.SEW_OVERLOCK_1.id },
            { index: 2, operationId: seed.operations.QC.id },
            { index: 3, operationId: seed.operations.IRONING.id },
            { index: 4, operationId: seed.operations.PACKING.id },
          ],
        },
      },
    });
    return { orderId: order.id };
  };

  test('QC/WTO WIP-кейс A: ОТК завершил, ВТО не взял → QC ▶=0, QC ✔=qtyCut', async () => {
    const today = new Date();
    const { orderId } = await setupQcWtoOrder('A', 12);
    // Паспорт на ОТК, нажали «Проверка выполнена»: PassportEvent
    // QC_PASSED записан, но `Passport.currentOperationId` остаётся QC
    // (см. `qc.service.ts: completeQc`). Т.к. позже не было
    // OPERATION_SCAN, `hasFreshQcPassed = true`. По проекции это
    // именно «✔ на ОТК».
    const passport = await t.prisma.passport.create({
      data: {
        number: 'P-PROC-A-M',
        qrCode: 'passport:proc-a-m',
        orderId,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: 'Чёрный',
        rollNumber: 'R-PROC-A',
        cutDate: today,
        qtyPlan: 12,
        qtyCut: 12,
        qtyGood: 12,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
        status: 'IN_PROGRESS',
        currentOperationId: seed.operations.QC.id,
        currentEmployeeId: seed.employees.qc.id,
        currentRouteStepIndex: 2,
      },
    });
    await t.prisma.passportEvent.create({
      data: {
        passportId: passport.id,
        type: 'QC_PASSED',
        employeeId: seed.employees.qc.id,
        qty: 12,
        createdAt: new Date(today.getTime() + 1000),
      },
    });

    const cookie = loginAs(t, seed.employees['shop-chief']);
    const res = await request(t.app.getHttpServer())
      .get('/api/shopfloor/display')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    const body = res.body as {
      totals: { qtyQc: number; qtyQcDone: number; qtyWto: number; qtyWtoDone: number };
      colors: Array<{ totals: { qtyQc: number; qtyQcDone: number } }>;
    };
    expect(body.totals.qtyQc).toBe(0);
    expect(body.totals.qtyQcDone).toBe(12);
    expect(body.totals.qtyWto).toBe(0);
    expect(body.totals.qtyWtoDone).toBe(0);
    // Цветовой блок тоже: «✔ на ОТК» в total'е ровно для этого цвета.
    expect(body.colors[0]?.totals.qtyQcDone).toBe(12);
    expect(body.colors[0]?.totals.qtyQc).toBe(0);
  });

  test('QC/WTO WIP-кейс B: ВТО взял → QC ✔ очищается, WTO ▶=qtyCut', async () => {
    const today = new Date();
    const { orderId } = await setupQcWtoOrder('B', 12);
    // ВТО-сотрудник открыл смену и сделал OPERATION_SCAN на IRONING:
    // currentOperationId = IRONING, currentEmployeeId = ironing,
    // idx=3. Поскольку OPERATION_SCAN произошёл ПОСЛЕ QC_PASSED,
    // `hasFreshQcPassed=false`. Категория currentOperation = IRONING
    // → bucket=WTO, qtyWto=qtyCut.
    await t.prisma.shiftSession.create({
      data: {
        employeeId: seed.employees.ironing.id,
        equipmentId: seed.equipment['ironing-station-01'].id,
        operationId: seed.operations.IRONING.id,
        startedAt: today,
      },
    });
    const passport = await t.prisma.passport.create({
      data: {
        number: 'P-PROC-B-M',
        qrCode: 'passport:proc-b-m',
        orderId,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: 'Чёрный',
        rollNumber: 'R-PROC-B',
        cutDate: today,
        qtyPlan: 12,
        qtyCut: 12,
        qtyGood: 12,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
        status: 'IN_PROGRESS',
        currentOperationId: seed.operations.IRONING.id,
        currentEmployeeId: seed.employees.ironing.id,
        currentRouteStepIndex: 3,
      },
    });
    // QC_PASSED был исторически (на предыдущем шаге), но позже OPERATION_SCAN
    // на IRONING обнулил «свежесть» — значит на ОТК не должно остаться ни ▶, ни ✔.
    await t.prisma.passportEvent.create({
      data: {
        passportId: passport.id,
        type: 'QC_PASSED',
        employeeId: seed.employees.qc.id,
        qty: 12,
        createdAt: new Date(today.getTime() + 1000),
      },
    });
    await t.prisma.passportEvent.create({
      data: {
        passportId: passport.id,
        type: 'OPERATION_SCAN',
        employeeId: seed.employees.ironing.id,
        operationId: seed.operations.IRONING.id,
        qty: 12,
        createdAt: new Date(today.getTime() + 2000),
      },
    });

    const cookie = loginAs(t, seed.employees['shop-chief']);
    const res = await request(t.app.getHttpServer())
      .get('/api/shopfloor/display')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    const body = res.body as {
      totals: { qtyQc: number; qtyQcDone: number; qtyWto: number; qtyWtoDone: number };
    };
    expect(body.totals.qtyQc).toBe(0);
    expect(body.totals.qtyQcDone).toBe(0);
    expect(body.totals.qtyWto).toBe(12);
    expect(body.totals.qtyWtoDone).toBe(0);
  });

  test('QC/WTO WIP-кейс C: ВТО завершил → WTO ▶=0, WTO ✔=qtyCut', async () => {
    const today = new Date();
    const { orderId } = await setupQcWtoOrder('C', 12);
    // Сценарий B + WTO_PASSED после OPERATION_SCAN на IRONING.
    // currentOperationId по-прежнему IRONING (`completeWto` его не очищает),
    // но `hasFreshWtoPassed=true` → bucket=WTO_DONE → qtyWtoDone=12, qtyWto=0.
    await t.prisma.shiftSession.create({
      data: {
        employeeId: seed.employees.ironing.id,
        equipmentId: seed.equipment['ironing-station-01'].id,
        operationId: seed.operations.IRONING.id,
        startedAt: today,
      },
    });
    const passport = await t.prisma.passport.create({
      data: {
        number: 'P-PROC-C-M',
        qrCode: 'passport:proc-c-m',
        orderId,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: 'Чёрный',
        rollNumber: 'R-PROC-C',
        cutDate: today,
        qtyPlan: 12,
        qtyCut: 12,
        qtyGood: 12,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
        status: 'IN_PROGRESS',
        currentOperationId: seed.operations.IRONING.id,
        currentEmployeeId: seed.employees.ironing.id,
        currentRouteStepIndex: 3,
      },
    });
    await t.prisma.passportEvent.create({
      data: {
        passportId: passport.id,
        type: 'OPERATION_SCAN',
        employeeId: seed.employees.ironing.id,
        operationId: seed.operations.IRONING.id,
        qty: 12,
        createdAt: new Date(today.getTime() + 1000),
      },
    });
    await t.prisma.passportEvent.create({
      data: {
        passportId: passport.id,
        type: 'WTO_PASSED',
        employeeId: seed.employees.ironing.id,
        qty: 12,
        createdAt: new Date(today.getTime() + 2000),
      },
    });

    const cookie = loginAs(t, seed.employees['shop-chief']);
    const res = await request(t.app.getHttpServer())
      .get('/api/shopfloor/display')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    const body = res.body as {
      totals: { qtyQc: number; qtyQcDone: number; qtyWto: number; qtyWtoDone: number };
    };
    expect(body.totals.qtyWto).toBe(0);
    expect(body.totals.qtyWtoDone).toBe(12);
    // ОТК уже не учитывается: паспорт ушёл с QC.
    expect(body.totals.qtyQc).toBe(0);
    expect(body.totals.qtyQcDone).toBe(0);
  });

  test('QC/WTO WIP-кейс D: упаковка взяла → WTO ✔ очищается, qtyPacking=qtyGood', async () => {
    const today = new Date();
    const { orderId } = await setupQcWtoOrder('D', 12);
    // Упаковщик сделал OPERATION_SCAN на PACKING: currentOperationId
    // = PACKING, currentEmployeeId = packer, idx=4. Категория сменилась
    // → ни ✔ на ВТО, ни ▶/✔ на ОТК больше быть не должно.
    await t.prisma.shiftSession.create({
      data: {
        employeeId: seed.employees.packer.id,
        equipmentId: seed.equipment['packing-station-01'].id,
        operationId: seed.operations.PACKING.id,
        startedAt: today,
      },
    });
    const passport = await t.prisma.passport.create({
      data: {
        number: 'P-PROC-D-M',
        qrCode: 'passport:proc-d-m',
        orderId,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: 'Чёрный',
        rollNumber: 'R-PROC-D',
        cutDate: today,
        qtyPlan: 12,
        qtyCut: 12,
        qtyGood: 12,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
        status: 'IN_PROGRESS',
        currentOperationId: seed.operations.PACKING.id,
        currentEmployeeId: seed.employees.packer.id,
        currentRouteStepIndex: 4,
      },
    });
    // Полная история: WTO_PASSED → OPERATION_SCAN на PACKING.
    await t.prisma.passportEvent.create({
      data: {
        passportId: passport.id,
        type: 'WTO_PASSED',
        employeeId: seed.employees.ironing.id,
        qty: 12,
        createdAt: new Date(today.getTime() + 1000),
      },
    });
    await t.prisma.passportEvent.create({
      data: {
        passportId: passport.id,
        type: 'OPERATION_SCAN',
        employeeId: seed.employees.packer.id,
        operationId: seed.operations.PACKING.id,
        qty: 12,
        createdAt: new Date(today.getTime() + 2000),
      },
    });

    const cookie = loginAs(t, seed.employees['shop-chief']);
    const res = await request(t.app.getHttpServer())
      .get('/api/shopfloor/display')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    const body = res.body as {
      totals: {
        qtyQc: number;
        qtyQcDone: number;
        qtyWto: number;
        qtyWtoDone: number;
        qtyPacking: number;
      };
    };
    expect(body.totals.qtyWto).toBe(0);
    expect(body.totals.qtyWtoDone).toBe(0);
    expect(body.totals.qtyQc).toBe(0);
    expect(body.totals.qtyQcDone).toBe(0);
    // Упаковка считает qtyGood: в этом тесте qtyGood = qtyCut = 12.
    expect(body.totals.qtyPacking).toBe(12);
  });

  test('equipment.currentSizes: показывает уникальные размеры активных паспортов на станке (по operation+employee)', async () => {
    const today = new Date();
    const order = await t.prisma.order.create({
      data: {
        number: 'O-DSP-EQ-SZ',
        orderDate: today,
        color: 'Чёрный',
        status: 'IN_PRODUCTION',
        items: {
          create: [
            { productId: seed.product.id, sizeId: seed.sizes.S, qtyPlan: 5 },
            { productId: seed.product.id, sizeId: seed.sizes.M, qtyPlan: 5 },
            { productId: seed.product.id, sizeId: seed.sizes.L, qtyPlan: 5 },
          ],
        },
      },
    });
    // Швея открыла смену на Оверлоке 1, у неё два паспорта (S и M)
    // в работе на той же операции; третий паспорт другого размера (L)
    // принадлежит другому исполнителю — НЕ должен попасть в currentSizes.
    await t.prisma.shiftSession.create({
      data: {
        employeeId: seed.employees.seamstress.id,
        equipmentId: seed.equipment['overlock-01'].id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
        startedAt: today,
      },
    });
    const mkP = async (
      n: string,
      sizeId: string,
      employeeId: string,
    ): Promise<void> => {
      await t.prisma.passport.create({
        data: {
          number: n,
          qrCode: `passport:${n}`,
          orderId: order.id,
          productId: seed.product.id,
          sizeId,
          color: 'Чёрный',
          rollNumber: `R-${n}`,
          cutDate: today,
          qtyPlan: 1,
          qtyCut: 1,
          qtyGood: 1,
          cutterId: seed.employees.cutter.id,
          creatorId: seed.employees.cutter.id,
          status: 'IN_PROGRESS',
          currentOperationId: seed.operations.SEW_OVERLOCK_1.id,
          currentEmployeeId: employeeId,
        },
      });
    };
    await mkP('P-EQ-S', seed.sizes.S, seed.employees.seamstress.id);
    await mkP('P-EQ-M', seed.sizes.M, seed.employees.seamstress.id);
    // L-паспорт — на другой швее (но на той же операции). Это должно
    // быть исключено фильтром (employeeId смены).
    await mkP('P-EQ-L', seed.sizes.L, seed.employees.cutter.id);
    // Дубль S от той же швеи — тоже на этой же операции. UI должен
    // получить размер ровно один раз (массив без дублей).
    await mkP('P-EQ-S2', seed.sizes.S, seed.employees.seamstress.id);

    const cookie = loginAs(t, seed.employees['shop-chief']);
    const res = await request(t.app.getHttpServer())
      .get('/api/shopfloor/display')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);

    const body = res.body as {
      equipment: Array<{ code: string; currentSizes: string[] }>;
    };
    const overlock = body.equipment.find((e) => e.code === 'overlock-01')!;
    // Стабильный порядок — по `Size.sortOrder`: S(10) → M(20).
    expect(overlock.currentSizes).toEqual(['S', 'M']);
    // Простаивающие станки получают пустой массив (контракт DTO).
    const cuttingTable = body.equipment.find(
      (e) => e.code === 'cutting-table-01',
    )!;
    expect(cuttingTable.currentSizes).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // equipment.currentSizes — assigned-shift fallback (issueToEmployee)
  //
  // Регрессия: до фикса equipment-плитка не показывала размер 12 шт M
  // на «Оверлоке», когда у паспорта `currentOperationId` ещё CUT_DIVISION
  // (после `issueToEmployee`, до первого OPERATION_SCAN). Логика
  // `currentSizes` теперь синхронизирована с матрицей (тот же fallback
  // через активную смену швеи), см. `ShopfloorService.listEquipmentStatus`.
  // -------------------------------------------------------------------------

  test('equipment.currentSizes [A]: показывает размер при issueToEmployee до scan (fallback по shift)', async () => {
    // Сценарий из ТЗ: 12 шт размера M в работе на «Оверлоке 01»,
    // паспорт уже выдан швее (`currentEmployeeId` = seamstress.id),
    // но `currentOperationId` ещё CUT_DIVISION (CUTTING) — первого
    // OPERATION_SCAN на sewing-операцию ещё не было. Без fallback'а
    // equipment не показывал бы M.
    const today = new Date();
    const order = await t.prisma.order.create({
      data: {
        number: 'O-EQ-FB-A',
        orderDate: today,
        color: 'Чёрный',
        status: 'IN_PRODUCTION',
        items: {
          create: [
            { productId: seed.product.id, sizeId: seed.sizes.M, qtyPlan: 12 },
          ],
        },
      },
    });
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
        number: 'P-EQ-FB-A-M',
        qrCode: 'passport:eq-fb-a-m',
        orderId: order.id,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: 'Чёрный',
        rollNumber: 'R-FB-A',
        cutDate: today,
        qtyPlan: 12,
        qtyCut: 12,
        qtyGood: 12,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
        status: 'IN_PROGRESS',
        // Ключевая часть кейса: операция ещё CUT_DIVISION, не SEWING.
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
      equipment: Array<{ code: string; currentSizes: string[] }>;
    };
    const overlock = body.equipment.find((e) => e.code === 'overlock-01')!;
    expect(overlock.currentSizes).toEqual(['M']);
  });

  test('equipment.currentSizes [B]: показывает размер после OPERATION_SCAN (strict match)', async () => {
    // После первого OPERATION_SCAN `currentOperationId` уже =
    // shift.operationId (sewing). Strict-ветка должна работать так же,
    // как fallback'овая — это ровно тот же кейс, что покрыт ранее
    // существующим тестом, но фиксируем явно.
    const today = new Date();
    const order = await t.prisma.order.create({
      data: {
        number: 'O-EQ-FB-B',
        orderDate: today,
        color: 'Чёрный',
        status: 'IN_PRODUCTION',
        items: {
          create: [
            { productId: seed.product.id, sizeId: seed.sizes.M, qtyPlan: 12 },
          ],
        },
      },
    });
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
        number: 'P-EQ-FB-B-M',
        qrCode: 'passport:eq-fb-b-m',
        orderId: order.id,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: 'Чёрный',
        rollNumber: 'R-FB-B',
        cutDate: today,
        qtyPlan: 12,
        qtyCut: 12,
        qtyGood: 12,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
        status: 'IN_PROGRESS',
        currentOperationId: seed.operations.SEW_OVERLOCK_1.id,
        currentEmployeeId: seed.employees.seamstress.id,
      },
    });
    const cookie = loginAs(t, seed.employees['shop-chief']);
    const res = await request(t.app.getHttpServer())
      .get('/api/shopfloor/display')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    const body = res.body as {
      equipment: Array<{ code: string; currentSizes: string[] }>;
    };
    const overlock = body.equipment.find((e) => e.code === 'overlock-01')!;
    expect(overlock.currentSizes).toEqual(['M']);
  });

  test('equipment.currentSizes [C]: после complete (currentEmployeeId=null) размер пропадает', async () => {
    // После `completeOperationByEmployee` паспорт остаётся IN_PROGRESS
    // с прежним `currentOperationId`, но `currentEmployeeId = null`.
    // На станке физически уже ничего нет — equipment.currentSizes
    // должен быть пустым.
    const today = new Date();
    const order = await t.prisma.order.create({
      data: {
        number: 'O-EQ-FB-C',
        orderDate: today,
        color: 'Чёрный',
        status: 'IN_PRODUCTION',
        items: {
          create: [
            { productId: seed.product.id, sizeId: seed.sizes.M, qtyPlan: 12 },
          ],
        },
      },
    });
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
        number: 'P-EQ-FB-C-M',
        qrCode: 'passport:eq-fb-c-m',
        orderId: order.id,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: 'Чёрный',
        rollNumber: 'R-FB-C',
        cutDate: today,
        qtyPlan: 12,
        qtyCut: 12,
        qtyGood: 12,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
        status: 'IN_PROGRESS',
        currentOperationId: seed.operations.SEW_OVERLOCK_1.id,
        currentEmployeeId: null,
      },
    });
    const cookie = loginAs(t, seed.employees['shop-chief']);
    const res = await request(t.app.getHttpServer())
      .get('/api/shopfloor/display')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    const body = res.body as {
      equipment: Array<{ code: string; currentSizes: string[] }>;
    };
    const overlock = body.equipment.find((e) => e.code === 'overlock-01')!;
    expect(overlock.currentSizes).toEqual([]);
  });

  test('equipment.currentSizes [D]: несколько размеров на одном станке сортируются по Size.sortOrder', async () => {
    // На «Оверлоке 01» у одной швеи два паспорта разных размеров —
    // M (через assigned-shift fallback, currentOperation = CUT_DIVISION)
    // и L (уже после scan, currentOperation = SEW_OVERLOCK_1). Оба
    // должны попасть в currentSizes, отсортированные по sortOrder
    // (M=20, L=30 → ["M", "L"]).
    const today = new Date();
    const order = await t.prisma.order.create({
      data: {
        number: 'O-EQ-FB-D',
        orderDate: today,
        color: 'Чёрный',
        status: 'IN_PRODUCTION',
        items: {
          create: [
            { productId: seed.product.id, sizeId: seed.sizes.M, qtyPlan: 6 },
            { productId: seed.product.id, sizeId: seed.sizes.L, qtyPlan: 6 },
          ],
        },
      },
    });
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
        number: 'P-EQ-FB-D-M',
        qrCode: 'passport:eq-fb-d-m',
        orderId: order.id,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: 'Чёрный',
        rollNumber: 'R-FB-D-M',
        cutDate: today,
        qtyPlan: 6,
        qtyCut: 6,
        qtyGood: 6,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
        status: 'IN_PROGRESS',
        // M: assigned-shift fallback (CUT_DIVISION → Оверлок 01).
        currentOperationId: seed.operations.CUT_DIVISION.id,
        currentEmployeeId: seed.employees.seamstress.id,
      },
    });
    await t.prisma.passport.create({
      data: {
        number: 'P-EQ-FB-D-L',
        qrCode: 'passport:eq-fb-d-l',
        orderId: order.id,
        productId: seed.product.id,
        sizeId: seed.sizes.L,
        color: 'Чёрный',
        rollNumber: 'R-FB-D-L',
        cutDate: today,
        qtyPlan: 6,
        qtyCut: 6,
        qtyGood: 6,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
        status: 'IN_PROGRESS',
        // L: strict match (уже отсканирован на Оверлок 01).
        currentOperationId: seed.operations.SEW_OVERLOCK_1.id,
        currentEmployeeId: seed.employees.seamstress.id,
      },
    });

    const cookie = loginAs(t, seed.employees['shop-chief']);
    const res = await request(t.app.getHttpServer())
      .get('/api/shopfloor/display')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    const body = res.body as {
      equipment: Array<{ code: string; currentSizes: string[] }>;
    };
    const overlock = body.equipment.find((e) => e.code === 'overlock-01')!;
    // Стабильная сортировка по Size.sortOrder: M(20) → L(30).
    expect(overlock.currentSizes).toEqual(['M', 'L']);
  });

  // ---------------------------------------------------------------------------
  // equipment.status — новая бизнес-семантика для TV-витрины:
  //   ONLINE  = открытая смена + хотя бы один паспорт в работе на станке;
  //   WARNING = открытая смена, но паспорта в работе нет (швея зашла,
  //             но крой ещё не взяла или только что закончила);
  //   OFFLINE = нет открытой смены / `equipment.active = false`.
  // Раньше использовался time-based порог (`WARNING_AFTER_MS = 15 мин`),
  // он давал ложно-зелёный сигнал «смена открыта, паспортов нет, плитка
  // зелёная первые 15 мин». См. `ShopfloorService.listEquipmentStatus`.
  // ---------------------------------------------------------------------------

  test('equipment.status [A]: открытая смена + паспорт в работе → ONLINE + currentSizes ["M"]', async () => {
    const today = new Date();
    const order = await t.prisma.order.create({
      data: {
        number: 'O-EQ-ST-A',
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
        number: 'P-EQ-ST-A-M',
        qrCode: 'passport:eq-st-a-m',
        orderId: order.id,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: 'Чёрный',
        rollNumber: 'R-ST-A',
        cutDate: today,
        qtyPlan: 4,
        qtyCut: 4,
        qtyGood: 4,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
        status: 'IN_PROGRESS',
        currentOperationId: seed.operations.SEW_OVERLOCK_1.id,
        currentEmployeeId: seed.employees.seamstress.id,
      },
    });

    const cookie = loginAs(t, seed.employees['shop-chief']);
    const res = await request(t.app.getHttpServer())
      .get('/api/shopfloor/display')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    const body = res.body as {
      equipment: Array<{ code: string; status: string; currentSizes: string[] }>;
    };
    const overlock = body.equipment.find((e) => e.code === 'overlock-01')!;
    expect(overlock.status).toBe('ONLINE');
    expect(overlock.currentSizes).toEqual(['M']);
  });

  test('equipment.status [B]: открытая смена БЕЗ паспорта → WARNING + currentSizes []', async () => {
    // Швея зашла на смену, но ещё не взяла крой — плитка должна быть
    // жёлтой, а не зелёной (раньше первые 15 мин она была зелёной).
    const today = new Date();
    await t.prisma.shiftSession.create({
      data: {
        employeeId: seed.employees.seamstress.id,
        equipmentId: seed.equipment['overlock-01'].id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
        startedAt: today,
      },
    });

    const cookie = loginAs(t, seed.employees['shop-chief']);
    const res = await request(t.app.getHttpServer())
      .get('/api/shopfloor/display')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    const body = res.body as {
      equipment: Array<{ code: string; status: string; currentSizes: string[] }>;
    };
    const overlock = body.equipment.find((e) => e.code === 'overlock-01')!;
    expect(overlock.status).toBe('WARNING');
    expect(overlock.currentSizes).toEqual([]);
  });

  test('equipment.status [C]: нет смены → OFFLINE + currentSizes []', async () => {
    // Без `ShiftSession` плитка должна быть серой даже при наличии
    // активных паспортов в системе (они не привязаны к этому станку).
    const cookie = loginAs(t, seed.employees['shop-chief']);
    const res = await request(t.app.getHttpServer())
      .get('/api/shopfloor/display')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    const body = res.body as {
      equipment: Array<{ code: string; status: string; currentSizes: string[] }>;
    };
    const overlock = body.equipment.find((e) => e.code === 'overlock-01')!;
    expect(overlock.status).toBe('OFFLINE');
    expect(overlock.currentSizes).toEqual([]);
  });

  test('equipment.status [D]: route-WIP после issueToEmployee до scan → ONLINE по assigned-shift fallback', async () => {
    // Кейс из ТЗ: швея взяла крой (`issueToEmployee` выставил
    // `currentEmployeeId`), но первого `OPERATION_SCAN` ещё не было,
    // поэтому `currentOperationId` всё ещё CUT_DIVISION (CUTTING). Без
    // assigned-shift fallback'а equipment-плитка показала бы WARNING,
    // хотя физически 12 шт M уже на «Оверлоке 01». currentSizes
    // должен подтянуться через fallback — и из этого следует ONLINE.
    const today = new Date();
    const order = await t.prisma.order.create({
      data: {
        number: 'O-EQ-ST-D',
        orderDate: today,
        color: 'Чёрный',
        status: 'IN_PRODUCTION',
        items: {
          create: [
            { productId: seed.product.id, sizeId: seed.sizes.M, qtyPlan: 12 },
          ],
        },
      },
    });
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
        number: 'P-EQ-ST-D-M',
        qrCode: 'passport:eq-st-d-m',
        orderId: order.id,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: 'Чёрный',
        rollNumber: 'R-ST-D',
        cutDate: today,
        qtyPlan: 12,
        qtyCut: 12,
        qtyGood: 12,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
        status: 'IN_PROGRESS',
        // Ключ кейса: операция ещё CUT_DIVISION (после issueToEmployee
        // до первого OPERATION_SCAN на sewing-операцию).
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
      equipment: Array<{ code: string; status: string; currentSizes: string[] }>;
    };
    const overlock = body.equipment.find((e) => e.code === 'overlock-01')!;
    expect(overlock.status).toBe('ONLINE');
    expect(overlock.currentSizes).toEqual(['M']);
  });

  test('equipment.status: equipment.active = false → OFFLINE даже при открытой смене', async () => {
    // Защита от регресса: даже если есть открытая смена, выведенный
    // из эксплуатации станок (`active = false`) обязан остаться OFFLINE
    // — это контракт DTO с момента §9a.5.
    const today = new Date();
    await t.prisma.equipment.update({
      where: { id: seed.equipment['overlock-01'].id },
      data: { active: false },
    });
    await t.prisma.shiftSession.create({
      data: {
        employeeId: seed.employees.seamstress.id,
        equipmentId: seed.equipment['overlock-01'].id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
        startedAt: today,
      },
    });

    const cookie = loginAs(t, seed.employees['shop-chief']);
    const res = await request(t.app.getHttpServer())
      .get('/api/shopfloor/display')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    const body = res.body as {
      equipment: Array<{ code: string; status: string; currentSizes: string[] }>;
    };
    const overlock = body.equipment.find((e) => e.code === 'overlock-01')!;
    expect(overlock.status).toBe('OFFLINE');
    expect(overlock.currentSizes).toEqual([]);
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
