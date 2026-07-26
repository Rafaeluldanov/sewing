/**
 * Integration-тесты модуля «Потребность цеха» (Workshop Needs, Этап 4А,
 * см. `apps/api/src/modules/workshop-needs/*`,
 * `prisma/schema.prisma::WorkshopNeed`,
 * `docs/recon-soft-integration.md §«Этап 4А»`).
 *
 * Покрытие (минимально достаточный contract-floor):
 *   1. AREA_DENSITY-формула: для строки техкарты с `materialRole +
 *      densityGsm`, при наличии `PatternMaterialArea` для роли,
 *      `calculatedQty = Σ(areaM2 × qtyPlan) × densityGsm / 1000`,
 *      `unit = "кг"`, `calculationMethod = AREA_DENSITY`.
 *   2. QTY_PER_UNIT-fallback: для строки без `materialRole`/`density`
 *      (нитки, фурнитура) — `qtyPerUnit × Σ qtyPlan`,
 *      `unit = line.unit`, `calculationMethod = QTY_PER_UNIT`.
 *   3. Заказ без `patternItemId` не падает: AREA_DENSITY невозможен,
 *      используется fallback + warning.
 *   4. Идемпотентность пересчёта: повторный POST без `force` оставляет
 *      `REVIEWED`/`PURCHASE_PLANNED` и возвращает `409
 *      WORKSHOP_NEEDS_ALREADY_REVIEWED`. С `force = true` всё
 *      перезатирается.
 *   5. Update / cancel: закупщик правит руками `purchaseQty` /
 *      `status` / supplier-поля; cancel-эндпоинт ставит
 *      `status = CANCELLED`.
 *   6. RBAC: рабочая роль (QC) → 403.
 *
 * Не проверяем здесь:
 *   - UI (sidebar / страницы) — это smoke-тесты;
 *   - аудит entry-by-entry — общий тест аудита живёт в
 *     `tests/integration/audit-log.test.ts`, тут смотрим только на
 *     один вызов как «дымовой».
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import { Prisma } from '@prisma/client';
import {
  loginAs,
  startTestApp,
  stopTestApp,
  type TestApp,
} from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

describeWithDb('integration — workshop needs (Этап 4А)', () => {
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
      qc: loginAs(t, seed.employees['qc']),
    };
  });

  // ---------------------------------------------------------------------------
  // 1. AREA_DENSITY: формула из ТЗ Этапа 4А (1.05 × 180 × 100 / 1000 = 18.9)
  // ---------------------------------------------------------------------------

  test('AREA_DENSITY: считает чистый вес ткани по лекалу + плотности', async () => {
    // Pattern: один materialRole MAIN_FABRIC, один размер M, areaM2 = 1.05
    const pattern = await t.prisma.patternItem.create({
      data: {
        name: 'Лекало демо',
        article: 'P-DEMO-1',
        status: 'ACTIVE',
        materialAreas: {
          create: [
            {
              sizeId: seed.sizes.M,
              materialRole: 'MAIN_FABRIC',
              areaM2: new Prisma.Decimal('1.05'),
            },
          ],
        },
      },
    });

    // TechCard: одна материальная строка с materialRole = MAIN_FABRIC,
    // densityGsm = 180. qtyPerUnit ставим, чтобы он НЕ использовался
    // (AREA_DENSITY должен победить).
    const tc = await createTechCard(t, cookies.manager, {
      code: 'TC-AD-1',
      name: 'AREA_DENSITY demo',
      materialLines: [
        {
          name: 'Кулирка',
          unit: 'м',
          qtyPerUnit: '0.55',
          materialRole: 'MAIN_FABRIC',
          fabricType: 'кулирка',
          densityGsm: 180,
          plannedWidthCm: 180,
          colorRule: 'ORDER_COLOR',
        },
      ],
    });

    // Order: 100 шт размера M, цвет «чёрный».
    const orderId = await createOrderWithPatternAndTechCard(
      t,
      seed,
      cookies.manager,
      {
        items: [{ sizeId: seed.sizes.M, qtyPlan: 100 }],
        techCardId: tc.id,
        patternItemId: pattern.id,
        color: 'чёрный',
      },
    );

    const r = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);

    expect(r.body.count).toBe(1);
    expect(r.body.methods.AREA_DENSITY).toBe(1);
    expect(r.body.methods.QTY_PER_UNIT).toBe(0);
    expect(r.body.warnings).toEqual([]);

    const need = r.body.needs[0];
    expect(need.calculationMethod).toBe('AREA_DENSITY');
    expect(need.unit).toBe('кг');
    expect(need.materialRole).toBe('MAIN_FABRIC');
    // 1.05 × 180 × 100 / 1000 = 18.9 (Decimal сериализуется строкой).
    expect(Number(need.calculatedQty)).toBeCloseTo(18.9, 4);
    // totalAreaM2 = 1.05 × 100 = 105
    expect(Number(need.totalAreaM2)).toBeCloseTo(105, 4);
    // ORDER_COLOR → resolvedColorText = order.color
    expect(need.resolvedColorText).toBe('чёрный');
    // description: «<fabricType> 180 г/м², чёрный, ширина 180 см».
    // `fabricType` идёт «как есть» — case-insensitive sanity check.
    expect(need.description.toLowerCase()).toContain('кулирка');
    expect(need.description).toContain('180 г/м²');
    expect(need.description).toContain('чёрный');
    expect(need.description).toContain('ширина 180 см');
    expect(need.status).toBe('CALCULATED');
    expect(need.purchaseQty).toBeNull();

    // GET /api/orders/:id/workshop-needs возвращает то же самое.
    const list = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}/workshop-needs`)
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].id).toBe(need.id);
  });

  // ---------------------------------------------------------------------------
  // 2. QTY_PER_UNIT fallback: нитки/фурнитура без materialRole+density
  // ---------------------------------------------------------------------------

  test('QTY_PER_UNIT: fallback для ниток/фурнитуры без materialRole+density', async () => {
    const tc = await createTechCard(t, cookies.manager, {
      code: 'TC-QPU-1',
      name: 'QTY_PER_UNIT demo',
      materialLines: [
        // Нитки: materialRole не задан, densityGsm не задан → fallback.
        { name: 'Нитки', unit: 'м', qtyPerUnit: '120' },
      ],
    });

    const orderId = await createOrderWithPatternAndTechCard(
      t,
      seed,
      cookies.manager,
      {
        items: [
          { sizeId: seed.sizes.M, qtyPlan: 50 },
          { sizeId: seed.sizes.L, qtyPlan: 30 },
        ],
        techCardId: tc.id,
        patternItemId: null, // без лекала
      },
    );

    const r = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);

    expect(r.body.count).toBe(1);
    expect(r.body.methods.AREA_DENSITY).toBe(0);
    expect(r.body.methods.QTY_PER_UNIT).toBe(1);

    const need = r.body.needs[0];
    expect(need.calculationMethod).toBe('QTY_PER_UNIT');
    expect(need.unit).toBe('м');
    // 120 × (50 + 30) = 9600
    expect(Number(need.calculatedQty)).toBeCloseTo(9600, 4);
    expect(need.totalAreaM2).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // 3. Заказ без PatternItem: AREA_DENSITY невозможен, fallback + warning
  // ---------------------------------------------------------------------------

  test('Заказ без лекала: AREA_DENSITY-строка падает в fallback с warning', async () => {
    const tc = await createTechCard(t, cookies.manager, {
      code: 'TC-NOPAT',
      name: 'Без лекала',
      materialLines: [
        {
          name: 'Кулирка',
          unit: 'м',
          qtyPerUnit: '0.55',
          materialRole: 'MAIN_FABRIC',
          fabricType: 'кулирка',
          densityGsm: 180,
          plannedWidthCm: 180,
          colorRule: 'ORDER_COLOR',
        },
      ],
    });

    const orderId = await createOrderWithPatternAndTechCard(
      t,
      seed,
      cookies.manager,
      {
        items: [{ sizeId: seed.sizes.M, qtyPlan: 10 }],
        techCardId: tc.id,
        patternItemId: null,
        color: 'чёрный',
      },
    );

    const r = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);

    expect(r.body.count).toBe(1);
    expect(r.body.methods.AREA_DENSITY).toBe(0);
    expect(r.body.methods.QTY_PER_UNIT).toBe(1);
    expect(r.body.warnings.length).toBeGreaterThanOrEqual(1);
    // Должно быть сообщение про отсутствие лекала.
    expect(r.body.warnings.some((w: string) => /лекал/iu.test(w))).toBe(true);

    const need = r.body.needs[0];
    expect(need.calculationMethod).toBe('QTY_PER_UNIT');
    // Fallback: 0.55 × 10 = 5.5
    expect(Number(need.calculatedQty)).toBeCloseTo(5.5, 4);
  });

  // ---------------------------------------------------------------------------
  // 4. Идемпотентность пересчёта
  // ---------------------------------------------------------------------------

  test('Пересчёт без force не сносит REVIEWED-строки (409 ALREADY_REVIEWED)', async () => {
    const orderId = await prepareSimpleQtyPerUnitOrder(t, seed, cookies.manager);

    // Первый расчёт.
    const first = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);
    expect(first.body.count).toBe(1);
    const firstNeed = first.body.needs[0];

    // Закупщик передвигает строку в REVIEWED.
    await request(t.app.getHttpServer())
      .patch(`/api/workshop-needs/${firstNeed.id}`)
      .set('Cookie', cookies.manager)
      .send({ status: 'REVIEWED', purchaseQty: '7.5' })
      .expect(200);

    // Повторный расчёт без force → 409 + RU-сообщение.
    const blocked = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(409);
    expect(blocked.body.code).toBe('WORKSHOP_NEEDS_ALREADY_REVIEWED');

    // REVIEWED-строка цела, purchaseQty не пропал.
    const stillThere = await request(t.app.getHttpServer())
      .get(`/api/workshop-needs/${firstNeed.id}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(stillThere.body.status).toBe('REVIEWED');
    expect(stillThere.body.purchaseQty).toBe('7.5');

    // С force: всё перезатирается, REVIEWED сносится.
    const forced = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', cookies.manager)
      .send({ force: true })
      .expect(201);
    expect(forced.body.count).toBe(1);
    expect(forced.body.force).toBe(true);
    // Старая запись должна исчезнуть; новая придёт со статусом CALCULATED.
    const gone = await request(t.app.getHttpServer())
      .get(`/api/workshop-needs/${firstNeed.id}`)
      .set('Cookie', cookies.manager);
    expect(gone.status).toBe(404);
  });

  test('Повторный пересчёт без force над только-CALCULATED — пересоздаёт', async () => {
    const orderId = await prepareSimpleQtyPerUnitOrder(t, seed, cookies.manager);
    const first = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);
    const firstId = first.body.needs[0].id;

    const second = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);
    expect(second.body.count).toBe(1);
    // Старая CALCULATED-строка исчезла.
    const gone = await request(t.app.getHttpServer())
      .get(`/api/workshop-needs/${firstId}`)
      .set('Cookie', cookies.manager);
    expect(gone.status).toBe(404);
  });

  // ---------------------------------------------------------------------------
  // 5. Update / cancel
  // ---------------------------------------------------------------------------

  test('PATCH /api/workshop-needs/:id — закупщик правит purchaseQty / supplier', async () => {
    const orderId = await prepareSimpleQtyPerUnitOrder(t, seed, cookies.manager);
    const calc = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);
    const needId = calc.body.needs[0].id;

    const patched = await request(t.app.getHttpServer())
      .patch(`/api/workshop-needs/${needId}`)
      .set('Cookie', cookies.manager)
      .send({
        purchaseQty: '12.5',
        status: 'PURCHASE_PLANNED',
        supplierNameText: 'ООО «Поставщик»',
        purchaseItemNameText: 'Кулирка чёрная, рулон 50 м',
        quotedPrice: '450.00',
        quotedCurrency: 'RUB',
        expectedDeliveryDate: '2026-05-01',
        comment: 'Привезут на склад к понедельнику',
      })
      .expect(200);
    expect(patched.body.status).toBe('PURCHASE_PLANNED');
    expect(patched.body.purchaseQty).toBe('12.5');
    expect(patched.body.supplierNameText).toBe('ООО «Поставщик»');
    expect(patched.body.quotedPrice).toBe('450');
    expect(patched.body.quotedCurrency).toBe('RUB');
    expect(patched.body.expectedDeliveryDate?.startsWith('2026-05-01')).toBe(
      true,
    );
    expect(patched.body.comment).toBe('Привезут на склад к понедельнику');

    // Пустые строки → null (стирание).
    const cleared = await request(t.app.getHttpServer())
      .patch(`/api/workshop-needs/${needId}`)
      .set('Cookie', cookies.manager)
      .send({ supplierNameText: '', comment: '   ' })
      .expect(200);
    expect(cleared.body.supplierNameText).toBeNull();
    expect(cleared.body.comment).toBeNull();
  });

  test('purchaseQty <= 0 отбивается Zod-ом', async () => {
    const orderId = await prepareSimpleQtyPerUnitOrder(t, seed, cookies.manager);
    const calc = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);
    const needId = calc.body.needs[0].id;

    const r = await request(t.app.getHttpServer())
      .patch(`/api/workshop-needs/${needId}`)
      .set('Cookie', cookies.manager)
      .send({ purchaseQty: '0' });
    expect(r.status).toBe(400);
  });

  test('POST /:id/cancel — статус CANCELLED, повторный — идемпотентен', async () => {
    const orderId = await prepareSimpleQtyPerUnitOrder(t, seed, cookies.manager);
    const calc = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);
    const needId = calc.body.needs[0].id;

    const c1 = await request(t.app.getHttpServer())
      .post(`/api/workshop-needs/${needId}/cancel`)
      .set('Cookie', cookies.manager)
      .expect(201);
    expect(c1.body.status).toBe('CANCELLED');

    const c2 = await request(t.app.getHttpServer())
      .post(`/api/workshop-needs/${needId}/cancel`)
      .set('Cookie', cookies.manager)
      .expect(201);
    expect(c2.body.status).toBe('CANCELLED');
  });

  // ---------------------------------------------------------------------------
  // 6. RBAC
  // ---------------------------------------------------------------------------

  test('Рабочая роль (QC) — 403 на любые workshop-needs эндпоинты', async () => {
    const orderId = await prepareSimpleQtyPerUnitOrder(t, seed, cookies.manager);

    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', cookies.qc)
      .send({})
      .expect(403);

    await request(t.app.getHttpServer())
      .get('/api/workshop-needs')
      .set('Cookie', cookies.qc)
      .expect(403);
  });

  // ---------------------------------------------------------------------------
  // 7. Фильтр «Статус расчёта» (orderCalculationStatus)
  //
  // Управленческий фильтр UI `/admin/workshop-needs` — он работает по
  // `Order.status`, не по `WorkshopNeed.status`. Default для общего
  // списка = ACTIVE (`Order.status = CALCULATION`); для конкретного
  // `orderId` default = ALL — карточка заказа продолжает видеть свои
  // потребности после `completeCalculation`.
  // ---------------------------------------------------------------------------

  test('orderCalculationStatus: default ACTIVE прячет CALCULATION_DONE-заказы', async () => {
    const { activeOrderId, doneOrderId } =
      await prepareCalculationStatusFixture(t, seed, cookies.manager);

    // Без query: default ACTIVE → A видим, B нет.
    const def = await request(t.app.getHttpServer())
      .get('/api/workshop-needs')
      .set('Cookie', cookies.manager)
      .expect(200);
    const defIds = def.body.map((n: { orderId: string }) => n.orderId);
    expect(defIds).toContain(activeOrderId);
    expect(defIds).not.toContain(doneOrderId);

    // Явно ACTIVE — то же самое.
    const active = await request(t.app.getHttpServer())
      .get('/api/workshop-needs?orderCalculationStatus=ACTIVE')
      .set('Cookie', cookies.manager)
      .expect(200);
    const activeIds = active.body.map((n: { orderId: string }) => n.orderId);
    expect(activeIds).toContain(activeOrderId);
    expect(activeIds).not.toContain(doneOrderId);
  });

  test('orderCalculationStatus=DONE возвращает только CALCULATION_DONE', async () => {
    const { activeOrderId, doneOrderId } =
      await prepareCalculationStatusFixture(t, seed, cookies.manager);

    const r = await request(t.app.getHttpServer())
      .get('/api/workshop-needs?orderCalculationStatus=DONE')
      .set('Cookie', cookies.manager)
      .expect(200);
    const ids = r.body.map((n: { orderId: string }) => n.orderId);
    expect(ids).toContain(doneOrderId);
    expect(ids).not.toContain(activeOrderId);
  });

  test('orderCalculationStatus=ALL возвращает и активные, и завершённые', async () => {
    const { activeOrderId, doneOrderId } =
      await prepareCalculationStatusFixture(t, seed, cookies.manager);

    const r = await request(t.app.getHttpServer())
      .get('/api/workshop-needs?orderCalculationStatus=ALL')
      .set('Cookie', cookies.manager)
      .expect(200);
    const ids = r.body.map((n: { orderId: string }) => n.orderId);
    expect(ids).toContain(activeOrderId);
    expect(ids).toContain(doneOrderId);
  });

  test('orderId-эндпоинт не скрывает CALCULATION_DONE-заказ (default ALL)', async () => {
    const { doneOrderId } = await prepareCalculationStatusFixture(
      t,
      seed,
      cookies.manager,
    );

    // GET /api/workshop-needs?orderId=B — без явного orderCalculationStatus.
    const r = await request(t.app.getHttpServer())
      .get(`/api/workshop-needs?orderId=${encodeURIComponent(doneOrderId)}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(r.body.length).toBeGreaterThan(0);
    for (const n of r.body) {
      expect(n.orderId).toBe(doneOrderId);
    }

    // То же самое через order-specific endpoint
    // `/api/orders/:id/workshop-needs`.
    const r2 = await request(t.app.getHttpServer())
      .get(`/api/orders/${encodeURIComponent(doneOrderId)}/workshop-needs`)
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(r2.body.length).toBeGreaterThan(0);
    for (const n of r2.body) {
      expect(n.orderId).toBe(doneOrderId);
    }
  });

  test('Старый ?status= по-прежнему фильтрует строки внутри ALL', async () => {
    const { activeOrderId, doneOrderId } =
      await prepareCalculationStatusFixture(t, seed, cookies.manager);
    // Переводим строку активного заказа в PURCHASE_PLANNED, чтобы
    // фильтр по `WorkshopNeed.status = CALCULATED` оставил только
    // CALCULATED (B).
    const activeNeeds = await t.prisma.workshopNeed.findMany({
      where: { orderId: activeOrderId },
    });
    expect(activeNeeds.length).toBeGreaterThan(0);
    await request(t.app.getHttpServer())
      .patch(`/api/workshop-needs/${activeNeeds[0]!.id}`)
      .set('Cookie', cookies.manager)
      .send({ status: 'PURCHASE_PLANNED' })
      .expect(200);

    const r = await request(t.app.getHttpServer())
      .get('/api/workshop-needs?orderCalculationStatus=ALL&status=CALCULATED')
      .set('Cookie', cookies.manager)
      .expect(200);
    // Должны прийти строки CALCULATED — обе orderId возможны (активный
    // ещё имеет CALCULATED-строки помимо одной PURCHASE_PLANNED, а
    // завершённый заказ B пришёл целиком в CALCULATED).
    for (const n of r.body) {
      expect(n.status).toBe('CALCULATED');
    }
    const ids = new Set(r.body.map((n: { orderId: string }) => n.orderId));
    expect(ids.has(doneOrderId)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 8. ORDER_ITEMS_REQUIRED
  // ---------------------------------------------------------------------------

  test('Заказ с qtyPlan = 0 → 422 WORKSHOP_NEED_ORDER_ITEMS_REQUIRED', async () => {
    // POST /api/orders отбивает qtyPlan = 0 на уровне Zod-схемы заказа
    // (см. `CreateOrderSchema`), поэтому валидный заказ создаём с
    // ненулевыми позициями и затем обнуляем их через Prisma — это
    // эмулирует «дегенеративный» снимок без живого qtyPlan, который
    // должен поймать `WorkshopNeedOrderItemsRequiredException`.
    const orderId = await prepareSimpleQtyPerUnitOrder(t, seed, cookies.manager);
    await t.prisma.orderItem.updateMany({
      where: { orderId },
      data: { qtyPlan: 0 },
    });

    const r = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', cookies.manager)
      .send({});
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('WORKSHOP_NEED_ORDER_ITEMS_REQUIRED');
  });
});

// ===========================================================================
// helpers
// ===========================================================================

interface MaterialLineInput {
  name: string;
  unit: string;
  qtyPerUnit: string;
  note?: string | null;
  materialRole?: string | null;
  fabricType?: string | null;
  densityGsm?: number | null;
  plannedWidthCm?: number | null;
  colorRule?: 'ORDER_COLOR' | 'FIXED_COLOR' | 'NO_COLOR' | null;
  fixedColorText?: string | null;
}

async function createTechCard(
  t: TestApp,
  cookie: string,
  body: {
    code: string;
    name: string;
    isActive?: boolean;
    materialLines?: MaterialLineInput[];
  },
): Promise<{ id: string }> {
  const r = await request(t.app.getHttpServer())
    .post('/api/tech-cards')
    .set('Cookie', cookie)
    .send(body)
    .expect(201);
  return { id: r.body.id };
}

async function createOrderWithPatternAndTechCard(
  t: TestApp,
  seed: SeedResult,
  cookie: string,
  options: {
    items: Array<{ sizeId: string; qtyPlan: number }>;
    techCardId: string;
    patternItemId: string | null;
    color?: string | null;
  },
): Promise<string> {
  const r = await request(t.app.getHttpServer())
    .post('/api/orders')
    .set('Cookie', cookie)
    .send({
      orderDate: '2026-04-15T00:00:00.000Z',
      clientId: seed.client.id,
      productId: seed.product.id,
      items: options.items,
      techCardId: options.techCardId,
      patternItemId: options.patternItemId ?? undefined,
      color: options.color ?? undefined,
    })
    .expect(201);
  return r.body.id as string;
}

/**
 * Минимальный заказ без лекала с одной QTY_PER_UNIT-строкой —
 * хватает для большинства update / cancel / RBAC-сценариев.
 */
async function prepareSimpleQtyPerUnitOrder(
  t: TestApp,
  seed: SeedResult,
  cookie: string,
): Promise<string> {
  const tc = await createTechCard(t, cookie, {
    code: 'TC-SIMPLE',
    name: 'Simple',
    materialLines: [{ name: 'Нитки', unit: 'м', qtyPerUnit: '1.5' }],
  });
  return createOrderWithPatternAndTechCard(t, seed, cookie, {
    items: [{ sizeId: seed.sizes.M, qtyPlan: 5 }],
    techCardId: tc.id,
    patternItemId: null,
  });
}

/**
 * Готовит фикстуру под фильтр `orderCalculationStatus`:
 *   - заказ A — `Order.status = CALCULATION` + WorkshopNeed;
 *   - заказ B — `Order.status = CALCULATION_DONE` + WorkshopNeed.
 *
 * Используем `prisma.order.update` напрямую, чтобы не тащить весь
 * happy-path `start-calculation` / `complete-calculation` (он
 * проверяется в `tests/integration/order-cost-estimates.test.ts`).
 * Это намеренно — нам нужны два заказа с разными `Order.status`,
 * а как именно они туда попали, для фильтра не важно.
 */
async function prepareCalculationStatusFixture(
  t: TestApp,
  seed: SeedResult,
  cookie: string,
): Promise<{ activeOrderId: string; doneOrderId: string }> {
  // Не используем `prepareSimpleQtyPerUnitOrder` дважды — он завязан
  // на фиксированный `code = 'TC-SIMPLE'`, и второй вызов упадёт в
  // 409 на уникальности `TechCard.code`. Создаём заказы с
  // отдельными tech-card-ами и сохраняем минимальный QTY_PER_UNIT
  // источник материала.
  const tcA = await createTechCard(t, cookie, {
    code: 'TC-OCS-A',
    name: 'Calc filter A',
    materialLines: [{ name: 'Нитки', unit: 'м', qtyPerUnit: '1.5' }],
  });
  const activeOrderId = await createOrderWithPatternAndTechCard(
    t,
    seed,
    cookie,
    {
      items: [{ sizeId: seed.sizes.M, qtyPlan: 5 }],
      techCardId: tcA.id,
      patternItemId: null,
    },
  );

  const tcB = await createTechCard(t, cookie, {
    code: 'TC-OCS-B',
    name: 'Calc filter B',
    materialLines: [{ name: 'Нитки', unit: 'м', qtyPerUnit: '1.5' }],
  });
  const doneOrderId = await createOrderWithPatternAndTechCard(
    t,
    seed,
    cookie,
    {
      items: [{ sizeId: seed.sizes.M, qtyPlan: 5 }],
      techCardId: tcB.id,
      patternItemId: null,
    },
  );

  for (const id of [activeOrderId, doneOrderId]) {
    await request(t.app.getHttpServer())
      .post(`/api/orders/${id}/workshop-needs/calculate`)
      .set('Cookie', cookie)
      .send({})
      .expect(201);
  }

  await t.prisma.order.update({
    where: { id: activeOrderId },
    data: { status: 'CALCULATION' },
  });
  await t.prisma.order.update({
    where: { id: doneOrderId },
    data: { status: 'CALCULATION_DONE' },
  });

  return { activeOrderId, doneOrderId };
}
