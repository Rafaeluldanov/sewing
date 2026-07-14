/**
 * Integration-тесты модуля «Техкарты» (MVP, ADR-0022) — см.
 * `docs/domain.md §19`, `docs/api.md §18`.
 *
 * Покрытие:
 *   1. POST/GET/PATCH `/api/tech-cards` (CRUD шаблонов с упорядоченными
 *      строками `materialLines` / `outsourceLines`).
 *   2. Создание заказа с `techCardId` → 400 на неактивной техкарте.
 *   3. `OrdersService.start()` фиксирует snapshot
 *      `OrderMaterialRequirement[]` и `OrderOutsourceRequirement[]`
 *      с `totalQty = qtyPerUnit * Σ OrderItem.qtyPlan`.
 *   4. Заказ без `techCardId` запускается, snapshot пуст.
 *   5. Правка техкарты (full-replace строк) после запуска заказа НЕ
 *      меняет уже зафиксированный snapshot, и snapshot переживает
 *      даже деактивацию шаблона.
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

describeWithDb('integration — tech cards (MVP, ADR-0022)', () => {
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
    };
  });

  // ---------------------------------------------------------------------------
  // CRUD шаблонов
  // ---------------------------------------------------------------------------

  test('A. POST /api/tech-cards: создаём шаблон с упорядоченными строками', async () => {
    const r = await request(t.app.getHttpServer())
      .post('/api/tech-cards')
      .set('Cookie', cookies.manager)
      .send({
        code: 'TC-BASIC-1',
        name: 'Базовая техкарта',
        materialLines: [
          { name: 'Кулирка', unit: 'м', qtyPerUnit: '0.55' },
          { name: 'Нитки', unit: 'м', qtyPerUnit: '120', note: 'белые' },
        ],
        outsourceLines: [
          {
            name: 'Шелкография',
            unit: 'шт',
            qtyPerUnit: '1',
            vendorName: 'Print&Co',
          },
          { name: 'Этикетки за партию' }, // unit/qtyPerUnit опц.
        ],
      });
    expect(r.status).toBe(201);
    expect(r.body.code).toBe('TC-BASIC-1');
    expect(r.body.isActive).toBe(true);
    expect(r.body.materialLines).toHaveLength(2);
    expect(r.body.outsourceLines).toHaveLength(2);
    // sortOrder проставляется backend-ом по позиции в массиве (см. сервис).
    expect(
      r.body.materialLines.map((l: { sortOrder: number }) => l.sortOrder),
    ).toEqual([10, 20]);
    expect(
      r.body.outsourceLines.map((l: { sortOrder: number }) => l.sortOrder),
    ).toEqual([10, 20]);
    // qtyPerUnit отдаётся строкой (Decimal-семантика).
    expect(typeof r.body.materialLines[0].qtyPerUnit).toBe('string');
    expect(r.body.outsourceLines[1].unit).toBeNull();
    expect(r.body.outsourceLines[1].qtyPerUnit).toBeNull();

    const list = await request(t.app.getHttpServer())
      .get('/api/tech-cards')
      .set('Cookie', cookies.manager)
      .expect(200);
    const item = list.body.find(
      (c: { code: string }) => c.code === 'TC-BASIC-1',
    );
    expect(item).toBeDefined();
    expect(item.materialLinesCount).toBe(2);
    expect(item.outsourceLinesCount).toBe(2);

    // Уникальность code.
    const dup = await request(t.app.getHttpServer())
      .post('/api/tech-cards')
      .set('Cookie', cookies.manager)
      .send({ code: 'TC-BASIC-1', name: 'Дубль' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('TECH_CARD_CODE_TAKEN');

    // qtyPerUnit > 0 — иначе VALIDATION_ERROR.
    const bad = await request(t.app.getHttpServer())
      .post('/api/tech-cards')
      .set('Cookie', cookies.manager)
      .send({
        code: 'TC-BAD',
        name: 'плохая',
        materialLines: [{ name: 'X', unit: 'м', qtyPerUnit: '0' }],
      });
    expect(bad.status).toBe(400);
  });

  test('A2. PATCH /api/tech-cards/:id: full-replace строк меняет порядок и состав', async () => {
    const created = await createTechCard(t, cookies.manager, {
      code: 'TC-PATCH',
      name: 'Техкарта для patch',
      materialLines: [
        { name: 'A', unit: 'м', qtyPerUnit: '1' },
        { name: 'B', unit: 'м', qtyPerUnit: '2' },
      ],
      outsourceLines: [{ name: 'OutA', unit: 'шт', qtyPerUnit: '1' }],
    });

    // Полностью заменяем materialLines (B→C, добавили D), пустим outsource.
    const patched = await request(t.app.getHttpServer())
      .patch(`/api/tech-cards/${created.id}`)
      .set('Cookie', cookies.manager)
      .send({
        materialLines: [
          { name: 'C', unit: 'кг', qtyPerUnit: '0.25' },
          { name: 'D', unit: 'м', qtyPerUnit: '5' },
        ],
        outsourceLines: [],
      })
      .expect(200);
    expect(patched.body.materialLines.map((l: { name: string }) => l.name)).toEqual([
      'C',
      'D',
    ]);
    expect(patched.body.outsourceLines).toHaveLength(0);
    expect(
      patched.body.materialLines.map((l: { sortOrder: number }) => l.sortOrder),
    ).toEqual([10, 20]);
  });

  // ---------------------------------------------------------------------------
  // Снапшот на заказе
  // ---------------------------------------------------------------------------

  test('B. start(): snapshot копирует строки, totalQty = qtyPerUnit * Σ qtyPlan', async () => {
    const tc = await createTechCard(t, cookies.manager, {
      code: 'TC-SNAP',
      name: 'Snapshot demo',
      materialLines: [
        { name: 'Кулирка', unit: 'м', qtyPerUnit: '0.5' },
        { name: 'Нитки', unit: 'м', qtyPerUnit: '120', note: 'белые' },
      ],
      outsourceLines: [
        { name: 'Шелкография', unit: 'шт', qtyPerUnit: '1' },
        { name: 'Этикетки за партию' },
      ],
    });

    // baseQty = 2 + 3 = 5
    const orderId = await createOrderWithTechCard(
      t,
      seed,
      cookies.manager,
      [
        { sizeId: seed.sizes.M, qtyPlan: 2 },
        { sizeId: seed.sizes.L, qtyPlan: 3 },
      ],
      tc.id,
    );

    // Этап «Указать в заказе» (см. ТЗ §2): snapshot строк
    // материалов теперь собирается уже в `OrdersService.create()`,
    // если у заказа есть `techCardId`. Это нужно, чтобы поле
    // «Цвет нужно указать в заказе» появилось в DRAFT/CALCULATION
    // ещё до запуска производства. Outsource по-прежнему пуст —
    // его snapshot фиксируется только в `start()`.
    const before = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(before.body.techCardId).toBe(tc.id);
    expect(before.body.techCardCode).toBe('TC-SNAP');
    expect(before.body.materialRequirements).toHaveLength(2);
    const matBefore = before.body.materialRequirements;
    expect(matBefore.map((r: { sortOrder: number }) => r.sortOrder)).toEqual([
      10, 20,
    ]);
    expect(matBefore[0].name).toBe('Кулирка');
    expect(Number(matBefore[0].totalQty)).toBeCloseTo(0.5 * 5, 4);
    expect(Number(matBefore[1].totalQty)).toBeCloseTo(120 * 5, 4);
    expect(before.body.outsourceRequirements).toEqual([]);

    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start`)
      .set('Cookie', cookies.manager)
      .expect(201);

    const after = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}`)
      .set('Cookie', cookies.manager)
      .expect(200);

    expect(after.body.materialRequirements).toHaveLength(2);
    const mat = after.body.materialRequirements;
    expect(mat.map((r: { sortOrder: number }) => r.sortOrder)).toEqual([10, 20]);
    expect(mat[0].name).toBe('Кулирка');
    expect(Number(mat[0].totalQty)).toBeCloseTo(0.5 * 5, 4);
    expect(Number(mat[1].totalQty)).toBeCloseTo(120 * 5, 4);

    expect(after.body.outsourceRequirements).toHaveLength(2);
    const outs = after.body.outsourceRequirements;
    expect(outs[0].name).toBe('Шелкография');
    expect(Number(outs[0].totalQty)).toBeCloseTo(1 * 5, 4);
    // Outsource без qtyPerUnit → totalQty = null
    expect(outs[1].totalQty).toBeNull();
    expect(outs[1].qtyPerUnit).toBeNull();
    expect(outs[1].unit).toBeNull();
  });

  test('B2. Backward-compat: заказ без techCardId стартует, snapshot пуст', async () => {
    const create = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookies.manager)
      .send({
        orderDate: '2026-04-15T00:00:00.000Z',
        productId: seed.product.id,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 1 }],
      })
      .expect(201);
    const orderId: string = create.body.id;
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start`)
      .set('Cookie', cookies.manager)
      .expect(201);
    const detail = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(detail.body.techCardId).toBeNull();
    expect(detail.body.materialRequirements).toEqual([]);
    expect(detail.body.outsourceRequirements).toEqual([]);
  });

  test('B3. TECH_CARD_INACTIVE: нельзя создать заказ на скрытой техкарте', async () => {
    const tc = await createTechCard(t, cookies.manager, {
      code: 'TC-INACTIVE',
      name: 'Скрытая',
      materialLines: [{ name: 'A', unit: 'м', qtyPerUnit: '1' }],
    });
    await request(t.app.getHttpServer())
      .patch(`/api/tech-cards/${tc.id}`)
      .set('Cookie', cookies.manager)
      .send({ isActive: false })
      .expect(200);

    const r = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookies.manager)
      .send({
        orderDate: '2026-04-15T00:00:00.000Z',
        productId: seed.product.id,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 1 }],
        techCardId: tc.id,
      });
    // 409 (Conflict) — soft-protection: «состояние ресурса не позволяет
    // его выбрать». См. `TechCardInactiveError` в `errors.ts`.
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('TECH_CARD_INACTIVE');
  });

  // ---------------------------------------------------------------------------
  // MVP-2 (ADR-0022 §«Cut-ready readiness»): triggerType + derived
  // готовность кроя
  // ---------------------------------------------------------------------------

  test('D1. POST/GET tech-card сохраняет triggerType=CUT_READY и backward-compat MANUAL по умолчанию', async () => {
    const r = await request(t.app.getHttpServer())
      .post('/api/tech-cards')
      .set('Cookie', cookies.manager)
      .send({
        code: 'TC-TRIG',
        name: 'Триггеры',
        outsourceLines: [
          // явный CUT_READY
          {
            name: 'Шелкография по крою',
            unit: 'шт',
            qtyPerUnit: '1',
            triggerType: 'CUT_READY',
          },
          // без поля → должен прийти обратно MANUAL (Zod default)
          { name: 'Этикетки за партию' },
          // явный MANUAL
          { name: 'Доставка', triggerType: 'MANUAL' },
        ],
      });
    expect(r.status).toBe(201);
    expect(r.body.outsourceLines.map((l: { triggerType: string }) => l.triggerType)).toEqual([
      'CUT_READY',
      'MANUAL',
      'MANUAL',
    ]);

    const detail = await request(t.app.getHttpServer())
      .get(`/api/tech-cards/${r.body.id}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(detail.body.outsourceLines[0].triggerType).toBe('CUT_READY');
    expect(detail.body.outsourceLines[1].triggerType).toBe('MANUAL');
  });

  test('D2. start() копирует triggerType в OrderOutsourceRequirement', async () => {
    const tc = await createTechCard(t, cookies.manager, {
      code: 'TC-CUT-READY',
      name: 'CUT_READY snapshot',
      outsourceLines: [
        {
          name: 'Шелкография',
          unit: 'шт',
          qtyPerUnit: '1',
          triggerType: 'CUT_READY',
        },
        { name: 'Доставка', triggerType: 'MANUAL' },
      ],
    });
    const orderId = await createOrderWithTechCard(
      t,
      seed,
      cookies.manager,
      [{ sizeId: seed.sizes.M, qtyPlan: 2 }],
      tc.id,
    );
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start`)
      .set('Cookie', cookies.manager)
      .expect(201);
    const detail = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    const outs = detail.body.outsourceRequirements;
    expect(outs).toHaveLength(2);
    expect(outs[0].triggerType).toBe('CUT_READY');
    expect(outs[1].triggerType).toBe('MANUAL');
  });

  test('D3. CUT_READY: derived isReadyToOrder/readinessLabel зависят от Passport.currentCellId', async () => {
    const tc = await createTechCard(t, cookies.manager, {
      code: 'TC-READY',
      name: 'Cut readiness',
      outsourceLines: [
        {
          name: 'Шелкография',
          unit: 'шт',
          qtyPerUnit: '1',
          triggerType: 'CUT_READY',
        },
        { name: 'Доставка', triggerType: 'MANUAL' },
      ],
    });
    const orderId = await createOrderWithTechCard(
      t,
      seed,
      cookies.manager,
      [{ sizeId: seed.sizes.M, qtyPlan: 2 }],
      tc.id,
    );
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start`)
      .set('Cookie', cookies.manager)
      .expect(201);

    // Шаг 1: паспортов нет → CUT_READY-строка «Ожидает размещения кроя»,
    // MANUAL-строка всегда без сигнала.
    const noPassports = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    {
      const cutReady = noPassports.body.outsourceRequirements.find(
        (o: { triggerType: string }) => o.triggerType === 'CUT_READY',
      );
      const manual = noPassports.body.outsourceRequirements.find(
        (o: { triggerType: string }) => o.triggerType === 'MANUAL',
      );
      expect(cutReady.isReadyToOrder).toBe(false);
      expect(cutReady.readinessLabel).toBe('Ожидает размещения кроя');
      expect(manual.isReadyToOrder).toBe(false);
      expect(manual.readinessLabel).toBeNull();
    }

    // Шаг 2: создаём два паспорта, ни один не размещён в ячейку.
    const p1 = await request(t.app.getHttpServer())
      .post('/api/passports')
      .set('Cookie', cookies.manager)
      .send({
        orderId,
        sizeId: seed.sizes.M,
        rollNumber: 'R-1',
        cutDate: '2026-04-15T00:00:00.000Z',
        qtyCut: 1,
        cutterId: seed.employees.cutter.id,
      })
      .expect(201);
    const p2 = await request(t.app.getHttpServer())
      .post('/api/passports')
      .set('Cookie', cookies.manager)
      .send({
        orderId,
        sizeId: seed.sizes.M,
        rollNumber: 'R-2',
        cutDate: '2026-04-15T00:00:00.000Z',
        qtyCut: 1,
        cutterId: seed.employees.cutter.id,
      })
      .expect(201);

    const noneInCell = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    {
      const cutReady = noneInCell.body.outsourceRequirements.find(
        (o: { triggerType: string }) => o.triggerType === 'CUT_READY',
      );
      expect(cutReady.isReadyToOrder).toBe(false);
      expect(cutReady.readinessLabel).toBe('Ожидает размещения кроя');
    }

    // Шаг 3: размещаем только один паспорт → ВСЁ ЕЩЁ не готово.
    await request(t.app.getHttpServer())
      .post(`/api/passports/${p1.body.id}/place`)
      .set('Cookie', cookies.manager)
      .send({ cellId: seed.cells.A1.id })
      .expect(201);

    const partial = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    {
      const cutReady = partial.body.outsourceRequirements.find(
        (o: { triggerType: string }) => o.triggerType === 'CUT_READY',
      );
      expect(cutReady.isReadyToOrder).toBe(false);
      expect(cutReady.readinessLabel).toBe('Ожидает размещения кроя');
    }

    // Шаг 4: размещаем второй паспорт в другую ячейку → готово.
    await request(t.app.getHttpServer())
      .post(`/api/passports/${p2.body.id}/place`)
      .set('Cookie', cookies.manager)
      .send({ cellId: seed.cells.A2.id })
      .expect(201);

    const ready = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    {
      const cutReady = ready.body.outsourceRequirements.find(
        (o: { triggerType: string }) => o.triggerType === 'CUT_READY',
      );
      const manual = ready.body.outsourceRequirements.find(
        (o: { triggerType: string }) => o.triggerType === 'MANUAL',
      );
      expect(cutReady.isReadyToOrder).toBe(true);
      expect(cutReady.readinessLabel).toBe('Готово к заказу');
      // MANUAL никогда не получает сигнал готовности — ни до, ни после.
      expect(manual.isReadyToOrder).toBe(false);
      expect(manual.readinessLabel).toBeNull();
    }
  });

  test('D4. Edit-after-start: смена triggerType шаблона не меняет уже зафиксированный snapshot', async () => {
    const tc = await createTechCard(t, cookies.manager, {
      code: 'TC-EDIT-TRIG',
      name: 'Edit trigger after start',
      outsourceLines: [
        {
          name: 'Шелкография',
          unit: 'шт',
          qtyPerUnit: '1',
          triggerType: 'CUT_READY',
        },
      ],
    });
    const orderId = await createOrderWithTechCard(
      t,
      seed,
      cookies.manager,
      [{ sizeId: seed.sizes.M, qtyPlan: 1 }],
      tc.id,
    );
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start`)
      .set('Cookie', cookies.manager)
      .expect(201);

    // Поменяли triggerType шаблона на MANUAL — старый snapshot
    // продолжает «знать», что строка была CUT_READY.
    await request(t.app.getHttpServer())
      .patch(`/api/tech-cards/${tc.id}`)
      .set('Cookie', cookies.manager)
      .send({
        outsourceLines: [
          {
            name: 'Шелкография',
            unit: 'шт',
            qtyPerUnit: '1',
            triggerType: 'MANUAL',
          },
        ],
      })
      .expect(200);

    const detail = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(detail.body.outsourceRequirements[0].triggerType).toBe('CUT_READY');
    // Без размещённых паспортов — «Ожидает размещения кроя».
    expect(detail.body.outsourceRequirements[0].isReadyToOrder).toBe(false);
    expect(detail.body.outsourceRequirements[0].readinessLabel).toBe(
      'Ожидает размещения кроя',
    );
  });

  // ---------------------------------------------------------------------------
  // Этап «Доработка UI и контракта техкарты» (см. ТЗ): hardware* / image /
  // ORDER_SELECTED_COLOR + действие сохранения цвета по строке заказа.
  // ---------------------------------------------------------------------------

  test('E1. PACKAGING-строка с hardware* / materialImageUrl сохраняется и попадает в snapshot уже в DRAFT', async () => {
    const r = await request(t.app.getHttpServer())
      .post('/api/tech-cards')
      .set('Cookie', cookies.manager)
      .send({
        code: 'TC-HW',
        name: 'Тест фурнитуры',
        materialLines: [
          {
            name: 'Молния YKK',
            unit: 'шт',
            qtyPerUnit: '1',
            materialRole: 'PACKAGING',
            colorRule: 'ORDER_SELECTED_COLOR',
            hardwareSizeText: '50 см',
            hardwareMaterialText: 'металл',
            materialImageUrl: 'https://example.com/zipper.png',
            materialImageOriginalFileName: 'zipper.png',
          },
        ],
      })
      .expect(201);
    const line = r.body.materialLines[0];
    expect(line.materialRole).toBe('PACKAGING');
    expect(line.hardwareSizeText).toBe('50 см');
    expect(line.hardwareMaterialText).toBe('металл');
    expect(line.materialImageUrl).toBe('https://example.com/zipper.png');
    expect(line.materialImageOriginalFileName).toBe('zipper.png');
    expect(line.colorRule).toBe('ORDER_SELECTED_COLOR');

    const orderId = await createOrderWithTechCard(
      t,
      seed,
      cookies.manager,
      [{ sizeId: seed.sizes.M, qtyPlan: 2 }],
      r.body.id,
    );

    // Этап «Указать в заказе» (см. ТЗ §2): snapshot создаётся уже
    // в `create()`, без ожидания `start()`. Проверяем, что DRAFT-
    // заказ сразу отдаёт строки с `requiresColorSelection = true`.
    const draftDetail = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(draftDetail.body.status).toBe('DRAFT');
    const draftReq = draftDetail.body.materialRequirements[0];
    expect(draftReq.hardwareSizeText).toBe('50 см');
    expect(draftReq.hardwareMaterialText).toBe('металл');
    expect(draftReq.materialImageUrl).toBe('https://example.com/zipper.png');
    expect(draftReq.requiresColorSelection).toBe(true);
    expect(draftReq.selectedColorText).toBeNull();
    // ORDER_SELECTED_COLOR не наследует Order.color — resolvedColorText
    // начинается с null до сохранения цвета через action.
    expect(draftReq.resolvedColorText).toBeNull();
  });

  test('E2. PATCH .../color сохраняет selectedColorText и синхронизирует resolvedColorText (DRAFT, до start)', async () => {
    const tc = await createTechCard(t, cookies.manager, {
      code: 'TC-COLOR-SAVE',
      name: 'Цвет в заказе',
      materialLines: [
        {
          name: 'Пакет',
          unit: 'шт',
          qtyPerUnit: '1',
          materialRole: 'PACKAGING',
          colorRule: 'ORDER_SELECTED_COLOR',
        },
        {
          name: 'Кулирка',
          unit: 'м',
          qtyPerUnit: '0.5',
          materialRole: 'MAIN_FABRIC',
          colorRule: 'ORDER_COLOR',
        },
      ],
    });
    const orderId = await createOrderWithTechCard(
      t,
      seed,
      cookies.manager,
      [{ sizeId: seed.sizes.M, qtyPlan: 3 }],
      tc.id,
    );

    const detail = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(detail.body.status).toBe('DRAFT');
    const orderSelected = detail.body.materialRequirements.find(
      (r: { name: string }) => r.name === 'Пакет',
    );
    const fabric = detail.body.materialRequirements.find(
      (r: { name: string }) => r.name === 'Кулирка',
    );
    expect(orderSelected.requiresColorSelection).toBe(true);
    expect(fabric.requiresColorSelection).toBe(false);

    // Сохраняем цвет по позиции «Указать в заказе» уже в DRAFT —
    // менеджеру не нужно ждать запуска производства.
    const ok = await request(t.app.getHttpServer())
      .patch(
        `/api/orders/${orderId}/material-requirements/${orderSelected.id}/color`,
      )
      .set('Cookie', cookies.manager)
      .send({ selectedColorText: 'графит-меланж' })
      .expect(200);
    const updated = ok.body.materialRequirements.find(
      (r: { id: string }) => r.id === orderSelected.id,
    );
    expect(updated.selectedColorText).toBe('графит-меланж');
    expect(updated.resolvedColorText).toBe('графит-меланж');

    // Попытка сохранить цвет по ORDER_COLOR-строке → 409.
    // Бизнес-инвариант: HTTP-статус и body.statusCode должны
    // совпадать (раньше тут был BadRequestException с body.statusCode = 409,
    // т.е. фронт получал HTTP 400 + body.statusCode 409 — теперь
    // оба = 409, см. `OrderMaterialRequirementColorNotRequiredException`).
    const denied = await request(t.app.getHttpServer())
      .patch(
        `/api/orders/${orderId}/material-requirements/${fabric.id}/color`,
      )
      .set('Cookie', cookies.manager)
      .send({ selectedColorText: 'синий' });
    expect(denied.status).toBe(409);
    expect(denied.body.statusCode).toBe(409);
    expect(denied.body.code).toBe(
      'ORDER_MATERIAL_REQUIREMENT_COLOR_NOT_REQUIRED',
    );

    // Стереть цвет — null.
    const cleared = await request(t.app.getHttpServer())
      .patch(
        `/api/orders/${orderId}/material-requirements/${orderSelected.id}/color`,
      )
      .set('Cookie', cookies.manager)
      .send({ selectedColorText: '' })
      .expect(200);
    const clearedReq = cleared.body.materialRequirements.find(
      (r: { id: string }) => r.id === orderSelected.id,
    );
    expect(clearedReq.selectedColorText).toBeNull();
    expect(clearedReq.resolvedColorText).toBeNull();
  });

  test('E2a. ORDER_COLOR / FIXED_COLOR / NO_COLOR: snapshot сразу резолвит цвет, ORDER_SELECTED_COLOR — нет', async () => {
    const tc = await createTechCard(t, cookies.manager, {
      code: 'TC-COLOR-RULES',
      name: 'Все правила цвета',
      materialLines: [
        {
          name: 'Кулирка',
          unit: 'м',
          qtyPerUnit: '0.5',
          materialRole: 'MAIN_FABRIC',
          colorRule: 'ORDER_COLOR',
        },
        {
          name: 'Подклад чёрный',
          unit: 'м',
          qtyPerUnit: '0.3',
          materialRole: 'LINING',
          colorRule: 'FIXED_COLOR',
          fixedColorText: 'чёрный',
        },
        {
          name: 'Тесьма',
          unit: 'м',
          qtyPerUnit: '0.1',
          materialRole: 'PACKAGING',
          colorRule: 'NO_COLOR',
        },
        {
          name: 'Молния',
          unit: 'шт',
          qtyPerUnit: '1',
          materialRole: 'PACKAGING',
          colorRule: 'ORDER_SELECTED_COLOR',
        },
      ],
    });
    const create = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookies.manager)
      .send({
        orderDate: '2026-04-15T00:00:00.000Z',
        productId: seed.product.id,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 1 }],
        techCardId: tc.id,
        color: 'Чёрный',
      })
      .expect(201);
    const reqs = create.body.materialRequirements as Array<{
      name: string;
      colorRule: string;
      requiresColorSelection: boolean;
      selectedColorText: string | null;
      resolvedColorText: string | null;
    }>;
    const byName = (n: string) => reqs.find((r) => r.name === n)!;
    // Цвет нормализуется в нижний регистр (`normalizeColorOrNull`) — см. фикс
    // дрейфа balanceKey «Белый» vs «белый».
    expect(byName('Кулирка').resolvedColorText).toBe('чёрный');
    expect(byName('Кулирка').requiresColorSelection).toBe(false);
    expect(byName('Подклад чёрный').resolvedColorText).toBe('чёрный');
    expect(byName('Подклад чёрный').requiresColorSelection).toBe(false);
    expect(byName('Тесьма').resolvedColorText).toBeNull();
    expect(byName('Тесьма').requiresColorSelection).toBe(false);
    expect(byName('Молния').resolvedColorText).toBeNull();
    expect(byName('Молния').requiresColorSelection).toBe(true);
    expect(byName('Молния').selectedColorText).toBeNull();
  });

  test('E2b. PATCH Order.color синхронизирует ORDER_COLOR.resolvedColorText, ORDER_SELECTED_COLOR не трогает selectedColorText', async () => {
    const tc = await createTechCard(t, cookies.manager, {
      code: 'TC-PATCH-COLOR',
      name: 'PATCH цвета заказа',
      materialLines: [
        {
          name: 'Кулирка',
          unit: 'м',
          qtyPerUnit: '0.5',
          materialRole: 'MAIN_FABRIC',
          colorRule: 'ORDER_COLOR',
        },
        {
          name: 'Молния',
          unit: 'шт',
          qtyPerUnit: '1',
          materialRole: 'PACKAGING',
          colorRule: 'ORDER_SELECTED_COLOR',
        },
      ],
    });
    const create = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookies.manager)
      .send({
        orderDate: '2026-04-15T00:00:00.000Z',
        productId: seed.product.id,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 1 }],
        techCardId: tc.id,
        color: 'Синий',
      })
      .expect(201);
    const orderId = create.body.id as string;
    // Заранее сохранили цвет по «Молния».
    const fabric = create.body.materialRequirements.find(
      (r: { name: string }) => r.name === 'Молния',
    );
    await request(t.app.getHttpServer())
      .patch(
        `/api/orders/${orderId}/material-requirements/${fabric.id}/color`,
      )
      .set('Cookie', cookies.manager)
      .send({ selectedColorText: 'Бордо' })
      .expect(200);

    // Меняем общий цвет заказа.
    const patched = await request(t.app.getHttpServer())
      .patch(`/api/orders/${orderId}`)
      .set('Cookie', cookies.manager)
      .send({ color: 'Зелёный' })
      .expect(200);
    const fabrics = patched.body.materialRequirements as Array<{
      name: string;
      resolvedColorText: string | null;
      selectedColorText: string | null;
    }>;
    const main = fabrics.find((r) => r.name === 'Кулирка')!;
    const zipper = fabrics.find((r) => r.name === 'Молния')!;
    // ORDER_COLOR следует за новым Order.color.
    expect(main.resolvedColorText).toBe('зелёный');
    // ORDER_SELECTED_COLOR не теряет введённое значение.
    expect(zipper.selectedColorText).toBe('бордо');
    expect(zipper.resolvedColorText).toBe('бордо');
  });

  test('E2c. start() переиспользует snapshot и сохраняет selectedColorText', async () => {
    const tc = await createTechCard(t, cookies.manager, {
      code: 'TC-START-PRESERVE',
      name: 'start() сохраняет цвет',
      materialLines: [
        {
          name: 'Молния',
          unit: 'шт',
          qtyPerUnit: '1',
          materialRole: 'PACKAGING',
          colorRule: 'ORDER_SELECTED_COLOR',
        },
      ],
    });
    const orderId = await createOrderWithTechCard(
      t,
      seed,
      cookies.manager,
      [{ sizeId: seed.sizes.M, qtyPlan: 2 }],
      tc.id,
    );
    const draft = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    const reqId = draft.body.materialRequirements[0].id as string;
    await request(t.app.getHttpServer())
      .patch(`/api/orders/${orderId}/material-requirements/${reqId}/color`)
      .set('Cookie', cookies.manager)
      .send({ selectedColorText: 'Бордо' })
      .expect(200);

    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start`)
      .set('Cookie', cookies.manager)
      .expect(201);

    const after = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(after.body.status).toBe('IN_PRODUCTION');
    const req = after.body.materialRequirements[0];
    // start() не пересоздаёт snapshot — введённый цвет уцелел.
    expect(req.selectedColorText).toBe('бордо');
    expect(req.resolvedColorText).toBe('бордо');
    expect(req.requiresColorSelection).toBe(true);
  });

  test('E3. POST tech-card с невалидной materialRole → 400 TECH_CARD_MATERIAL_ROLE_INVALID', async () => {
    const r = await request(t.app.getHttpServer())
      .post('/api/tech-cards')
      .set('Cookie', cookies.manager)
      .send({
        code: 'TC-BAD-ROLE',
        name: 'Bad role',
        materialLines: [
          {
            name: 'X',
            unit: 'м',
            qtyPerUnit: '1',
            materialRole: 'NOT_A_REAL_ROLE',
          },
        ],
      });
    expect(r.status).toBe(400);
    // Может прийти как ZodValidationPipe (regex), либо как наш
    // `TECH_CARD_MATERIAL_ROLE_INVALID` (кастомный whitelist).
    // Регэкспом покрываем оба варианта.
    expect(r.body.message).toMatch(
      /roleKey|TECH_CARD_MATERIAL_ROLE_INVALID|роль материала/i,
    );
  });

  // ---------------------------------------------------------------------------
  // Этап «Доработка контракта» (см. ТЗ §1, §3, §5, §7): подтягивание
  // строк техкарты из конкретной номенклатуры (PatternItemParameterNorm),
  // dedupe по materialRole + fabricType, image upload, очистка
  // densityGsm/plannedWidthCm для PACKAGING.
  // ---------------------------------------------------------------------------

  test('F1. Несколько PACKAGING строк сохраняются (Молния + Люверсы) — нет «одна роль = одна строка»', async () => {
    const r = await request(t.app.getHttpServer())
      .post('/api/tech-cards')
      .set('Cookie', cookies.manager)
      .send({
        code: 'TC-MULTI-PACKAGING',
        name: 'Несколько фурнитур',
        materialLines: [
          {
            name: 'Молния',
            unit: 'шт',
            qtyPerUnit: '1',
            materialRole: 'PACKAGING',
            fabricType: 'Молния',
            hardwareSizeText: '60 см',
            hardwareMaterialText: 'пластик',
            colorRule: 'ORDER_SELECTED_COLOR',
          },
          {
            name: 'Люверсы',
            unit: 'шт',
            qtyPerUnit: '4',
            materialRole: 'PACKAGING',
            fabricType: 'Люверсы',
            hardwareSizeText: '8 мм',
            hardwareMaterialText: 'металл',
            colorRule: 'NO_COLOR',
          },
        ],
      })
      .expect(201);
    expect(r.body.materialLines).toHaveLength(2);
    const roles = r.body.materialLines.map(
      (l: { materialRole: string }) => l.materialRole,
    );
    // Обе строки PACKAGING — разрешено (см. ТЗ §3, §6).
    expect(roles).toEqual(['PACKAGING', 'PACKAGING']);
    const fabrics = r.body.materialLines.map(
      (l: { fabricType: string }) => l.fabricType,
    );
    expect(fabrics).toEqual(['Молния', 'Люверсы']);
  });

  test('F2. PACKAGING строка зачищает densityGsm/plannedWidthCm (см. ТЗ §7)', async () => {
    const r = await request(t.app.getHttpServer())
      .post('/api/tech-cards')
      .set('Cookie', cookies.manager)
      .send({
        code: 'TC-PACKAGING-CLEAN',
        name: 'PACKAGING очищает density',
        materialLines: [
          {
            name: 'Молния',
            unit: 'шт',
            qtyPerUnit: '1',
            materialRole: 'PACKAGING',
            fabricType: 'Молния',
            // Пытаемся передать density/width — backend должен их зачистить.
            densityGsm: 180,
            plannedWidthCm: 150,
            hardwareSizeText: '60 см',
          },
          {
            name: 'Кулирка',
            unit: 'м',
            qtyPerUnit: '0.5',
            materialRole: 'MAIN_FABRIC',
            fabricType: 'кулирка',
            densityGsm: 180,
            plannedWidthCm: 150,
          },
        ],
      })
      .expect(201);
    const packaging = r.body.materialLines.find(
      (l: { materialRole: string }) => l.materialRole === 'PACKAGING',
    );
    const fabric = r.body.materialLines.find(
      (l: { materialRole: string }) => l.materialRole === 'MAIN_FABRIC',
    );
    // PACKAGING — null/null, MAIN_FABRIC — сохранены как есть.
    expect(packaging.densityGsm).toBeNull();
    expect(packaging.plannedWidthCm).toBeNull();
    expect(fabric.densityGsm).toBe(180);
    expect(fabric.plannedWidthCm).toBe(150);
  });

  test('F3. POST /:id/material-lines/:lineId/image — upload PNG/JPG сохраняет materialImageUrl', async () => {
    const tc = await createTechCard(t, cookies.manager, {
      code: 'TC-IMG-UPLOAD',
      name: 'Image upload',
      materialLines: [
        {
          name: 'Молния',
          unit: 'шт',
          qtyPerUnit: '1',
          materialRole: 'PACKAGING',
        },
      ],
    });
    // Получим lineId после save.
    const detail = await request(t.app.getHttpServer())
      .get(`/api/tech-cards/${tc.id}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    const lineId = detail.body.materialLines[0].id as string;

    // Минимальный валидный PNG-блоб (8-байтовая сигнатура + 1 пиксель).
    // Содержимое неважно — сервис проверяет расширение/размер, не парсит.
    const pngBytes = Buffer.from('89504e470d0a1a0a' + '00'.repeat(70), 'hex');
    const ok = await request(t.app.getHttpServer())
      .post(`/api/tech-cards/${tc.id}/material-lines/${lineId}/image`)
      .set('Cookie', cookies.manager)
      .attach('file', pngBytes, { filename: 'molnia.png', contentType: 'image/png' })
      .expect(201);
    const uploaded = ok.body.materialLines.find(
      (l: { id: string }) => l.id === lineId,
    );
    expect(uploaded.materialImageUrl).toMatch(
      new RegExp(`^/uploads/tech-cards/${tc.id}/materials/${lineId}/`),
    );
    expect(uploaded.materialImageOriginalFileName).toBe('molnia.png');

    // Повторный GET даёт те же поля.
    const refetched = await request(t.app.getHttpServer())
      .get(`/api/tech-cards/${tc.id}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    const after = refetched.body.materialLines.find(
      (l: { id: string }) => l.id === lineId,
    );
    expect(after.materialImageUrl).toBe(uploaded.materialImageUrl);
    expect(after.materialImageOriginalFileName).toBe('molnia.png');

    // SVG отвергается.
    const svg = Buffer.from('<svg/>', 'utf8');
    const bad = await request(t.app.getHttpServer())
      .post(`/api/tech-cards/${tc.id}/material-lines/${lineId}/image`)
      .set('Cookie', cookies.manager)
      .attach('file', svg, { filename: 'logo.svg', contentType: 'image/svg+xml' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('TECH_CARD_IMAGE_UPLOAD_INVALID');

    // TXT отвергается.
    const txt = Buffer.from('hello', 'utf8');
    const bad2 = await request(t.app.getHttpServer())
      .post(`/api/tech-cards/${tc.id}/material-lines/${lineId}/image`)
      .set('Cookie', cookies.manager)
      .attach('file', txt, { filename: 'note.txt', contentType: 'text/plain' });
    expect(bad2.status).toBe(400);
    expect(bad2.body.code).toBe('TECH_CARD_IMAGE_UPLOAD_INVALID');

    // Чужой/несуществующий lineId — 404.
    const notFound = await request(t.app.getHttpServer())
      .post(`/api/tech-cards/${tc.id}/material-lines/no-such-line/image`)
      .set('Cookie', cookies.manager)
      .attach('file', pngBytes, { filename: 'x.png', contentType: 'image/png' });
    expect(notFound.status).toBe(404);
    expect(notFound.body.code).toBe('TECH_CARD_MATERIAL_LINE_NOT_FOUND');

    // Без файла → 400.
    const empty = await request(t.app.getHttpServer())
      .post(`/api/tech-cards/${tc.id}/material-lines/${lineId}/image`)
      .set('Cookie', cookies.manager);
    expect(empty.status).toBe(400);
    expect(empty.body.code).toBe('TECH_CARD_IMAGE_UPLOAD_MISSING_FILE');
  });

  test('F4. Подтягивание из номенклатуры — DTO отдаёт parameterNorms, фронт фильтрует qtyPerItem > 0', async () => {
    // Создаём категорию с PACKAGING-параметрами и FILLER QTY_PER_ITEM.
    const cat = await request(t.app.getHttpServer())
      .post('/api/pattern-categories')
      .set('Cookie', cookies.manager)
      .send({
        name: `Куртка для пуллинга ${Date.now()}`,
        iconKey: 'HOODIE',
        parameters: [
          {
            roleKey: 'PACKAGING',
            label: 'Молния',
            inputType: 'QTY_PER_ITEM',
            unit: 'шт',
          },
          {
            roleKey: 'PACKAGING',
            label: 'Кнопки',
            inputType: 'QTY_PER_ITEM',
            unit: 'шт',
          },
          {
            roleKey: 'PACKAGING',
            label: 'Люверсы',
            inputType: 'QTY_PER_ITEM',
            unit: 'шт',
          },
          {
            roleKey: 'FILLER',
            label: 'Искусственный пух',
            inputType: 'QTY_PER_ITEM',
            unit: 'г',
          },
        ],
      })
      .expect(201);
    const params = cat.body.parameters as Array<{
      id: string;
      label: string;
      roleKey: string;
    }>;
    const findId = (label: string) =>
      params.find((p) => p.label === label)!.id;

    const pattern = await request(t.app.getHttpServer())
      .post('/api/patterns')
      .set('Cookie', cookies.manager)
      .send({
        name: 'Куртка для пуллинга',
        article: `JKT-PULL-${Date.now()}`,
        categoryId: cat.body.id,
      })
      .expect(201);
    const patternId = pattern.body.id as string;

    // Заполняем нормы: только Молния=1, Люверсы=4. Кнопки и
    // Искусственный пух остаются без нормы.
    await request(t.app.getHttpServer())
      .put(`/api/patterns/${patternId}/parameter-norms`)
      .set('Cookie', cookies.manager)
      .send({
        norms: [
          { categoryParameterId: findId('Молния'), qtyPerItem: '1' },
          { categoryParameterId: findId('Люверсы'), qtyPerItem: '4' },
        ],
      })
      .expect(200);

    // GET /api/patterns/:id отдаёт parameterNorms — это ровно то,
    // на что опирается server action `pullMaterialLinesFromPatternAction`.
    const got = await request(t.app.getHttpServer())
      .get(`/api/patterns/${patternId}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    const norms = got.body.parameterNorms as Array<{
      labelSnapshot: string;
      roleKey: string;
      qtyPerItem: string;
    }>;
    // Молния и Люверсы есть; Кнопки и Искусственный пух — нет.
    const labels = norms.map((n) => n.labelSnapshot).sort();
    expect(labels).toEqual(['Люверсы', 'Молния']);
    expect(labels).not.toContain('Кнопки');
    expect(labels).not.toContain('Искусственный пух');
    for (const n of norms) {
      expect(Number(n.qtyPerItem)).toBeGreaterThan(0);
    }
    // Все возвращённые нормы — PACKAGING (FILLER без нормы не попал).
    for (const n of norms) {
      expect(n.roleKey).toBe('PACKAGING');
    }
  });

  // ---------------------------------------------------------------------------
  // Этап «Подтянуть из номенклатуры + погонные метры» (см. ТЗ §1, §2, §3, §8):
  // расширение F4 — теперь action `pullMaterialLinesFromPatternAction`
  // тянет два источника:
  //   A) `PatternItemParameterNorm`         (qtyPerItem > 0);
  //   B) `PatternItemSizeParameterValue`    (LINEAR_M_BY_SIZE + value > 0,
  //      группировка по `categoryParameterId`).
  //
  // Action живёт в Next-приложении (`apps/web/.../actions.ts`) и
  // импортирует `getPattern(...)` через HTTP-клиент. Поэтому здесь
  // мы покрываем КОНТРАКТ DTO `GET /api/patterns/:id`, который этот
  // action потребляет — а саму JS-логику фильтрации/группировки
  // покрывает smoke-тест `tests/smoke/admin-tech-card-ui.smoke.test.ts`.
  // ---------------------------------------------------------------------------

  test('F5. Сценарий 1: норма + LINEAR_M_BY_SIZE с заполненными значениями — DTO отдаёт оба источника', async () => {
    // Категория из примера ТЗ §8 «Сценарий 1»:
    //   - MAIN_FABRIC / Основное полотно / LINEAR_M_BY_SIZE
    //   - LINING / Подкладка / LINEAR_M_BY_SIZE
    //   - INTERLINING / Дублерин / LINEAR_M_BY_SIZE
    //   - FILLER / Флизелин / LINEAR_M_BY_SIZE  (НЕ заполнен → не попадает)
    //   - PACKAGING / Молния / QTY_PER_ITEM     (заполнен → попадает)
    //   - PACKAGING / Кнопки / QTY_PER_ITEM     (НЕ заполнен → не попадает)
    const cat = await request(t.app.getHttpServer())
      .post('/api/pattern-categories')
      .set('Cookie', cookies.manager)
      .send({
        name: `Куртка-сценарий-1 ${Date.now()}`,
        iconKey: 'HOODIE',
        parameters: [
          {
            roleKey: 'MAIN_FABRIC',
            label: 'Основное полотно',
            inputType: 'LINEAR_M_BY_SIZE',
            unit: 'м пог.',
          },
          {
            roleKey: 'LINING',
            label: 'Подкладка',
            inputType: 'LINEAR_M_BY_SIZE',
            unit: 'м пог.',
          },
          {
            roleKey: 'INTERLINING',
            label: 'Дублерин',
            inputType: 'LINEAR_M_BY_SIZE',
            unit: 'м пог.',
          },
          {
            roleKey: 'FILLER',
            label: 'Флизелин',
            inputType: 'LINEAR_M_BY_SIZE',
            unit: 'м пог.',
          },
          {
            roleKey: 'PACKAGING',
            label: 'Молния',
            inputType: 'QTY_PER_ITEM',
            unit: 'шт',
          },
          {
            roleKey: 'PACKAGING',
            label: 'Кнопки',
            inputType: 'QTY_PER_ITEM',
            unit: 'шт',
          },
        ],
      })
      .expect(201);
    const params = cat.body.parameters as Array<{
      id: string;
      label: string;
      roleKey: string;
      inputType: string;
    }>;
    const findId = (label: string) =>
      params.find((p) => p.label === label)!.id;

    const pat = await request(t.app.getHttpServer())
      .post('/api/patterns')
      .set('Cookie', cookies.manager)
      .send({
        name: 'Куртка',
        article: `JKT-S1-${Date.now()}`,
        categoryId: cat.body.id,
      })
      .expect(201);
    const patternId = pat.body.id as string;

    // Активный размер M (хотя бы один — иначе значения бессмысленны).
    await t.prisma.patternSizeFile.create({
      data: {
        patternItemId: patternId,
        sizeId: seed.sizes.M,
        fileUrl: `/uploads/patterns/${patternId}/sizes/${seed.sizes.M}/test.dxf`,
        originalFileName: 'test.dxf',
        version: 1,
        status: 'ACTIVE',
      },
    });

    // Норма «Молния» = 1 (Кнопки оставляем без нормы).
    await request(t.app.getHttpServer())
      .put(`/api/patterns/${patternId}/parameter-norms`)
      .set('Cookie', cookies.manager)
      .send({
        norms: [{ categoryParameterId: findId('Молния'), qtyPerItem: '1' }],
      })
      .expect(200);

    // Погонные метры по размерам: Основное полотно=1.2, Подкладка=1,
    // Дублерин=0.2 (Флизелин — ничего, остаётся без значений).
    await request(t.app.getHttpServer())
      .put(`/api/patterns/${patternId}/size-parameter-values`)
      .set('Cookie', cookies.manager)
      .send({
        values: [
          {
            categoryParameterId: findId('Основное полотно'),
            sizeId: seed.sizes.M,
            value: '1.2',
          },
          {
            categoryParameterId: findId('Подкладка'),
            sizeId: seed.sizes.M,
            value: '1',
          },
          {
            categoryParameterId: findId('Дублерин'),
            sizeId: seed.sizes.M,
            value: '0.2',
          },
        ],
      })
      .expect(200);

    // GET /api/patterns/:id — DTO, на которое смотрит action.
    const got = await request(t.app.getHttpServer())
      .get(`/api/patterns/${patternId}`)
      .set('Cookie', cookies.manager)
      .expect(200);

    // Источник A: parameterNorms — только Молния (Кнопки без нормы).
    const norms = got.body.parameterNorms as Array<{
      labelSnapshot: string;
      qtyPerItem: string;
    }>;
    expect(norms.map((n) => n.labelSnapshot)).toEqual(['Молния']);
    expect(Number(norms[0]!.qtyPerItem)).toBeGreaterThan(0);

    // Источник B: sizeParameterValues — три заполненных параметра
    // (Флизелин — пустой, в DTO его нет).
    const values = got.body.sizeParameterValues as Array<{
      categoryParameterId: string;
      sizeId: string;
      labelSnapshot: string;
      inputTypeSnapshot: string;
      value: string;
    }>;
    const valueLabels = values.map((v) => v.labelSnapshot).sort();
    expect(valueLabels).toEqual(['Дублерин', 'Основное полотно', 'Подкладка']);
    expect(valueLabels).not.toContain('Флизелин');
    for (const v of values) {
      expect(v.inputTypeSnapshot).toBe('LINEAR_M_BY_SIZE');
      expect(Number(v.value)).toBeGreaterThan(0);
    }

    // Применяем чисто JS-логику action-а к этому DTO (контракт
    // выходных шаблонов). Реализация action-а живёт в `apps/web` и
    // делает то же самое — здесь сверяем итоговый набор шаблонов,
    // который попадёт в форму, с ожиданиями ТЗ §8 «Сценарий 1»:
    //   - MAIN_FABRIC / Основное полотно
    //   - LINING / Подкладка
    //   - INTERLINING / Дублерин
    //   - PACKAGING / Молния
    const templates = pullTemplatesFromPatternDto({
      parameterNorms: norms.map((n) => ({
        roleKey: (n as unknown as { roleKey: string }).roleKey,
        labelSnapshot: n.labelSnapshot,
        unit: (n as unknown as { unit: string }).unit,
        qtyPerItem: n.qtyPerItem,
        id: (n as unknown as { id: string }).id,
      })),
      sizeParameterValues: values.map((v) => ({
        categoryParameterId: v.categoryParameterId,
        roleKey: (v as unknown as { roleKey: string }).roleKey,
        labelSnapshot: v.labelSnapshot,
        unit: (v as unknown as { unit: string }).unit,
        inputTypeSnapshot: v.inputTypeSnapshot,
        value: v.value,
      })),
    });
    const got1 = templates
      .map((tpl) => `${tpl.roleKey}/${tpl.labelSnapshot}`)
      .sort();
    expect(got1).toEqual(
      [
        'INTERLINING/Дублерин',
        'LINING/Подкладка',
        'MAIN_FABRIC/Основное полотно',
        'PACKAGING/Молния',
      ].sort(),
    );
    // Нет Кнопок и нет Флизелина.
    expect(got1.find((s) => s.includes('Кнопки'))).toBeUndefined();
    expect(got1.find((s) => s.includes('Флизелин'))).toBeUndefined();
    // Источники различаются и проставляются корректно.
    const bySource = new Map(templates.map((tpl) => [tpl.labelSnapshot, tpl.sourceType]));
    expect(bySource.get('Молния')).toBe('PARAMETER_NORM');
    expect(bySource.get('Основное полотно')).toBe('SIZE_PARAMETER_VALUE');
    expect(bySource.get('Подкладка')).toBe('SIZE_PARAMETER_VALUE');
    expect(bySource.get('Дублерин')).toBe('SIZE_PARAMETER_VALUE');
  });

  test('F6. Сценарий 2: все sizeParameterValues пустые — LINEAR_M_BY_SIZE строки не возвращаются', async () => {
    const cat = await request(t.app.getHttpServer())
      .post('/api/pattern-categories')
      .set('Cookie', cookies.manager)
      .send({
        name: `Сценарий-2 ${Date.now()}`,
        iconKey: 'SHIRT',
        parameters: [
          {
            roleKey: 'MAIN_FABRIC',
            label: 'Основное полотно',
            inputType: 'LINEAR_M_BY_SIZE',
            unit: 'м пог.',
          },
          {
            roleKey: 'LINING',
            label: 'Подкладка',
            inputType: 'LINEAR_M_BY_SIZE',
            unit: 'м пог.',
          },
        ],
      })
      .expect(201);
    const pat = await request(t.app.getHttpServer())
      .post('/api/patterns')
      .set('Cookie', cookies.manager)
      .send({
        name: 'Сценарий 2',
        article: `S2-${Date.now()}`,
        categoryId: cat.body.id,
      })
      .expect(201);
    const patternId = pat.body.id as string;

    // Никаких значений по погонным метрам не сохраняем (пустой PUT
    // = «очистить»). Backend не падает.
    await request(t.app.getHttpServer())
      .put(`/api/patterns/${patternId}/size-parameter-values`)
      .set('Cookie', cookies.manager)
      .send({ values: [] })
      .expect(200);

    const got = await request(t.app.getHttpServer())
      .get(`/api/patterns/${patternId}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(got.body.sizeParameterValues).toEqual([]);

    const templates = pullTemplatesFromPatternDto({
      parameterNorms: [],
      sizeParameterValues: [],
    });
    expect(templates).toEqual([]);
  });

  test('F7. Сценарий 3: один параметр с значениями по нескольким размерам → одна шаблонная строка', async () => {
    // ТЗ §8 «Сценарий 3»: «Несколько значений одного categoryParameterId
    // по разным размерам → одна template line на parameter, а не
    // строка на каждый размер».
    const cat = await request(t.app.getHttpServer())
      .post('/api/pattern-categories')
      .set('Cookie', cookies.manager)
      .send({
        name: `Сценарий-3 ${Date.now()}`,
        iconKey: 'SHIRT',
        parameters: [
          {
            roleKey: 'MAIN_FABRIC',
            label: 'Основное полотно',
            inputType: 'LINEAR_M_BY_SIZE',
            unit: 'м пог.',
          },
        ],
      })
      .expect(201);
    const params = cat.body.parameters as Array<{ id: string; label: string }>;
    const mainId = params.find((p) => p.label === 'Основное полотно')!.id;

    const pat = await request(t.app.getHttpServer())
      .post('/api/patterns')
      .set('Cookie', cookies.manager)
      .send({
        name: 'Сценарий 3',
        article: `S3-${Date.now()}`,
        categoryId: cat.body.id,
      })
      .expect(201);
    const patternId = pat.body.id as string;

    // Заполняем по двум размерам.
    await request(t.app.getHttpServer())
      .put(`/api/patterns/${patternId}/size-parameter-values`)
      .set('Cookie', cookies.manager)
      .send({
        values: [
          { categoryParameterId: mainId, sizeId: seed.sizes.M, value: '1.2' },
          { categoryParameterId: mainId, sizeId: seed.sizes.L, value: '1.4' },
        ],
      })
      .expect(200);

    const got = await request(t.app.getHttpServer())
      .get(`/api/patterns/${patternId}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    const values = got.body.sizeParameterValues as Array<{
      categoryParameterId: string;
      labelSnapshot: string;
      inputTypeSnapshot: string;
      value: string;
      roleKey: string;
      unit: string;
    }>;
    // В DTO их два (по размерам), в шаблонах — один (группировка).
    expect(values).toHaveLength(2);

    const templates = pullTemplatesFromPatternDto({
      parameterNorms: [],
      sizeParameterValues: values.map((v) => ({
        categoryParameterId: v.categoryParameterId,
        roleKey: v.roleKey,
        labelSnapshot: v.labelSnapshot,
        unit: v.unit,
        inputTypeSnapshot: v.inputTypeSnapshot,
        value: v.value,
      })),
    });
    expect(templates).toHaveLength(1);
    expect(templates[0]!.labelSnapshot).toBe('Основное полотно');
    expect(templates[0]!.roleKey).toBe('MAIN_FABRIC');
    expect(templates[0]!.sourceType).toBe('SIZE_PARAMETER_VALUE');
    // sourceId = categoryParameterId (а не один из v.id).
    expect(templates[0]!.sourceId).toBe(mainId);
  });

  test('F8. Сценарий 4: форма техкарты сохраняет несколько PACKAGING строк с разным fabricType', async () => {
    // Это уже покрыто F1, но повторяем явно с привязкой к
    // сценарию ТЗ §8 «Сценарий 4»: «Форма техкарты сохраняет
    // несколько PACKAGING строк». Без него acceptance criteria 9
    // («Несколько PACKAGING строк разрешены») остаётся неявным.
    const r = await request(t.app.getHttpServer())
      .post('/api/tech-cards')
      .set('Cookie', cookies.manager)
      .send({
        code: `TC-MULTI-PKG-${Date.now()}`,
        name: 'Несколько PACKAGING после pull',
        materialLines: [
          {
            name: 'Молния',
            unit: 'шт',
            qtyPerUnit: '1',
            materialRole: 'PACKAGING',
            fabricType: 'Молния',
            colorRule: 'ORDER_SELECTED_COLOR',
          },
          {
            name: 'Кнопки',
            unit: 'шт',
            qtyPerUnit: '6',
            materialRole: 'PACKAGING',
            fabricType: 'Кнопки',
            colorRule: 'ORDER_SELECTED_COLOR',
          },
          {
            name: 'Люверсы',
            unit: 'шт',
            qtyPerUnit: '4',
            materialRole: 'PACKAGING',
            fabricType: 'Люверсы',
            colorRule: 'NO_COLOR',
          },
        ],
      })
      .expect(201);
    expect(r.body.materialLines).toHaveLength(3);
    expect(
      r.body.materialLines.map((l: { fabricType: string }) => l.fabricType),
    ).toEqual(['Молния', 'Кнопки', 'Люверсы']);
    // Все три — PACKAGING, dedupe по fabricType разрешает.
    for (const l of r.body.materialLines as Array<{ materialRole: string }>) {
      expect(l.materialRole).toBe('PACKAGING');
    }
  });

  test('F9. Сценарий 5: existing line с пустым fabricType + pull шаблон — апдейт, не дубль', async () => {
    // Чистая JS-логика dedupe-a в форме (см. ТЗ §3 правило 3).
    // Воспроизводим её мини-функцией, идентичной коду формы:
    //   - в массиве уже есть строка с materialRole='MAIN_FABRIC'
    //     и пустым fabricType;
    //   - подтягиваем шаблон { roleKey: 'MAIN_FABRIC', labelSnapshot:
    //     'Основное полотно' };
    //   - ожидание: одна строка, fabricType заполнен из шаблона.
    type Row = { materialRole: string; fabricType: string };
    const existing: Row[] = [{ materialRole: 'MAIN_FABRIC', fabricType: '' }];
    const templates: Array<{ roleKey: string; labelSnapshot: string }> = [
      { roleKey: 'MAIN_FABRIC', labelSnapshot: 'Основное полотно' },
    ];
    const after = applyPullTemplates(existing, templates);
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0]).toEqual({
      materialRole: 'MAIN_FABRIC',
      fabricType: 'Основное полотно',
    });
    expect(after.added).toBe(0);
    expect(after.updated).toBe(1);
    expect(after.skipped).toBe(0);

    // А если у строки уже есть тот же fabricType — это полный дубль,
    // ничего не происходит.
    const existing2: Row[] = [
      { materialRole: 'MAIN_FABRIC', fabricType: 'Основное полотно' },
    ];
    const after2 = applyPullTemplates(existing2, templates);
    expect(after2.rows).toEqual(existing2);
    expect(after2.added).toBe(0);
    expect(after2.updated).toBe(0);
    expect(after2.skipped).toBe(1);

    // Если materialRole тот же, но fabricType другой — это новая
    // строка (например, для PACKAGING это разные позиции).
    const existing3: Row[] = [
      { materialRole: 'PACKAGING', fabricType: 'Молния' },
    ];
    const templates3 = [{ roleKey: 'PACKAGING', labelSnapshot: 'Люверсы' }];
    const after3 = applyPullTemplates(existing3, templates3);
    expect(after3.rows).toHaveLength(2);
    expect(after3.added).toBe(1);
    expect(after3.skipped).toBe(0);
    expect(after3.updated).toBe(0);
  });

  test('E4. PATCH tech-card сохраняет PACKAGING строку с hardware* (legacy materialRole APPLICATION тоже сохраняется)', async () => {
    // Создаём прямо в БД старую техкарту с APPLICATION (имитация
    // legacy-данных, которые до этого этапа были валидны).
    const tpl = await t.prisma.techCardTemplate.create({
      data: {
        code: 'TC-LEGACY',
        name: 'Legacy techcard',
        isActive: true,
        materialLines: {
          create: [
            {
              sortOrder: 10,
              name: 'Старое нанесение',
              unit: 'шт',
              qtyPerUnit: '1',
              materialRole: 'APPLICATION',
            },
          ],
        },
      },
      include: { materialLines: true },
    });
    expect(tpl.materialLines).toHaveLength(1);

    // PATCH с тем же APPLICATION (legacy) + новой PACKAGING строкой
    // не должен падать.
    const patch = await request(t.app.getHttpServer())
      .patch(`/api/tech-cards/${tpl.id}`)
      .set('Cookie', cookies.manager)
      .send({
        materialLines: [
          {
            name: 'Старое нанесение',
            unit: 'шт',
            qtyPerUnit: '1',
            materialRole: 'APPLICATION',
          },
          {
            name: 'Молния',
            unit: 'шт',
            qtyPerUnit: '1',
            materialRole: 'PACKAGING',
            hardwareSizeText: '50 см',
          },
        ],
      })
      .expect(200);
    expect(patch.body.materialLines).toHaveLength(2);
    expect(patch.body.materialLines[0].materialRole).toBe('APPLICATION');
    expect(patch.body.materialLines[1].materialRole).toBe('PACKAGING');
    expect(patch.body.materialLines[1].hardwareSizeText).toBe('50 см');
  });

  test('C. Snapshot independence: правка техкарты после start() не меняет старый snapshot', async () => {
    const tc = await createTechCard(t, cookies.manager, {
      code: 'TC-INDEP',
      name: 'Снапшот сам по себе',
      materialLines: [{ name: 'Старое имя', unit: 'м', qtyPerUnit: '2' }],
      outsourceLines: [{ name: 'OldOut', unit: 'шт', qtyPerUnit: '1' }],
    });
    const orderId = await createOrderWithTechCard(
      t,
      seed,
      cookies.manager,
      [{ sizeId: seed.sizes.M, qtyPlan: 4 }],
      tc.id,
    );
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start`)
      .set('Cookie', cookies.manager)
      .expect(201);

    const beforeEdit = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(beforeEdit.body.materialRequirements[0].name).toBe('Старое имя');
    expect(Number(beforeEdit.body.materialRequirements[0].totalQty)).toBeCloseTo(
      2 * 4,
      4,
    );

    // Полностью заменяем все строки, плюс деактивируем.
    await request(t.app.getHttpServer())
      .patch(`/api/tech-cards/${tc.id}`)
      .set('Cookie', cookies.manager)
      .send({
        isActive: false,
        materialLines: [{ name: 'Новое имя', unit: 'кг', qtyPerUnit: '0.99' }],
        outsourceLines: [],
      })
      .expect(200);

    const afterEdit = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    // Снапшот заказа — независимый, имена и totalQty НЕ меняются.
    expect(afterEdit.body.materialRequirements).toHaveLength(1);
    expect(afterEdit.body.materialRequirements[0].name).toBe('Старое имя');
    expect(Number(afterEdit.body.materialRequirements[0].totalQty)).toBeCloseTo(
      2 * 4,
      4,
    );
    expect(afterEdit.body.outsourceRequirements).toHaveLength(1);
    expect(afterEdit.body.outsourceRequirements[0].name).toBe('OldOut');
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
    isActive?: boolean;
    materialLines?: Array<{
      name: string;
      unit: string;
      qtyPerUnit: string;
      note?: string | null;
      materialRole?: string | null;
      colorRule?: string | null;
      fixedColorText?: string | null;
      hardwareSizeText?: string | null;
      hardwareMaterialText?: string | null;
      materialImageUrl?: string | null;
      materialImageOriginalFileName?: string | null;
    }>;
    outsourceLines?: Array<{
      name: string;
      unit?: string | null;
      qtyPerUnit?: string | null;
      vendorName?: string | null;
      note?: string | null;
      triggerType?: 'MANUAL' | 'CUT_READY';
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

async function createOrderWithTechCard(
  t: TestApp,
  seed: SeedResult,
  cookie: string,
  items: Array<{ sizeId: string; qtyPlan: number }>,
  techCardId: string,
): Promise<string> {
  const r = await request(t.app.getHttpServer())
    .post('/api/orders')
    .set('Cookie', cookie)
    .send({
      orderDate: '2026-04-15T00:00:00.000Z',
      productId: seed.product.id,
      items,
      techCardId,
    })
    .expect(201);
  return r.body.id;
}

// ===========================================================================
// helpers — pull-templates (повторяют JS-логику action-а в `apps/web`)
// ===========================================================================
//
// Action `pullMaterialLinesFromPatternAction` живёт в Next-приложении и
// потребляет DTO `GET /api/patterns/:id`. Чтобы не дёргать через HTTP
// сам Next-action в integration-тесте (он завязан на cookies/RSC), мы
// дублируем его pure-функциональную часть здесь и применяем к DTO,
// возвращённому реальным backend-ом. Любое расхождение поведения сразу
// же поймают smoke-тесты в `tests/smoke/admin-tech-card-ui.smoke.test.ts`,
// которые на source-уровне проверяют, что в action-е используются
// именно эти фильтры.

interface PullPatternNorm {
  id: string;
  roleKey: string;
  labelSnapshot: string;
  unit: string;
  qtyPerItem: string;
}
interface PullPatternSizeValue {
  categoryParameterId: string;
  roleKey: string;
  labelSnapshot: string;
  inputTypeSnapshot: string;
  unit: string;
  value: string;
}
interface PullTemplate {
  roleKey: string;
  labelSnapshot: string;
  unit: string;
  sourceType: 'PARAMETER_NORM' | 'SIZE_PARAMETER_VALUE';
  sourceId: string;
}

/**
 * Повторяет `pullMaterialLinesFromPatternAction` (без `getPattern` —
 * на вход уже DTO). См. `apps/web/app/admin/tech-cards/actions.ts`.
 *
 * Алгоритм (см. ТЗ §1, §2):
 *   - PARAMETER_NORM: пропускаем нормы с `qtyPerItem <= 0` /
 *     не-числовые.
 *   - SIZE_PARAMETER_VALUE: фильтруем `inputTypeSnapshot ===
 *     'LINEAR_M_BY_SIZE'`, группируем по `categoryParameterId`,
 *     оставляем только группы с хотя бы одним `value > 0`.
 */
function pullTemplatesFromPatternDto(input: {
  parameterNorms: PullPatternNorm[];
  sizeParameterValues: PullPatternSizeValue[];
}): PullTemplate[] {
  const out: PullTemplate[] = [];
  for (const n of input.parameterNorms) {
    const numeric = Number(n.qtyPerItem);
    if (!Number.isFinite(numeric) || numeric <= 0) continue;
    out.push({
      roleKey: n.roleKey,
      labelSnapshot: n.labelSnapshot,
      unit: n.unit,
      sourceType: 'PARAMETER_NORM',
      sourceId: n.id,
    });
  }
  const groups = new Map<
    string,
    { roleKey: string; labelSnapshot: string; unit: string; nonZero: boolean }
  >();
  for (const v of input.sizeParameterValues) {
    if (v.inputTypeSnapshot !== 'LINEAR_M_BY_SIZE') continue;
    const numeric = Number(v.value);
    const nz = Number.isFinite(numeric) && numeric > 0;
    const existing = groups.get(v.categoryParameterId);
    if (existing) {
      if (nz) existing.nonZero = true;
      continue;
    }
    groups.set(v.categoryParameterId, {
      roleKey: v.roleKey,
      labelSnapshot: v.labelSnapshot,
      unit: v.unit,
      nonZero: nz,
    });
  }
  for (const [categoryParameterId, g] of groups) {
    if (!g.nonZero) continue;
    out.push({
      roleKey: g.roleKey,
      labelSnapshot: g.labelSnapshot,
      unit: g.unit,
      sourceType: 'SIZE_PARAMETER_VALUE',
      sourceId: categoryParameterId,
    });
  }
  return out;
}

/**
 * Повторяет dedupe-логику `handlePullFromNomenclature` в форме (см.
 * `apps/web/.../tech-card-form.tsx`). Возвращает новое состояние строк
 * + счётчики «добавлено / обновлено / пропущено».
 *
 * Правила (ТЗ §3):
 *   1. Тот же roleKey + тот же fabricType → skipped.
 *   2. Тот же roleKey + пустой fabricType → updated (заполняем
 *      fabricType из шаблона).
 *   3. Иначе → added (новая строка).
 */
function applyPullTemplates(
  rowsIn: Array<{ materialRole: string; fabricType: string }>,
  templates: Array<{ roleKey: string; labelSnapshot: string }>,
): {
  rows: Array<{ materialRole: string; fabricType: string }>;
  added: number;
  updated: number;
  skipped: number;
} {
  const rows = rowsIn.map((r) => ({ ...r }));
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  let added = 0;
  let updated = 0;
  let skipped = 0;
  for (const tpl of templates) {
    const exact = rows.findIndex(
      (r) =>
        r.materialRole === tpl.roleKey &&
        norm(r.fabricType) === norm(tpl.labelSnapshot),
    );
    if (exact >= 0) {
      skipped += 1;
      continue;
    }
    const empty = rows.findIndex(
      (r) => r.materialRole === tpl.roleKey && norm(r.fabricType) === '',
    );
    if (empty >= 0) {
      rows[empty] = { ...rows[empty]!, fabricType: tpl.labelSnapshot };
      updated += 1;
      continue;
    }
    rows.push({ materialRole: tpl.roleKey, fabricType: tpl.labelSnapshot });
    added += 1;
  }
  return { rows, added, updated, skipped };
}
