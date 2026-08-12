/**
 * Integration-тесты итерации «Частичный возврат проведённого
 * MaterialIssue» (см. ТЗ).
 *
 * Source-of-truth:
 *   - apps/api/src/modules/material-issues/material-issues.service.ts::returnPostedIssue
 *   - apps/api/src/modules/material-issues/dto/return-material-issue.dto.ts
 *   - apps/api/src/modules/stock/stock.service.ts::recordMaterialIssueReturnInTx
 *   - prisma/schema.prisma::MaterialIssueReturn / MaterialIssueReturnLine
 *
 * Покрытие (по ТЗ §10 «Tests»):
 *   1. Partial works for POSTED issue.
 *   2. Создаёт MaterialIssueReturnLine только для выбранных строк.
 *   3. returnedQty < remaining → returnStatus = PARTIAL.
 *   4. Return remaining later → returnStatus = FULL.
 *   5. returnedQty > available → 409.
 *   6. Дубль materialIssueLineId в request → 409.
 *   7. materialIssueLineId из другого issue → 409.
 *   9. StockMovement REVERSAL IN с partial qty.
 *  10. StockBalance увеличивается ровно на partial qty.
 *  11. netTotalCost учитывает только partial.
 *  15. Идемпотентность по clientRequestId.
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
import { createSpecPattern } from '../utils/spec';

describeWithDb('integration — material issue partial return', () => {
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
   * Готовит проведённый MaterialIssue с ОДНОЙ строкой:
   * списано 10 м, unitCost 500, total 5000, ячейка A1.
   * До этого приёмка положила 20 м → баланс 10 м после post.
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

    const spec = await createSpecPattern(t, cookies.manager, {
      materialLines: [
        {
          name: 'Кулирка',
          unit: 'м',
          qtyPerUnit: '0.5',
          materialRole: 'MAIN_FABRIC',
          colorRule: 'ORDER_COLOR',
        },
      ],
    });
    const order = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookies.manager)
      .send({
        orderDate: '2026-04-15T00:00:00.000Z',
        productId: seed.product.id,
        color: 'Чёрный',
        items: [{ sizeId: seed.sizes.M, qtyPlan: 10 }],
        patternItemId: spec.id,
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
            issuedQty: '10',
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
  // 1, 2, 3, 9, 10, 11. Happy path: возврат 4 из 10 → PARTIAL.
  // ===========================================================================

  test('partial return PARTIAL: возвращаем 4 из 10, REVERSAL IN на 4, баланс +4, netTotalCost = 3000', async () => {
    const fx = await preparePostedIssue();

    // Баланс после post: 20 − 10 = 10 м.
    const balanceBefore = await t.prisma.stockBalance.findFirstOrThrow({
      where: { workshopNeedId: fx.workshopNeedId, cellId: fx.cellId },
    });
    expect(new Prisma.Decimal(balanceBefore.qty).toString()).toBe('10');

    const res = await request(t.app.getHttpServer())
      .post(`/api/material-issues/${fx.issueId}/return`)
      .set('Cookie', cookies.manager)
      .send({
        reason: 'излишки',
        clientRequestId: 'partial-A',
        lines: [
          {
            materialIssueLineId: fx.issueLineId,
            returnedQty: '4',
          },
        ],
      })
      .expect(200);

    expect(res.body.status).toBe('POSTED');
    expect(res.body.lines).toHaveLength(1);
    const retLine = res.body.lines[0]!;
    expect(retLine.materialIssueLineId).toBe(fx.issueLineId);
    expect(new Prisma.Decimal(retLine.returnedQty).toString()).toBe('4');
    expect(new Prisma.Decimal(retLine.totalCost).toString()).toBe('2000');
    // sourceKey не отдаётся.
    expect(res.body.sourceKey).toBeUndefined();

    // REVERSAL IN на 4.
    const reversal = await t.prisma.stockMovement.findFirstOrThrow({
      where: {
        sourceKey: buildMaterialIssueReturnLineStockSourceKey(retLine.id),
      },
    });
    expect(reversal.direction).toBe('IN');
    expect(reversal.type).toBe('REVERSAL');
    expect(new Prisma.Decimal(reversal.qty).toString()).toBe('4');
    expect(reversal.cellId).toBe(fx.cellId);

    // Баланс +4.
    const balanceAfter = await t.prisma.stockBalance.findFirstOrThrow({
      where: { workshopNeedId: fx.workshopNeedId, cellId: fx.cellId },
    });
    expect(new Prisma.Decimal(balanceAfter.qty).toString()).toBe('14');

    // DTO: returnStatus = PARTIAL, netTotalCost = 5000 − 2000 = 3000.
    const detail = await request(t.app.getHttpServer())
      .get(`/api/material-issues/${fx.issueId}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(detail.body.returnStatus).toBe('PARTIAL');
    expect(new Prisma.Decimal(detail.body.totalCost).toString()).toBe('5000');
    expect(new Prisma.Decimal(detail.body.returnedTotalCost).toString()).toBe(
      '2000',
    );
    expect(new Prisma.Decimal(detail.body.netTotalCost).toString()).toBe('3000');
    // line-level net.
    expect(
      new Prisma.Decimal(detail.body.lines[0].netIssuedQty).toString(),
    ).toBe('6');
  });

  // ===========================================================================
  // 4. Догнать остаток → FULL.
  // ===========================================================================

  test('догнать остаток вторым возвратом → returnStatus = FULL', async () => {
    const fx = await preparePostedIssue();

    await request(t.app.getHttpServer())
      .post(`/api/material-issues/${fx.issueId}/return`)
      .set('Cookie', cookies.manager)
      .send({
        reason: 'часть 1',
        clientRequestId: 'partial-1',
        lines: [{ materialIssueLineId: fx.issueLineId, returnedQty: '4' }],
      })
      .expect(200);

    await request(t.app.getHttpServer())
      .post(`/api/material-issues/${fx.issueId}/return`)
      .set('Cookie', cookies.manager)
      .send({
        reason: 'часть 2',
        clientRequestId: 'partial-2',
        lines: [{ materialIssueLineId: fx.issueLineId, returnedQty: '6' }],
      })
      .expect(200);

    const detail = await request(t.app.getHttpServer())
      .get(`/api/material-issues/${fx.issueId}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(detail.body.returnStatus).toBe('FULL');
    expect(new Prisma.Decimal(detail.body.netTotalCost).toString()).toBe('0');
    expect(detail.body.returns).toHaveLength(2);

    // Баланс вернулся к 20 (было 10 после post).
    const balance = await t.prisma.stockBalance.findFirstOrThrow({
      where: { workshopNeedId: fx.workshopNeedId, cellId: fx.cellId },
    });
    expect(new Prisma.Decimal(balance.qty).toString()).toBe('20');
  });

  // ===========================================================================
  // 5. returnedQty > availableToReturn → 409.
  // ===========================================================================

  test('returnedQty больше остатка → 409 MATERIAL_ISSUE_RETURN_QTY_EXCEEDS_AVAILABLE', async () => {
    const fx = await preparePostedIssue();
    const r = await request(t.app.getHttpServer())
      .post(`/api/material-issues/${fx.issueId}/return`)
      .set('Cookie', cookies.manager)
      .send({
        reason: 'много',
        clientRequestId: 'over',
        lines: [
          { materialIssueLineId: fx.issueLineId, returnedQty: '11' }, // issued 10
        ],
      })
      .expect(409);
    expect(r.body.code).toBe('MATERIAL_ISSUE_RETURN_QTY_EXCEEDS_AVAILABLE');
    expect(r.body.details).toMatchObject({
      materialIssueLineId: fx.issueLineId,
      requestedQty: '11',
      availableQty: '10',
    });
    // Не создан ни Return, ни StockMovement.
    expect(
      await t.prisma.materialIssueReturn.count({
        where: { materialIssueId: fx.issueId },
      }),
    ).toBe(0);
  });

  // ===========================================================================
  // 6. Дубль materialIssueLineId → 409.
  // ===========================================================================

  test('дубль materialIssueLineId → 409 MATERIAL_ISSUE_RETURN_DUPLICATE_LINE', async () => {
    const fx = await preparePostedIssue();
    const r = await request(t.app.getHttpServer())
      .post(`/api/material-issues/${fx.issueId}/return`)
      .set('Cookie', cookies.manager)
      .send({
        reason: 'дубль',
        clientRequestId: 'dup',
        lines: [
          { materialIssueLineId: fx.issueLineId, returnedQty: '2' },
          { materialIssueLineId: fx.issueLineId, returnedQty: '3' },
        ],
      })
      .expect(409);
    expect(r.body.code).toBe('MATERIAL_ISSUE_RETURN_DUPLICATE_LINE');
  });

  // ===========================================================================
  // 7. materialIssueLineId из другого issue → 409.
  // ===========================================================================

  test('строка из другого MaterialIssue → 409 MATERIAL_ISSUE_RETURN_LINE_NOT_FOUND', async () => {
    const fx = await preparePostedIssue();
    // Создаём ещё один документ с другой строкой.
    const otherDraft = await request(t.app.getHttpServer())
      .post('/api/material-issues')
      .set('Cookie', cookies.manager)
      .send({
        orderId: fx.orderId,
        lines: [
          {
            workshopNeedId: fx.workshopNeedId,
            issuedQty: '1',
            unitCost: '500',
            cellId: fx.cellId,
          },
        ],
      })
      .expect(201);
    const otherLineId = otherDraft.body.lines[0].id as string;

    const r = await request(t.app.getHttpServer())
      .post(`/api/material-issues/${fx.issueId}/return`)
      .set('Cookie', cookies.manager)
      .send({
        reason: 'другая строка',
        clientRequestId: 'foreign',
        lines: [
          { materialIssueLineId: otherLineId, returnedQty: '1' },
        ],
      })
      .expect(409);
    expect(r.body.code).toBe('MATERIAL_ISSUE_RETURN_LINE_NOT_FOUND');
  });

  // ===========================================================================
  // 15. Идемпотентность partial по clientRequestId.
  // ===========================================================================

  test('повторный partial с тем же clientRequestId → существующий return, баланс не двигается дважды', async () => {
    const fx = await preparePostedIssue();

    const first = await request(t.app.getHttpServer())
      .post(`/api/material-issues/${fx.issueId}/return`)
      .set('Cookie', cookies.manager)
      .send({
        reason: 'idempo',
        clientRequestId: 'partial-idempo',
        lines: [{ materialIssueLineId: fx.issueLineId, returnedQty: '3' }],
      })
      .expect(200);

    const second = await request(t.app.getHttpServer())
      .post(`/api/material-issues/${fx.issueId}/return`)
      .set('Cookie', cookies.manager)
      .send({
        reason: 'idempo',
        clientRequestId: 'partial-idempo',
        lines: [{ materialIssueLineId: fx.issueLineId, returnedQty: '3' }],
      })
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
    const balance = await t.prisma.stockBalance.findFirstOrThrow({
      where: { workshopNeedId: fx.workshopNeedId, cellId: fx.cellId },
    });
    // 10 + 3 = 13 (а не 16).
    expect(new Prisma.Decimal(balance.qty).toString()).toBe('13');
  });
});
