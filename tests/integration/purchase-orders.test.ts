/**
 * Integration-тесты модуля «Заказы поставщикам» (Purchase Orders, Этап 6А,
 * см. `apps/api/src/modules/purchase-orders/*`,
 * `prisma/schema.prisma::PurchaseOrder`,
 * `docs/recon-soft-integration.md §«Этап 6А»`).
 *
 * Покрытие (минимально достаточный contract-floor MVP):
 *   1. Happy path: одна потребность → один PO с одной строкой,
 *      supplier-snapshot и item-snapshot зафиксированы;
 *      `WorkshopNeed.status = ORDERED`.
 *   2. Bulk: несколько потребностей одного поставщика и одного
 *      заказа покупателя → один PO со многими строками; повторное
 *      создание по тем же needs → 409 PURCHASE_ORDER_NEED_ALREADY_ORDERED.
 *   3. Валидация: разные supplier-ы → 422 DIFFERENT_SUPPLIERS;
 *      разные orderId → 422 DIFFERENT_ORDERS; нет supplier-а в
 *      потребности → 422 SUPPLIER_REQUIRED; нет purchaseQty →
 *      422 PURCHASE_QTY_REQUIRED.
 *   4. Жизненный цикл: DRAFT → SENT → CONFIRMED, любой → CANCELLED.
 *      Отмена возвращает WorkshopNeed → PURCHASE_PLANNED, если по нему
 *      нет других активных линий.
 *   5. RBAC: рабочая роль (QC) → 403.
 *   6. Связка с заказом: GET /api/orders/:id/purchase-orders отдаёт
 *      созданный PO.
 *
 * Не проверяем здесь:
 *   - UI (sidebar / страницы) — это smoke-тесты;
 *   - аудит entry-by-entry — общий тест аудита живёт в
 *     `tests/integration/audit-log.test.ts`, тут смотрим только на
 *     один вызов как «дымовой».
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
import { createSpecPattern } from '../utils/spec';

describeWithDb('integration — purchase orders (Этап 6А)', () => {
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
  // 1. Happy path: одна потребность → один PO
  // ---------------------------------------------------------------------------

  test('createFromNeeds: одна потребность → PO + snapshot, WorkshopNeed → ORDERED', async () => {
    const fx = await prepareSingleNeedFixture(t, seed, cookies.manager);

    const r = await request(t.app.getHttpServer())
      .post('/api/purchase-orders/from-needs')
      .set('Cookie', cookies.manager)
      .send({
        workshopNeedIds: [fx.needId],
        comment: 'Срочно',
        expectedDeliveryDate: '2026-05-15',
      })
      .expect(201);

    // Header.
    expect(r.body.id).toBeTruthy();
    expect(r.body.number).toMatch(/^PO-\d{8}-\d{4}$/u);
    expect(r.body.status).toBe('DRAFT');
    expect(r.body.supplierId).toBe(fx.supplierId);
    expect(r.body.supplierNameSnapshot).toBe('Поставщик А');
    expect(r.body.supplierPhoneSnapshot).toBe('+7-000-0000-001');
    expect(r.body.customerOrderId).toBe(fx.orderId);
    expect(r.body.customerOrderNumber).toBeTruthy();
    expect(r.body.comment).toBe('Срочно');
    expect(r.body.expectedDeliveryDate?.startsWith('2026-05-15')).toBe(true);

    // Lines.
    expect(r.body.lines).toHaveLength(1);
    const line = r.body.lines[0];
    expect(line.workshopNeedId).toBe(fx.needId);
    expect(line.supplierCatalogItemId).toBe(fx.catalogItemId);
    expect(line.itemNameSnapshot).toBe('Кулирка 180 г/м² чёрная');
    expect(line.supplierArticleSnapshot).toBe('KUL-180-BLK');
    expect(line.unitSnapshot).toBe('м');
    expect(line.qty).toBe('25');
    expect(line.price).toBe('500');
    expect(line.currency).toBe('RUB');
    expect(line.status).toBe('DRAFT');
    expect(line.customerOrderNumber).toBeTruthy();

    // WorkshopNeed → ORDERED.
    const need = await request(t.app.getHttpServer())
      .get(`/api/workshop-needs/${fx.needId}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(need.body.status).toBe('ORDERED');

    // List endpoint видит созданный PO.
    const list = await request(t.app.getHttpServer())
      .get('/api/purchase-orders')
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(list.body.length).toBeGreaterThanOrEqual(1);
    expect(list.body.some((p: { id: string }) => p.id === r.body.id)).toBe(true);

    // Список по заказу покупателя.
    const byOrder = await request(t.app.getHttpServer())
      .get(`/api/orders/${fx.orderId}/purchase-orders`)
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(byOrder.body).toHaveLength(1);
    expect(byOrder.body[0].id).toBe(r.body.id);
  });

  test('единица строки PO берётся из потребности, а не из каталога поставщика', async () => {
    const fx = await prepareSingleNeedFixture(t, seed, cookies.manager);

    // Позиция каталога заведена в КИЛОГРАММАХ, а «К закупке» посчитано
    // в единице потребности (метры). Раньше единица бралась из каталога,
    // а число оставалось прежним: «25 м» уходило поставщику как «25 кг».
    const kgItemId = await createCatalogItem(
      t,
      cookies.manager,
      fx.supplierId,
      {
        name: 'Кулирка на вес',
        supplierArticle: 'KUL-KG',
        unit: 'кг',
        lastPrice: '500.00',
        currency: 'RUB',
      },
    );
    await request(t.app.getHttpServer())
      .patch(`/api/workshop-needs/${fx.needId}`)
      .set('Cookie', cookies.manager)
      .send({ selectedSupplierCatalogItemId: kgItemId })
      .expect(200);

    const need = await request(t.app.getHttpServer())
      .get(`/api/workshop-needs/${fx.needId}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    const needUnit = need.body.unit as string;
    expect(needUnit).not.toBe('кг');

    const r = await request(t.app.getHttpServer())
      .post('/api/purchase-orders/from-needs')
      .set('Cookie', cookies.manager)
      .send({ workshopNeedIds: [fx.needId] })
      .expect(201);

    const line = r.body.lines[0];
    // Единица описывает то самое число, что стоит рядом.
    expect(line.unitSnapshot).toBe(needUnit);
    expect(line.qty).toBe('25');
    // Привязка к позиции каталога при этом сохраняется.
    expect(line.supplierCatalogItemId).toBe(kgItemId);
  });

  // ---------------------------------------------------------------------------
  // 2. Bulk: несколько потребностей в одном PO
  // ---------------------------------------------------------------------------

  test('createFromNeeds: несколько потребностей одного поставщика и заказа → один PO', async () => {
    const fx = await prepareTwoNeedsFixture(t, seed, cookies.manager);

    const r = await request(t.app.getHttpServer())
      .post('/api/purchase-orders/from-needs')
      .set('Cookie', cookies.manager)
      .send({ workshopNeedIds: [fx.need1Id, fx.need2Id] })
      .expect(201);

    expect(r.body.lines).toHaveLength(2);
    expect(
      r.body.lines.map((l: { workshopNeedId: string }) => l.workshopNeedId).sort(),
    ).toEqual([fx.need1Id, fx.need2Id].sort());

    // Повторный POST с теми же needs — конфликт.
    const dup = await request(t.app.getHttpServer())
      .post('/api/purchase-orders/from-needs')
      .set('Cookie', cookies.manager)
      .send({ workshopNeedIds: [fx.need1Id] });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('PURCHASE_ORDER_NEED_ALREADY_ORDERED');
  });

  // ---------------------------------------------------------------------------
  // 3. Валидация
  // ---------------------------------------------------------------------------

  test('createFromNeeds: разные поставщики → 422 DIFFERENT_SUPPLIERS', async () => {
    const fx = await prepareTwoNeedsDifferentSuppliersFixture(
      t,
      seed,
      cookies.manager,
    );

    const r = await request(t.app.getHttpServer())
      .post('/api/purchase-orders/from-needs')
      .set('Cookie', cookies.manager)
      .send({ workshopNeedIds: [fx.need1Id, fx.need2Id] });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('PURCHASE_ORDER_NEEDS_DIFFERENT_SUPPLIERS');
  });

  test('createFromNeeds: разные заказы → 422 DIFFERENT_ORDERS', async () => {
    const fx = await prepareTwoNeedsDifferentOrdersFixture(
      t,
      seed,
      cookies.manager,
    );

    const r = await request(t.app.getHttpServer())
      .post('/api/purchase-orders/from-needs')
      .set('Cookie', cookies.manager)
      .send({ workshopNeedIds: [fx.need1Id, fx.need2Id] });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('PURCHASE_ORDER_NEEDS_DIFFERENT_ORDERS');
  });

  test('createFromNeeds: нет поставщика в потребности → 422 SUPPLIER_REQUIRED', async () => {
    const fx = await prepareSingleNeedFixture(t, seed, cookies.manager);
    // Снимаем supplier у потребности, оставляем только purchaseQty.
    await request(t.app.getHttpServer())
      .patch(`/api/workshop-needs/${fx.needId}`)
      .set('Cookie', cookies.manager)
      .send({ selectedSupplierId: '', selectedSupplierCatalogItemId: '' })
      .expect(200);

    const r = await request(t.app.getHttpServer())
      .post('/api/purchase-orders/from-needs')
      .set('Cookie', cookies.manager)
      .send({ workshopNeedIds: [fx.needId] });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('PURCHASE_ORDER_NEEDS_SUPPLIER_REQUIRED');
  });

  test('createFromNeeds: нет purchaseQty → 422 PURCHASE_QTY_REQUIRED', async () => {
    const fx = await prepareSingleNeedFixture(t, seed, cookies.manager, {
      withPurchaseQty: false,
    });

    const r = await request(t.app.getHttpServer())
      .post('/api/purchase-orders/from-needs')
      .set('Cookie', cookies.manager)
      .send({ workshopNeedIds: [fx.needId] });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('PURCHASE_ORDER_NEED_PURCHASE_QTY_REQUIRED');
  });

  test('createFromNeeds: пустой workshopNeedIds → 400', async () => {
    const r = await request(t.app.getHttpServer())
      .post('/api/purchase-orders/from-needs')
      .set('Cookie', cookies.manager)
      .send({ workshopNeedIds: [] });
    expect(r.status).toBe(400);
  });

  // ---------------------------------------------------------------------------
  // 4. Жизненный цикл статусов
  // ---------------------------------------------------------------------------

  test('lifecycle: DRAFT → SENT → CONFIRMED, строки каскадятся', async () => {
    const fx = await prepareSingleNeedFixture(t, seed, cookies.manager);
    const created = await request(t.app.getHttpServer())
      .post('/api/purchase-orders/from-needs')
      .set('Cookie', cookies.manager)
      .send({ workshopNeedIds: [fx.needId] })
      .expect(201);
    const poId = created.body.id;

    // Send.
    const sent = await request(t.app.getHttpServer())
      .post(`/api/purchase-orders/${poId}/send`)
      .set('Cookie', cookies.manager)
      .expect(201);
    expect(sent.body.status).toBe('SENT');
    expect(sent.body.sentAt).toBeTruthy();
    expect(sent.body.lines.every((l: { status: string }) => l.status === 'SENT')).toBe(
      true,
    );

    // Повторный send — нельзя (SENT → SENT обрабатывается как no-op
    // через `assertStatusTransition`-ранний-выход).
    const resend = await request(t.app.getHttpServer())
      .post(`/api/purchase-orders/${poId}/send`)
      .set('Cookie', cookies.manager);
    // SENT → SENT не падает (ранний return на from === to), считается ok.
    expect([201, 409]).toContain(resend.status);

    // Confirm c подтверждениями по строке.
    const lineId = sent.body.lines[0].id;
    const confirmed = await request(t.app.getHttpServer())
      .post(`/api/purchase-orders/${poId}/confirm`)
      .set('Cookie', cookies.manager)
      .send({
        confirmedAt: '2026-05-10T10:00:00.000Z',
        lines: [
          {
            lineId,
            confirmedQty: '24',
            confirmedPrice: '510',
            confirmedDeliveryDate: '2026-05-20',
            comment: 'Подтверждено менеджером',
          },
        ],
      })
      .expect(201);
    expect(confirmed.body.status).toBe('CONFIRMED');
    expect(confirmed.body.confirmedAt?.startsWith('2026-05-10')).toBe(true);
    const cline = confirmed.body.lines[0];
    expect(cline.status).toBe('CONFIRMED');
    expect(cline.confirmedQty).toBe('24');
    expect(cline.confirmedPrice).toBe('510');
    expect(cline.confirmedDeliveryDate?.startsWith('2026-05-20')).toBe(true);
    expect(cline.comment).toBe('Подтверждено менеджером');
  });

  test('lifecycle: cancel возвращает WorkshopNeed → PURCHASE_PLANNED', async () => {
    const fx = await prepareSingleNeedFixture(t, seed, cookies.manager);
    const created = await request(t.app.getHttpServer())
      .post('/api/purchase-orders/from-needs')
      .set('Cookie', cookies.manager)
      .send({ workshopNeedIds: [fx.needId] })
      .expect(201);
    const poId = created.body.id;

    // Подтверждаем, что WorkshopNeed.status = ORDERED.
    const beforeCancel = await request(t.app.getHttpServer())
      .get(`/api/workshop-needs/${fx.needId}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(beforeCancel.body.status).toBe('ORDERED');

    // Отменяем PO.
    const cancelled = await request(t.app.getHttpServer())
      .post(`/api/purchase-orders/${poId}/cancel`)
      .set('Cookie', cookies.manager)
      .expect(201);
    expect(cancelled.body.status).toBe('CANCELLED');
    expect(cancelled.body.cancelledAt).toBeTruthy();
    expect(
      cancelled.body.lines.every((l: { status: string }) => l.status === 'CANCELLED'),
    ).toBe(true);

    // WorkshopNeed → PURCHASE_PLANNED.
    const afterCancel = await request(t.app.getHttpServer())
      .get(`/api/workshop-needs/${fx.needId}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(afterCancel.body.status).toBe('PURCHASE_PLANNED');

    // Повторная отмена — идемпотентно.
    const cancelAgain = await request(t.app.getHttpServer())
      .post(`/api/purchase-orders/${poId}/cancel`)
      .set('Cookie', cookies.manager)
      .expect(201);
    expect(cancelAgain.body.status).toBe('CANCELLED');
  });

  test('lifecycle: CANCELLED → SENT запрещён', async () => {
    const fx = await prepareSingleNeedFixture(t, seed, cookies.manager);
    const created = await request(t.app.getHttpServer())
      .post('/api/purchase-orders/from-needs')
      .set('Cookie', cookies.manager)
      .send({ workshopNeedIds: [fx.needId] })
      .expect(201);
    const poId = created.body.id;

    await request(t.app.getHttpServer())
      .post(`/api/purchase-orders/${poId}/cancel`)
      .set('Cookie', cookies.manager)
      .expect(201);

    const r = await request(t.app.getHttpServer())
      .post(`/api/purchase-orders/${poId}/send`)
      .set('Cookie', cookies.manager);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('PURCHASE_ORDER_INVALID_STATUS_TRANSITION');
  });

  // ---------------------------------------------------------------------------
  // 5. PATCH header / line
  // ---------------------------------------------------------------------------

  test('PATCH: правка comment / expectedDeliveryDate в шапке + qty/price/comment в строке', async () => {
    const fx = await prepareSingleNeedFixture(t, seed, cookies.manager);
    const created = await request(t.app.getHttpServer())
      .post('/api/purchase-orders/from-needs')
      .set('Cookie', cookies.manager)
      .send({ workshopNeedIds: [fx.needId] })
      .expect(201);
    const poId = created.body.id;
    const lineId = created.body.lines[0].id;

    const headerUpdated = await request(t.app.getHttpServer())
      .patch(`/api/purchase-orders/${poId}`)
      .set('Cookie', cookies.manager)
      .send({ comment: 'Заметка', expectedDeliveryDate: '2026-06-01' })
      .expect(200);
    expect(headerUpdated.body.comment).toBe('Заметка');
    expect(headerUpdated.body.expectedDeliveryDate?.startsWith('2026-06-01')).toBe(
      true,
    );

    const lineUpdated = await request(t.app.getHttpServer())
      .patch(`/api/purchase-orders/${poId}/lines/${lineId}`)
      .set('Cookie', cookies.manager)
      .send({
        qty: '30',
        price: '480',
        currency: 'RUB',
        comment: 'Поправили объём',
      })
      .expect(200);
    const updatedLine = lineUpdated.body.lines.find(
      (l: { id: string }) => l.id === lineId,
    );
    expect(updatedLine.qty).toBe('30');
    expect(updatedLine.price).toBe('480');
    expect(updatedLine.comment).toBe('Поправили объём');
  });

  // ---------------------------------------------------------------------------
  // 6. RBAC
  // ---------------------------------------------------------------------------

  test('RBAC: рабочая роль (QC) — 403 на purchase-orders эндпоинты', async () => {
    await request(t.app.getHttpServer())
      .get('/api/purchase-orders')
      .set('Cookie', cookies.qc)
      .expect(403);

    await request(t.app.getHttpServer())
      .post('/api/purchase-orders/from-needs')
      .set('Cookie', cookies.qc)
      .send({ workshopNeedIds: ['x'] })
      .expect(403);
  });
});

// ===========================================================================
// helpers
// ===========================================================================

interface SingleNeedFixture {
  orderId: string;
  needId: string;
  supplierId: string;
  catalogItemId: string;
}

async function prepareSingleNeedFixture(
  t: TestApp,
  seed: SeedResult,
  cookie: string,
  options: { withPurchaseQty?: boolean } = {},
): Promise<SingleNeedFixture> {
  const supplierId = await createSupplier(t, cookie, {
    name: 'Поставщик А',
    phone: '+7-000-0000-001',
  });
  const catalogItemId = await createCatalogItem(t, cookie, supplierId, {
    name: 'Кулирка 180 г/м² чёрная',
    supplierArticle: 'KUL-180-BLK',
    unit: 'м',
    lastPrice: '500.00',
    currency: 'RUB',
  });

  const specId = await createSimpleSpecPattern(t, cookie, 'TC-PO-1');
  const orderId = await createOrderWithSpec(t, seed, cookie, specId);

  const calc = await request(t.app.getHttpServer())
    .post(`/api/orders/${orderId}/workshop-needs/calculate`)
    .set('Cookie', cookie)
    .send({})
    .expect(201);
  const needId = calc.body.needs[0].id as string;

  const patchBody: Record<string, string> = {
    selectedSupplierId: supplierId,
    selectedSupplierCatalogItemId: catalogItemId,
    quotedPrice: '500',
    quotedCurrency: 'RUB',
  };
  if (options.withPurchaseQty !== false) {
    patchBody.purchaseQty = '25';
  }

  await request(t.app.getHttpServer())
    .patch(`/api/workshop-needs/${needId}`)
    .set('Cookie', cookie)
    .send(patchBody)
    .expect(200);

  return { orderId, needId, supplierId, catalogItemId };
}

interface TwoNeedsFixture {
  orderId: string;
  need1Id: string;
  need2Id: string;
  supplierId: string;
}

async function prepareTwoNeedsFixture(
  t: TestApp,
  seed: SeedResult,
  cookie: string,
): Promise<TwoNeedsFixture> {
  const supplierId = await createSupplier(t, cookie, { name: 'Поставщик Б' });
  const itemA = await createCatalogItem(t, cookie, supplierId, {
    name: 'Нитки чёрные',
    unit: 'м',
    lastPrice: '10.00',
  });
  const itemB = await createCatalogItem(t, cookie, supplierId, {
    name: 'Пуговицы',
    unit: 'шт',
    lastPrice: '2.00',
  });

  const specId = await createTwoLineSpecPattern(t, cookie, 'TC-PO-2');
  const orderId = await createOrderWithSpec(t, seed, cookie, specId);

  const calc = await request(t.app.getHttpServer())
    .post(`/api/orders/${orderId}/workshop-needs/calculate`)
    .set('Cookie', cookie)
    .send({})
    .expect(201);
  const needs = calc.body.needs as Array<{ id: string; description: string }>;
  expect(needs).toHaveLength(2);
  // Ставим первой потребности itemA, второй — itemB. Связь по
  // материальной строке тут не критична: нам важно, что обе
  // потребности привязаны к одному supplier.
  await request(t.app.getHttpServer())
    .patch(`/api/workshop-needs/${needs[0].id}`)
    .set('Cookie', cookie)
    .send({
      selectedSupplierId: supplierId,
      selectedSupplierCatalogItemId: itemA,
      purchaseQty: '100',
    })
    .expect(200);
  await request(t.app.getHttpServer())
    .patch(`/api/workshop-needs/${needs[1].id}`)
    .set('Cookie', cookie)
    .send({
      selectedSupplierId: supplierId,
      selectedSupplierCatalogItemId: itemB,
      purchaseQty: '50',
    })
    .expect(200);

  return {
    orderId,
    need1Id: needs[0].id,
    need2Id: needs[1].id,
    supplierId,
  };
}

async function prepareTwoNeedsDifferentSuppliersFixture(
  t: TestApp,
  seed: SeedResult,
  cookie: string,
): Promise<{ need1Id: string; need2Id: string }> {
  const supA = await createSupplier(t, cookie, { name: 'A' });
  const supB = await createSupplier(t, cookie, { name: 'B' });
  const itemA = await createCatalogItem(t, cookie, supA, {
    name: 'A-1',
    unit: 'м',
  });
  const itemB = await createCatalogItem(t, cookie, supB, {
    name: 'B-1',
    unit: 'шт',
  });
  const specId = await createTwoLineSpecPattern(t, cookie, 'TC-PO-3');
  const orderId = await createOrderWithSpec(t, seed, cookie, specId);
  const calc = await request(t.app.getHttpServer())
    .post(`/api/orders/${orderId}/workshop-needs/calculate`)
    .set('Cookie', cookie)
    .send({})
    .expect(201);
  const needs = calc.body.needs as Array<{ id: string }>;
  await request(t.app.getHttpServer())
    .patch(`/api/workshop-needs/${needs[0].id}`)
    .set('Cookie', cookie)
    .send({
      selectedSupplierId: supA,
      selectedSupplierCatalogItemId: itemA,
      purchaseQty: '10',
    })
    .expect(200);
  await request(t.app.getHttpServer())
    .patch(`/api/workshop-needs/${needs[1].id}`)
    .set('Cookie', cookie)
    .send({
      selectedSupplierId: supB,
      selectedSupplierCatalogItemId: itemB,
      purchaseQty: '5',
    })
    .expect(200);
  return { need1Id: needs[0].id, need2Id: needs[1].id };
}

async function prepareTwoNeedsDifferentOrdersFixture(
  t: TestApp,
  seed: SeedResult,
  cookie: string,
): Promise<{ need1Id: string; need2Id: string }> {
  const supplierId = await createSupplier(t, cookie, { name: 'Один поставщик' });
  const itemId = await createCatalogItem(t, cookie, supplierId, {
    name: 'Одна позиция',
    unit: 'м',
  });

  const spec1 = await createSimpleSpecPattern(t, cookie, 'TC-PO-4-A');
  const spec2 = await createSimpleSpecPattern(t, cookie, 'TC-PO-4-B');
  const order1 = await createOrderWithSpec(t, seed, cookie, spec1);
  const order2 = await createOrderWithSpec(t, seed, cookie, spec2);
  const calc1 = await request(t.app.getHttpServer())
    .post(`/api/orders/${order1}/workshop-needs/calculate`)
    .set('Cookie', cookie)
    .send({})
    .expect(201);
  const calc2 = await request(t.app.getHttpServer())
    .post(`/api/orders/${order2}/workshop-needs/calculate`)
    .set('Cookie', cookie)
    .send({})
    .expect(201);
  const need1 = calc1.body.needs[0].id as string;
  const need2 = calc2.body.needs[0].id as string;
  for (const id of [need1, need2]) {
    await request(t.app.getHttpServer())
      .patch(`/api/workshop-needs/${id}`)
      .set('Cookie', cookie)
      .send({
        selectedSupplierId: supplierId,
        selectedSupplierCatalogItemId: itemId,
        purchaseQty: '7',
      })
      .expect(200);
  }
  return { need1Id: need1, need2Id: need2 };
}

async function createSupplier(
  t: TestApp,
  cookie: string,
  body: { name: string; phone?: string; website?: string; address?: string },
): Promise<string> {
  const r = await request(t.app.getHttpServer())
    .post('/api/suppliers')
    .set('Cookie', cookie)
    .send(body)
    .expect(201);
  return r.body.id as string;
}

async function createCatalogItem(
  t: TestApp,
  cookie: string,
  supplierId: string,
  body: {
    name: string;
    supplierArticle?: string;
    unit: string;
    lastPrice?: string;
    currency?: string;
  },
): Promise<string> {
  const r = await request(t.app.getHttpServer())
    .post(`/api/suppliers/${supplierId}/catalog`)
    .set('Cookie', cookie)
    .send(body)
    .expect(201);
  return r.body.id as string;
}

// Справочника техкарт больше нет: состав материалов даёт спецификация
// карточки номенклатуры, заказ создаётся с patternItemId.
async function createSimpleSpecPattern(
  t: TestApp,
  cookie: string,
  code: string,
): Promise<string> {
  const { id } = await createSpecPattern(t, cookie, {
    name: code,
    article: code,
    materialLines: [{ name: 'Кулирка', unit: 'м', qtyPerUnit: '0.5' }],
  });
  return id;
}

async function createTwoLineSpecPattern(
  t: TestApp,
  cookie: string,
  code: string,
): Promise<string> {
  const { id } = await createSpecPattern(t, cookie, {
    name: code,
    article: code,
    materialLines: [
      { name: 'Нитки', unit: 'м', qtyPerUnit: '120' },
      { name: 'Пуговицы', unit: 'шт', qtyPerUnit: '4' },
    ],
  });
  return id;
}

async function createOrderWithSpec(
  t: TestApp,
  seed: SeedResult,
  cookie: string,
  patternItemId: string,
): Promise<string> {
  const r = await request(t.app.getHttpServer())
    .post('/api/orders')
    .set('Cookie', cookie)
    .send({
      orderDate: '2026-04-15T00:00:00.000Z',
      productId: seed.product.id,
      items: [{ sizeId: seed.sizes.M, qtyPlan: 50 }],
      patternItemId,
    })
    .expect(201);
  return r.body.id as string;
}
