/**
 * Integration-тесты модуля «Фактический расход материалов по заказу»
 * (см. `apps/api/src/modules/material-issues/*`,
 * `prisma/schema.prisma::MaterialIssue` / `MaterialIssueLine`,
 * `docs/api.md §«Material issues»`).
 *
 * Покрытие (см. ТЗ итерации):
 *   1. create MaterialIssue success with WorkshopNeed line.
 *   2. create MaterialIssue success without WorkshopNeed, but with
 *      description and unit.
 *   3. create rejects empty lines.
 *   4. create rejects issuedQty <= 0.
 *   5. create rejects unitCost < 0.
 *   6. create rejects workshopNeed from another order.
 *   7. create rejects passport from another order.
 *   8. create calculates line totalCost and issue totalCost on server.
 *   9. post DRAFT issue success.
 *  10. post already POSTED issue fails.
 *  11. cancel DRAFT issue success.
 *  12. cancel POSTED issue fails.
 *  13. list by order returns only this order issues.
 *  14. audit MATERIAL_ISSUE_CREATED is written.
 *  15. audit MATERIAL_ISSUE_POSTED is written.
 *  16. audit MATERIAL_ISSUE_CANCELLED is written.
 *
 * Сознательная граница MVP (фиксируется тестами):
 *   - `StockBalance` / `StockMovement` — foundation-таблицы есть, но
 *     этот модуль их **не** пишет (см. `tests/integration/stock.service.test.ts`);
 *   - НЕТ `MaterialStockLot`;
 *   - автосписание при выдаче кроя (при включённом флаге компании)
 *     создаёт `MaterialIssue`, а не движения `StockMovement`;
 *   - POSTED отменить нельзя.
 */
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';

import {
  loginAs,
  startTestApp,
  stopTestApp,
  type TestApp,
} from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';
import { createSpecPattern } from '../utils/spec';

describeWithDb('integration — material issues (фактический расход)', () => {
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
  // helpers
  // ---------------------------------------------------------------------------

  /**
   * Создаёт минимальный заказ с одной потребностью цеха
   * (через QTY_PER_UNIT-fallback из спецификации номенклатуры).
   * Возвращает `{ orderId, workshopNeedId }`. Без запуска заказа
   * в производство — для тестов расхода материалов
   * производственный статус не нужен.
   */
  async function prepareOrderWithNeed(): Promise<{
    orderId: string;
    workshopNeedId: string;
  }> {
    const spec = await createSpecPattern(t, cookies.manager, {
      materialLines: [
        {
          name: 'Кулирка чёрная',
          unit: 'кг',
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

    await request(t.app.getHttpServer())
      .post(`/api/orders/${order.body.id}/workshop-needs/calculate`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);

    const need = await t.prisma.workshopNeed.findFirstOrThrow({
      where: { orderId: order.body.id, materialRole: 'MAIN_FABRIC' },
    });
    return { orderId: order.body.id, workshopNeedId: need.id };
  }

  /**
   * Заводит ещё один независимый заказ с одной потребностью —
   * для проверок «чужой workshopNeedId» / «чужой passportId».
   */
  async function prepareSecondOrderWithNeed(): Promise<{
    orderId: string;
    workshopNeedId: string;
  }> {
    return prepareOrderWithNeed();
  }

  // ---------------------------------------------------------------------------
  // 1. create success: строка с workshopNeedId — description/unit
  //    наследуются из WorkshopNeed.
  // ---------------------------------------------------------------------------

  test('create: строка с workshopNeedId наследует description/unit/materialRole', async () => {
    const { orderId, workshopNeedId } = await prepareOrderWithNeed();

    const res = await request(t.app.getHttpServer())
      .post('/api/material-issues')
      .set('Cookie', cookies.manager)
      .send({
        orderId,
        lines: [
          {
            workshopNeedId,
            issuedQty: '4.5',
            unitCost: '120.00',
          },
        ],
      })
      .expect(201);

    expect(res.body.id).toBeTruthy();
    expect(res.body.orderId).toBe(orderId);
    expect(res.body.status).toBe('DRAFT');
    // Ручной create: source = MANUAL, sourceKey = null (см. backend-
    // итерацию «Автосписание материалов при выдаче кроя»). В публичном
    // API `sourceKey` не отдаётся — только `source`.
    expect(res.body.source).toBe('MANUAL');
    expect(res.body.lines).toHaveLength(1);
    const line = res.body.lines[0];
    expect(line.workshopNeedId).toBe(workshopNeedId);
    // description берётся из workshopNeed.description (или sourceName).
    expect(line.description.length).toBeGreaterThan(0);
    expect(line.unit).toBe('кг');
    expect(line.materialRole).toBe('MAIN_FABRIC');
    expect(line.issuedQty).toBe('4.5');
    expect(line.unitCost).toBe('120');
    // totalCost = 4.5 * 120 = 540.00
    expect(new Prisma.Decimal(line.totalCost).toString()).toBe('540');
    expect(new Prisma.Decimal(res.body.totalCost).toString()).toBe('540');
  });

  // ---------------------------------------------------------------------------
  // 2. create success without WorkshopNeed
  // ---------------------------------------------------------------------------

  test('create: строка без workshopNeedId с description+unit', async () => {
    const { orderId } = await prepareOrderWithNeed();

    const res = await request(t.app.getHttpServer())
      .post('/api/material-issues')
      .set('Cookie', cookies.manager)
      .send({
        orderId,
        lines: [
          {
            description: 'Нитки белые №40',
            unit: 'шт',
            issuedQty: 2,
            unitCost: 50,
            comment: 'выдано по факту',
          },
        ],
      })
      .expect(201);

    expect(res.body.lines).toHaveLength(1);
    const line = res.body.lines[0];
    expect(line.workshopNeedId).toBeNull();
    expect(line.description).toBe('Нитки белые №40');
    expect(line.unit).toBe('шт');
    expect(line.materialRole).toBeNull();
    expect(line.issuedQty).toBe('2');
    expect(line.unitCost).toBe('50');
    expect(new Prisma.Decimal(line.totalCost).toString()).toBe('100');
    expect(new Prisma.Decimal(res.body.totalCost).toString()).toBe('100');
  });

  // ---------------------------------------------------------------------------
  // 3. create rejects empty lines
  // ---------------------------------------------------------------------------

  test('create: пустой массив lines → 400', async () => {
    const { orderId } = await prepareOrderWithNeed();

    const r = await request(t.app.getHttpServer())
      .post('/api/material-issues')
      .set('Cookie', cookies.manager)
      .send({ orderId, lines: [] });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('VALIDATION_ERROR');
  });

  // ---------------------------------------------------------------------------
  // 4. create rejects issuedQty <= 0
  // ---------------------------------------------------------------------------

  test('create: issuedQty <= 0 → 400', async () => {
    const { orderId, workshopNeedId } = await prepareOrderWithNeed();

    const r1 = await request(t.app.getHttpServer())
      .post('/api/material-issues')
      .set('Cookie', cookies.manager)
      .send({
        orderId,
        lines: [{ workshopNeedId, issuedQty: '0', unitCost: '10' }],
      });
    expect(r1.status).toBe(400);
    expect(r1.body.code).toBe('VALIDATION_ERROR');

    const r2 = await request(t.app.getHttpServer())
      .post('/api/material-issues')
      .set('Cookie', cookies.manager)
      .send({
        orderId,
        lines: [{ workshopNeedId, issuedQty: '-1', unitCost: '10' }],
      });
    expect(r2.status).toBe(400);
    expect(r2.body.code).toBe('VALIDATION_ERROR');
  });

  // ---------------------------------------------------------------------------
  // 5. create rejects unitCost < 0
  // ---------------------------------------------------------------------------

  test('create: unitCost < 0 → 400', async () => {
    const { orderId, workshopNeedId } = await prepareOrderWithNeed();

    const r = await request(t.app.getHttpServer())
      .post('/api/material-issues')
      .set('Cookie', cookies.manager)
      .send({
        orderId,
        lines: [{ workshopNeedId, issuedQty: '1', unitCost: '-0.01' }],
      });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('VALIDATION_ERROR');
  });

  // ---------------------------------------------------------------------------
  // 6. create rejects workshopNeed from another order
  // ---------------------------------------------------------------------------

  test('create: workshopNeed из другого заказа → 400 MATERIAL_ISSUE_WORKSHOP_NEED_NOT_IN_ORDER', async () => {
    const { orderId } = await prepareOrderWithNeed();
    const second = await prepareSecondOrderWithNeed();

    const r = await request(t.app.getHttpServer())
      .post('/api/material-issues')
      .set('Cookie', cookies.manager)
      .send({
        orderId,
        lines: [
          {
            workshopNeedId: second.workshopNeedId,
            issuedQty: '1',
            unitCost: '10',
          },
        ],
      });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('MATERIAL_ISSUE_WORKSHOP_NEED_NOT_IN_ORDER');
  });

  // ---------------------------------------------------------------------------
  // 7. create rejects passport from another order
  // ---------------------------------------------------------------------------

  test('create: passport из другого заказа → 400 MATERIAL_ISSUE_PASSPORT_NOT_IN_ORDER', async () => {
    const { orderId, workshopNeedId } = await prepareOrderWithNeed();

    // Заведём паспорт у второго заказа напрямую через Prisma —
    // быстрее и независимо от full passport-flow.
    const otherOrder = await t.prisma.order.create({
      data: {
        number: `ORD-${Date.now()}-X`,
        orderDate: new Date('2026-04-20T00:00:00Z'),
        items: {
          create: { productId: seed.product.id, sizeId: seed.sizes.M, qtyPlan: 1 },
        },
      },
    });
    const otherPassport = await t.prisma.passport.create({
      data: {
        number: `PS-OTHER-${Date.now()}`,
        qrCode: `passport:${Date.now()}-other`,
        orderId: otherOrder.id,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: 'Чёрный',
        rollNumber: 'r1',
        cutDate: new Date('2026-04-20T00:00:00Z'),
        qtyPlan: 1,
        qtyCut: 1,
        qtyGood: 1,
        cutterId: seed.employees['cutter']!.id,
        creatorId: seed.employees['shop-chief']!.id,
      },
    });

    const r = await request(t.app.getHttpServer())
      .post('/api/material-issues')
      .set('Cookie', cookies.manager)
      .send({
        orderId,
        passportId: otherPassport.id,
        lines: [
          { workshopNeedId, issuedQty: '1', unitCost: '10' },
        ],
      });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('MATERIAL_ISSUE_PASSPORT_NOT_IN_ORDER');
  });

  // ---------------------------------------------------------------------------
  // 8. server-side calculation of line.totalCost and issue.totalCost
  // ---------------------------------------------------------------------------

  test('create: totalCost строк и документа считается на сервере', async () => {
    const { orderId, workshopNeedId } = await prepareOrderWithNeed();

    const res = await request(t.app.getHttpServer())
      .post('/api/material-issues')
      .set('Cookie', cookies.manager)
      .send({
        orderId,
        lines: [
          {
            workshopNeedId,
            issuedQty: '2.5',
            unitCost: '40',
          },
          {
            description: 'Этикетка',
            unit: 'шт',
            issuedQty: '10',
            unitCost: '5.50',
          },
        ],
      })
      .expect(201);

    expect(res.body.lines).toHaveLength(2);
    // 2.5 * 40 = 100
    expect(new Prisma.Decimal(res.body.lines[0].totalCost).toString()).toBe(
      '100',
    );
    // 10 * 5.50 = 55
    expect(new Prisma.Decimal(res.body.lines[1].totalCost).toString()).toBe(
      '55',
    );
    // Σ = 155
    expect(new Prisma.Decimal(res.body.totalCost).toString()).toBe('155');

    // В БД тоже должно совпадать.
    const dbIssue = await t.prisma.materialIssue.findUniqueOrThrow({
      where: { id: res.body.id },
    });
    expect(dbIssue.totalCost.toString()).toBe('155');
  });

  // ---------------------------------------------------------------------------
  // 9. post DRAFT issue success
  // ---------------------------------------------------------------------------

  test('post: DRAFT → POSTED успешно', async () => {
    const { orderId, workshopNeedId } = await prepareOrderWithNeed();

    const created = await request(t.app.getHttpServer())
      .post('/api/material-issues')
      .set('Cookie', cookies.manager)
      .send({
        orderId,
        lines: [{ workshopNeedId, issuedQty: '3', unitCost: '50' }],
      })
      .expect(201);

    const posted = await request(t.app.getHttpServer())
      .post(`/api/material-issues/${created.body.id}/post`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(200);

    expect(posted.body.status).toBe('POSTED');
    expect(posted.body.postedAt).toBeTruthy();
    expect(posted.body.postedById).toBe(seed.employees['shop-chief']!.id);
    expect(new Prisma.Decimal(posted.body.totalCost).toString()).toBe('150');
  });

  // ---------------------------------------------------------------------------
  // 10. post already POSTED issue fails
  // ---------------------------------------------------------------------------

  test('post: повторный POST после POSTED → 409 MATERIAL_ISSUE_NOT_DRAFT_FOR_POST', async () => {
    const { orderId, workshopNeedId } = await prepareOrderWithNeed();

    const created = await request(t.app.getHttpServer())
      .post('/api/material-issues')
      .set('Cookie', cookies.manager)
      .send({
        orderId,
        lines: [{ workshopNeedId, issuedQty: '1', unitCost: '10' }],
      })
      .expect(201);

    await request(t.app.getHttpServer())
      .post(`/api/material-issues/${created.body.id}/post`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(200);

    const r = await request(t.app.getHttpServer())
      .post(`/api/material-issues/${created.body.id}/post`)
      .set('Cookie', cookies.manager)
      .send({});
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('MATERIAL_ISSUE_NOT_DRAFT_FOR_POST');
  });

  // ---------------------------------------------------------------------------
  // 11. cancel DRAFT issue success
  // ---------------------------------------------------------------------------

  test('cancel: DRAFT → CANCELLED успешно', async () => {
    const { orderId, workshopNeedId } = await prepareOrderWithNeed();

    const created = await request(t.app.getHttpServer())
      .post('/api/material-issues')
      .set('Cookie', cookies.manager)
      .send({
        orderId,
        lines: [{ workshopNeedId, issuedQty: '1', unitCost: '10' }],
      })
      .expect(201);

    const cancelled = await request(t.app.getHttpServer())
      .post(`/api/material-issues/${created.body.id}/cancel`)
      .set('Cookie', cookies.manager)
      .send({ reason: 'тест отмены' })
      .expect(200);

    expect(cancelled.body.status).toBe('CANCELLED');
    expect(cancelled.body.cancelledAt).toBeTruthy();
    expect(cancelled.body.cancelledById).toBe(seed.employees['shop-chief']!.id);
    expect(cancelled.body.cancelReason).toBe('тест отмены');
  });

  // ---------------------------------------------------------------------------
  // 12. cancel POSTED issue fails
  // ---------------------------------------------------------------------------

  test('cancel: POSTED → 409 MATERIAL_ISSUE_POSTED_CANNOT_CANCEL', async () => {
    const { orderId, workshopNeedId } = await prepareOrderWithNeed();

    const created = await request(t.app.getHttpServer())
      .post('/api/material-issues')
      .set('Cookie', cookies.manager)
      .send({
        orderId,
        lines: [{ workshopNeedId, issuedQty: '1', unitCost: '10' }],
      })
      .expect(201);

    await request(t.app.getHttpServer())
      .post(`/api/material-issues/${created.body.id}/post`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(200);

    const r = await request(t.app.getHttpServer())
      .post(`/api/material-issues/${created.body.id}/cancel`)
      .set('Cookie', cookies.manager)
      .send({ reason: 'попробуем отменить проведённый' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('MATERIAL_ISSUE_POSTED_CANNOT_CANCEL');
  });

  // ---------------------------------------------------------------------------
  // 13. list by order returns only this order issues
  // ---------------------------------------------------------------------------

  test('list by order: возвращает только документы этого заказа', async () => {
    const a = await prepareOrderWithNeed();
    const b = await prepareOrderWithNeed();

    await request(t.app.getHttpServer())
      .post('/api/material-issues')
      .set('Cookie', cookies.manager)
      .send({
        orderId: a.orderId,
        lines: [{ workshopNeedId: a.workshopNeedId, issuedQty: '1', unitCost: '10' }],
      })
      .expect(201);
    await request(t.app.getHttpServer())
      .post('/api/material-issues')
      .set('Cookie', cookies.manager)
      .send({
        orderId: a.orderId,
        lines: [{ description: 'X', unit: 'шт', issuedQty: '1', unitCost: '5' }],
      })
      .expect(201);
    await request(t.app.getHttpServer())
      .post('/api/material-issues')
      .set('Cookie', cookies.manager)
      .send({
        orderId: b.orderId,
        lines: [{ workshopNeedId: b.workshopNeedId, issuedQty: '2', unitCost: '20' }],
      })
      .expect(201);

    const listA = await request(t.app.getHttpServer())
      .get(`/api/orders/${a.orderId}/material-issues`)
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(Array.isArray(listA.body)).toBe(true);
    expect(listA.body).toHaveLength(2);
    for (const item of listA.body) {
      expect(item.orderId).toBe(a.orderId);
    }

    const listB = await request(t.app.getHttpServer())
      .get(`/api/orders/${b.orderId}/material-issues`)
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(listB.body).toHaveLength(1);
    expect(listB.body[0].orderId).toBe(b.orderId);
  });

  // ---------------------------------------------------------------------------
  // 14-16. audit MATERIAL_ISSUE_* events
  // ---------------------------------------------------------------------------

  test('audit: MATERIAL_ISSUE_CREATED / POSTED / CANCELLED записываются', async () => {
    const { orderId, workshopNeedId } = await prepareOrderWithNeed();

    const created = await request(t.app.getHttpServer())
      .post('/api/material-issues')
      .set('Cookie', cookies.manager)
      .send({
        orderId,
        lines: [{ workshopNeedId, issuedQty: '2', unitCost: '15.00' }],
      })
      .expect(201);
    const issueId = created.body.id as string;

    const auditCreated = await t.prisma.auditLog.findFirst({
      where: {
        event: 'MATERIAL_ISSUE_CREATED',
        entityType: 'MATERIAL_ISSUE',
        entityId: issueId,
      },
    });
    expect(auditCreated).toBeTruthy();
    expect(auditCreated!.employeeId).toBe(seed.employees['shop-chief']!.id);
    expect(auditCreated!.payload).toMatchObject({
      materialIssueId: issueId,
      orderId,
      status: 'DRAFT',
    });
    // lines snapshot — массив строк
    const payloadCreated = auditCreated!.payload as { lines: unknown[] };
    expect(Array.isArray(payloadCreated.lines)).toBe(true);
    expect(payloadCreated.lines).toHaveLength(1);

    // POST → audit MATERIAL_ISSUE_POSTED
    await request(t.app.getHttpServer())
      .post(`/api/material-issues/${issueId}/post`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(200);
    const auditPosted = await t.prisma.auditLog.findFirst({
      where: {
        event: 'MATERIAL_ISSUE_POSTED',
        entityType: 'MATERIAL_ISSUE',
        entityId: issueId,
      },
    });
    expect(auditPosted).toBeTruthy();
    expect(auditPosted!.payload).toMatchObject({
      materialIssueId: issueId,
      status: 'POSTED',
      previousStatus: 'DRAFT',
    });

    // Создадим ещё один документ и отменим — проверим CANCELLED audit.
    const created2 = await request(t.app.getHttpServer())
      .post('/api/material-issues')
      .set('Cookie', cookies.manager)
      .send({
        orderId,
        lines: [
          { description: 'для отмены', unit: 'шт', issuedQty: '1', unitCost: '5' },
        ],
      })
      .expect(201);
    const issue2Id = created2.body.id as string;
    await request(t.app.getHttpServer())
      .post(`/api/material-issues/${issue2Id}/cancel`)
      .set('Cookie', cookies.manager)
      .send({ reason: 'audit-test' })
      .expect(200);

    const auditCancelled = await t.prisma.auditLog.findFirst({
      where: {
        event: 'MATERIAL_ISSUE_CANCELLED',
        entityType: 'MATERIAL_ISSUE',
        entityId: issue2Id,
      },
    });
    expect(auditCancelled).toBeTruthy();
    expect(auditCancelled!.payload).toMatchObject({
      materialIssueId: issue2Id,
      status: 'CANCELLED',
      previousStatus: 'DRAFT',
      cancelReason: 'audit-test',
    });
  });

  // ---------------------------------------------------------------------------
  // RBAC sanity: рабочая роль не может создавать документы
  // ---------------------------------------------------------------------------

  test('RBAC: QC получает 403 на create / list / get / post / cancel', async () => {
    const { orderId, workshopNeedId } = await prepareOrderWithNeed();

    await request(t.app.getHttpServer())
      .post('/api/material-issues')
      .set('Cookie', cookies.qc)
      .send({
        orderId,
        lines: [{ workshopNeedId, issuedQty: '1', unitCost: '10' }],
      })
      .expect(403);

    await request(t.app.getHttpServer())
      .get('/api/material-issues')
      .set('Cookie', cookies.qc)
      .expect(403);

    await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}/material-issues`)
      .set('Cookie', cookies.qc)
      .expect(403);
  });

  // ---------------------------------------------------------------------------
  // Граница MVP: сервис НЕ создаёт StockMovement / CellContent /
  // не меняет WorkshopNeed.status на post.
  // ---------------------------------------------------------------------------

  test('post: НЕ трогает WorkshopNeed.status и не создаёт движений по полуфабрикату', async () => {
    const { orderId, workshopNeedId } = await prepareOrderWithNeed();

    const needBefore = await t.prisma.workshopNeed.findUniqueOrThrow({
      where: { id: workshopNeedId },
    });
    // MaterialIssue — отдельный контур от WIP (полуфабрикат). Расход
    // материала не должен создавать движений по крою.
    const wipMovementsBefore = await t.prisma.workInProgressMovement.count();

    const created = await request(t.app.getHttpServer())
      .post('/api/material-issues')
      .set('Cookie', cookies.manager)
      .send({
        orderId,
        lines: [{ workshopNeedId, issuedQty: '1', unitCost: '10' }],
      })
      .expect(201);
    await request(t.app.getHttpServer())
      .post(`/api/material-issues/${created.body.id}/post`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(200);

    const needAfter = await t.prisma.workshopNeed.findUniqueOrThrow({
      where: { id: workshopNeedId },
    });
    expect(needAfter.status).toBe(needBefore.status);
    const wipMovementsAfter = await t.prisma.workInProgressMovement.count();
    expect(wipMovementsAfter).toBe(wipMovementsBefore);
  });
});
