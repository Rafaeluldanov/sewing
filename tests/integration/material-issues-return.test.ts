/**
 * Integration-тесты возврата / сторно проведённого `MaterialIssue`
 * (см. ТЗ «Material issue return», `docs/api.md §«Material issues»`,
 * `apps/api/src/modules/material-issues/material-issues.service.ts::returnPostedIssue`,
 * `apps/api/src/modules/stock/stock.service.ts::recordMaterialIssueReturnInTx`,
 * `prisma/schema.prisma::MaterialIssueReturn` /
 * `MaterialIssueReturnLine`).
 *
 * Покрытие (нумерация — по ТЗ §15):
 *   1. POST /api/material-issues/:id/return работает только для POSTED.
 *   2. DRAFT issue return → 409.
 *   3. POSTED issue return создаёт MaterialIssueReturn.
 *   4. Return создаёт MaterialIssueReturnLine для каждой строки.
 *   5. Return создаёт StockMovement IN type=REVERSAL.
 *   6. Return увеличивает StockBalance.qty.
 *   7. Идемпотентность по clientRequestId.
 *   8. Повторный полный возврат запрещён → 409 already-returned.
 *   9. returnedTotalCost вычитается из netTotalCost в DTO.
 *  10. sourceKey не отдаётся в ответе.
 *  11. Audit MATERIAL_ISSUE_RETURNED записан.
 *  15. Return использует warehouseId/cellId из исходного OUT.
 *
 * Тест использует `TEST_DATABASE_URL` — без неё `describeWithDb`
 * превращается в `describe.skip`.
 */
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';

import { buildMaterialIssueReturnLineStockSourceKey } from '@sewing/api/modules/stock/stock.service';

import {
  loginAs,
  startTestApp,
  stopTestApp,
  type TestApp,
} from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

describeWithDb('integration — material issue return / reversal', () => {
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

  /**
   * Готовит проведённый `MaterialIssue` со списанием 4 м из ячейки
   * A1 (после приёмки 20 м). Возвращает id-шники для теста возврата.
   */
  async function preparePostedIssue(): Promise<{
    orderId: string;
    workshopNeedId: string;
    issueId: string;
    issueLineId: string;
    cellId: string;
  }> {
    const cellId = seed.cells.A1.id;

    const supplier = await request(t.app.getHttpServer())
      .post('/api/suppliers')
      .set('Cookie', cookies.manager)
      .send({ name: `Supplier-${Date.now()}-${Math.random()}` })
      .expect(201);
    const catalog = await request(t.app.getHttpServer())
      .post(`/api/suppliers/${supplier.body.id}/catalog`)
      .set('Cookie', cookies.manager)
      .send({ name: 'Кулирка', unit: 'м', lastPrice: '500.00', currency: 'RUB' })
      .expect(201);

    const tcCode = `TC-MI-RET-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    const tc = await request(t.app.getHttpServer())
      .post('/api/tech-cards')
      .set('Cookie', cookies.manager)
      .send({
        code: tcCode,
        name: tcCode,
        materialLines: [
          {
            name: 'Кулирка',
            unit: 'м',
            qtyPerUnit: '0.5',
            materialRole: 'MAIN_FABRIC',
            colorRule: 'ORDER_COLOR',
          },
        ],
      })
      .expect(201);
    const order = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookies.manager)
      .send({
        orderDate: '2026-04-15T00:00:00.000Z',
        productId: seed.product.id,
        color: 'Чёрный',
        items: [{ sizeId: seed.sizes.M, qtyPlan: 10 }],
        techCardId: tc.body.id,
      })
      .expect(201);
    const orderId = order.body.id as string;

    const calc = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);
    const workshopNeedId = calc.body.needs[0].id as string;
    await request(t.app.getHttpServer())
      .patch(`/api/workshop-needs/${workshopNeedId}`)
      .set('Cookie', cookies.manager)
      .send({
        selectedSupplierId: supplier.body.id,
        selectedSupplierCatalogItemId: catalog.body.id,
        purchaseQty: '20',
        quotedPrice: '500.00',
        quotedCurrency: 'RUB',
      })
      .expect(200);
    const po = await request(t.app.getHttpServer())
      .post('/api/purchase-orders/from-needs')
      .set('Cookie', cookies.manager)
      .send({ workshopNeedIds: [workshopNeedId] })
      .expect(201);
    await request(t.app.getHttpServer())
      .post(`/api/purchase-orders/${po.body.id}/send`)
      .set('Cookie', cookies.manager)
      .expect(201);
    await request(t.app.getHttpServer())
      .post(`/api/purchase-orders/${po.body.id}/confirm`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);
    await request(t.app.getHttpServer())
      .post('/api/purchase-receipts/from-purchase-order')
      .set('Cookie', cookies.manager)
      .send({
        purchaseOrderId: po.body.id,
        lines: [
          {
            purchaseOrderLineId: po.body.lines[0].id,
            receivedQty: '20',
            cellId,
          },
        ],
      })
      .expect(201);

    const draft = await request(t.app.getHttpServer())
      .post('/api/material-issues')
      .set('Cookie', cookies.manager)
      .send({
        orderId,
        lines: [
          {
            workshopNeedId,
            issuedQty: '4',
            unitCost: '500',
            cellId,
          },
        ],
      })
      .expect(201);
    const issueId = draft.body.id as string;
    const issueLineId = draft.body.lines[0].id as string;

    await request(t.app.getHttpServer())
      .post(`/api/material-issues/${issueId}/post`)
      .set('Cookie', cookies.manager)
      .expect(201);

    return { orderId, workshopNeedId, issueId, issueLineId, cellId };
  }

  // ===========================================================================
  // 1, 3, 4, 5, 6, 9, 10, 11, 15. Happy path: full reversal POSTED.
  // ===========================================================================

  test('POST /:id/return для POSTED: создаёт return, REVERSAL IN, увеличивает qty, sourceKey не виден, audit пишется', async () => {
    const fx = await preparePostedIssue();

    // Балас после post: 16 м (20 − 4).
    const balanceBefore = await t.prisma.stockBalance.findFirstOrThrow({
      where: { workshopNeedId: fx.workshopNeedId, cellId: fx.cellId },
    });
    expect(new Prisma.Decimal(balanceBefore.qty).toString()).toBe('16');

    const res = await request(t.app.getHttpServer())
      .post(`/api/material-issues/${fx.issueId}/return`)
      .set('Cookie', cookies.manager)
      .send({ reason: 'излишки', clientRequestId: 'req-A' })
      .expect(200);

    // 3) MaterialIssueReturn создан.
    expect(res.body.id).toBeTruthy();
    expect(res.body.materialIssueId).toBe(fx.issueId);
    expect(res.body.orderId).toBe(fx.orderId);
    expect(res.body.status).toBe('POSTED');
    expect(new Prisma.Decimal(res.body.totalCost).toString()).toBe('2000');
    // 10) sourceKey не виден в response.
    expect(res.body.sourceKey).toBeUndefined();

    // 4) Линия возврата по каждой строке.
    expect(res.body.lines).toHaveLength(1);
    const retLine = res.body.lines[0]!;
    expect(retLine.materialIssueLineId).toBe(fx.issueLineId);
    expect(new Prisma.Decimal(retLine.returnedQty).toString()).toBe('4');
    expect(new Prisma.Decimal(retLine.totalCost).toString()).toBe('2000');

    // 5) StockMovement REVERSAL IN с правильным sourceKey.
    const reversal = await t.prisma.stockMovement.findFirstOrThrow({
      where: {
        sourceKey: buildMaterialIssueReturnLineStockSourceKey(retLine.id),
      },
    });
    expect(reversal.direction).toBe('IN');
    expect(reversal.type).toBe('REVERSAL');
    // 15) warehouseId/cellId пришли из исходного OUT (= ячейка A1).
    expect(reversal.cellId).toBe(fx.cellId);
    expect(reversal.workshopNeedId).toBe(fx.workshopNeedId);
    expect(new Prisma.Decimal(reversal.qty).toString()).toBe('4');

    // 6) Баланс увеличился на 4 (16 → 20).
    const balanceAfter = await t.prisma.stockBalance.findFirstOrThrow({
      where: { workshopNeedId: fx.workshopNeedId, cellId: fx.cellId },
    });
    expect(new Prisma.Decimal(balanceAfter.qty).toString()).toBe('20');

    // 11) Audit `MATERIAL_ISSUE_RETURNED` записан.
    const audit = await t.prisma.auditLog.findFirstOrThrow({
      where: { event: 'MATERIAL_ISSUE_RETURNED', entityId: res.body.id },
    });
    expect(audit.entityType).toBe('MATERIAL_ISSUE_RETURN');
  });

  // ===========================================================================
  // 9. Issue list/detail отдают netTotalCost / returnStatus после возврата.
  // ===========================================================================

  test('после возврата DTO отдаёт netTotalCost / returnStatus = FULL', async () => {
    const fx = await preparePostedIssue();
    await request(t.app.getHttpServer())
      .post(`/api/material-issues/${fx.issueId}/return`)
      .set('Cookie', cookies.manager)
      .send({ reason: 'излишки', clientRequestId: 'req-net' })
      .expect(200);

    const detail = await request(t.app.getHttpServer())
      .get(`/api/material-issues/${fx.issueId}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(new Prisma.Decimal(detail.body.totalCost).toString()).toBe('2000');
    expect(new Prisma.Decimal(detail.body.returnedTotalCost).toString()).toBe(
      '2000',
    );
    expect(new Prisma.Decimal(detail.body.netTotalCost).toString()).toBe('0');
    expect(detail.body.returnStatus).toBe('FULL');
    expect(detail.body.returns).toHaveLength(1);
    expect(detail.body.lines[0].netIssuedQty).toBeDefined();
    expect(new Prisma.Decimal(detail.body.lines[0].netIssuedQty).toString()).toBe(
      '0',
    );
  });

  // ===========================================================================
  // 1, 2. DRAFT / CANCELLED не реверсятся.
  // ===========================================================================

  test('DRAFT issue return → 409 only-posted; не пишет return и не трогает склад', async () => {
    // Готовим без post.
    const supplier = await request(t.app.getHttpServer())
      .post('/api/suppliers')
      .set('Cookie', cookies.manager)
      .send({ name: `Supplier-${Date.now()}-${Math.random()}` })
      .expect(201);
    const catalog = await request(t.app.getHttpServer())
      .post(`/api/suppliers/${supplier.body.id}/catalog`)
      .set('Cookie', cookies.manager)
      .send({ name: 'Кулирка', unit: 'м', lastPrice: '500', currency: 'RUB' })
      .expect(201);
    const tcCode = `TC-MI-DR-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    const tc = await request(t.app.getHttpServer())
      .post('/api/tech-cards')
      .set('Cookie', cookies.manager)
      .send({
        code: tcCode,
        name: tcCode,
        materialLines: [
          {
            name: 'Кулирка',
            unit: 'м',
            qtyPerUnit: '0.5',
            materialRole: 'MAIN_FABRIC',
            colorRule: 'ORDER_COLOR',
          },
        ],
      })
      .expect(201);
    const order = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookies.manager)
      .send({
        orderDate: '2026-04-15T00:00:00.000Z',
        productId: seed.product.id,
        color: 'Чёрный',
        items: [{ sizeId: seed.sizes.M, qtyPlan: 10 }],
        techCardId: tc.body.id,
      })
      .expect(201);
    const calc = await request(t.app.getHttpServer())
      .post(`/api/orders/${order.body.id}/workshop-needs/calculate`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);
    const wnId = calc.body.needs[0].id as string;
    await request(t.app.getHttpServer())
      .patch(`/api/workshop-needs/${wnId}`)
      .set('Cookie', cookies.manager)
      .send({
        selectedSupplierId: supplier.body.id,
        selectedSupplierCatalogItemId: catalog.body.id,
        purchaseQty: '20',
        quotedPrice: '500',
        quotedCurrency: 'RUB',
      })
      .expect(200);
    const draft = await request(t.app.getHttpServer())
      .post('/api/material-issues')
      .set('Cookie', cookies.manager)
      .send({
        orderId: order.body.id,
        lines: [{ workshopNeedId: wnId, issuedQty: '1', unitCost: '500' }],
      })
      .expect(201);
    const draftId = draft.body.id as string;

    const r = await request(t.app.getHttpServer())
      .post(`/api/material-issues/${draftId}/return`)
      .set('Cookie', cookies.manager)
      .send({ reason: 'нельзя' })
      .expect(409);
    expect(r.body.code).toBe('MATERIAL_ISSUE_RETURN_ONLY_POSTED');

    expect(
      await t.prisma.materialIssueReturn.count({
        where: { materialIssueId: draftId },
      }),
    ).toBe(0);
  });

  // ===========================================================================
  // 7, 8. Идемпотентность + already-returned.
  // ===========================================================================

  test('повторный submit с тем же clientRequestId возвращает существующий return; новый clientRequestId после полного сторно → 409 already-returned', async () => {
    const fx = await preparePostedIssue();

    const first = await request(t.app.getHttpServer())
      .post(`/api/material-issues/${fx.issueId}/return`)
      .set('Cookie', cookies.manager)
      .send({ reason: 'излишки', clientRequestId: 'req-id-1' })
      .expect(200);

    // Повторный submit с тем же clientRequestId — тот же id, никаких
    // дополнительных движений / audit-записей.
    const second = await request(t.app.getHttpServer())
      .post(`/api/material-issues/${fx.issueId}/return`)
      .set('Cookie', cookies.manager)
      .send({ reason: 'излишки', clientRequestId: 'req-id-1' })
      .expect(200);
    expect(second.body.id).toBe(first.body.id);

    expect(
      await t.prisma.materialIssueReturn.count({
        where: { materialIssueId: fx.issueId },
      }),
    ).toBe(1);
    expect(
      await t.prisma.stockMovement.count({
        where: { type: 'REVERSAL', materialIssueId: fx.issueId },
      }),
    ).toBe(1);

    // Новый clientRequestId после уже-полного сторно — 409
    // already-returned (нет остатка к возврату).
    const third = await request(t.app.getHttpServer())
      .post(`/api/material-issues/${fx.issueId}/return`)
      .set('Cookie', cookies.manager)
      .send({ reason: 'ещё', clientRequestId: 'req-id-2' })
      .expect(409);
    expect(third.body.code).toBe('MATERIAL_ISSUE_ALREADY_RETURNED');
  });
});
