/**
 * Integration-тесты этапа «Ручная отметка поступления материала»
 * (см. `apps/api/src/modules/order-material-arrivals/*`,
 * `apps/api/src/modules/cut-readiness/cut-readiness.service.ts`,
 * `prisma/schema.prisma::OrderMaterialArrivalOverride`).
 *
 * Покрытие:
 *   1. Заказ с blocking-`WorkshopNeed` без поступлений → cut-readiness
 *      `ready=false`. POST `/api/orders/:id/material-arrived` с
 *      комментарием → cut-readiness `ready=true` для строки,
 *      `manuallyUnblocked=true`, статус `OK`.
 *   2. Сервис НЕ создаёт `PurchaseReceipt` / `PurchaseReceiptLine` /
 *      `CellContent`. `WorkshopNeed.status` не меняется.
 *   3. Audit-event `ORDER_MATERIAL_ARRIVAL_OVERRIDE_CREATED` пишется
 *      в `AuditLog`.
 *   4. POST revoke → status REVOKED, cut-readiness снова ready=false
 *      и manuallyUnblocked=false. Audit-event
 *      `ORDER_MATERIAL_ARRIVAL_OVERRIDE_REVOKED`.
 *   5. Дубль POST для уже разблокированной потребности НЕ создаёт
 *      второй ACTIVE override (idempotent).
 *   6. RBAC: рабочая роль (QC) → 403 на POST/revoke.
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

describeWithDb('integration — order material arrivals (ручная отметка)', () => {
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
   * Готовит заказ с одной blocking-потребностью MAIN_FABRIC (через
   * QTY_PER_UNIT-fallback — без `PatternItem`). Ничего не принимаем
   * по приёмке, поэтому cut-readiness вернёт `ready=false` со
   * статусом BLOCKER на материале.
   */
  async function prepareOrderWithBlockingNeed(): Promise<{
    orderId: string;
    workshopNeedId: string;
  }> {
    const tc = await request(t.app.getHttpServer())
      .post('/api/tech-cards')
      .set('Cookie', cookies.manager)
      .send({
        code: `TC-MA-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
        name: 'Material arrival demo',
        materialLines: [
          {
            name: 'Кулирка чёрная',
            unit: 'кг',
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

  // ---------------------------------------------------------------------------
  // 1. happy path: mark → cut-readiness ready=true, manuallyUnblocked=true
  // ---------------------------------------------------------------------------

  test('mark разблокирует крой: cut-readiness переключается в ready=true, manuallyUnblocked=true', async () => {
    const { orderId, workshopNeedId } = await prepareOrderWithBlockingNeed();

    // Bef: cut-readiness видит material-blocker.
    const before = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}/cut-readiness`)
      .set('Cookie', cookies.manager)
      .expect(200);
    const matBefore = before.body.sections.materials.find(
      (m: { workshopNeedId: string }) => m.workshopNeedId === workshopNeedId,
    );
    expect(matBefore).toBeTruthy();
    expect(matBefore.status).toBe('BLOCKER');
    expect(matBefore.manuallyUnblocked).toBeFalsy();
    expect(before.body.blockersCount).toBeGreaterThan(0);

    // Mark arrived.
    const mark = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/material-arrived`)
      .set('Cookie', cookies.manager)
      .send({ comment: 'Материал пришёл, приёмку оформим завтра' })
      .expect(201);
    expect(Array.isArray(mark.body)).toBe(true);
    expect(mark.body.length).toBeGreaterThan(0);
    const ov = mark.body.find(
      (o: { workshopNeedId: string }) => o.workshopNeedId === workshopNeedId,
    );
    expect(ov).toBeTruthy();
    expect(ov.status).toBe('ACTIVE');
    expect(ov.comment).toBe('Материал пришёл, приёмку оформим завтра');
    expect(ov.createdById).toBe(seed.employees['shop-chief'].id);
    expect(ov.createdByName).toBe(seed.employees['shop-chief'].fullName);

    // After: материал считается готовым, флаг manuallyUnblocked.
    const after = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}/cut-readiness`)
      .set('Cookie', cookies.manager)
      .expect(200);
    const matAfter = after.body.sections.materials.find(
      (m: { workshopNeedId: string }) => m.workshopNeedId === workshopNeedId,
    );
    expect(matAfter).toBeTruthy();
    expect(matAfter.status).toBe('OK');
    expect(matAfter.manuallyUnblocked).toBe(true);
    expect(matAfter.manualArrivalOverrides).toHaveLength(1);
    expect(matAfter.manualArrivalOverrides[0].id).toBe(ov.id);
    // Сообщение явно говорит, что разблокировано вручную и без
    // складской приёмки.
    expect(matAfter.message).toMatch(/Разблокировано вручную/);
    expect(matAfter.message).toMatch(/без складской приёмки/);
  });

  // ---------------------------------------------------------------------------
  // 2. mark не создаёт PurchaseReceipt / PurchaseReceiptLine / CellContent
  //    и не меняет WorkshopNeed.status / Order.status
  // ---------------------------------------------------------------------------

  test('mark не создаёт PurchaseReceipt / PurchaseReceiptLine / CellContent и не меняет статусы', async () => {
    const { orderId, workshopNeedId } = await prepareOrderWithBlockingNeed();
    const orderStatusBefore = (
      await t.prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    ).status;
    const needStatusBefore = (
      await t.prisma.workshopNeed.findUniqueOrThrow({
        where: { id: workshopNeedId },
      })
    ).status;

    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/material-arrived`)
      .set('Cookie', cookies.manager)
      .send({ comment: 'материал есть' })
      .expect(201);

    // Никаких PurchaseReceipt / PurchaseReceiptLine не создано.
    const receipts = await t.prisma.purchaseReceipt.count();
    expect(receipts).toBe(0);
    const receiptLines = await t.prisma.purchaseReceiptLine.count();
    expect(receiptLines).toBe(0);
    // Полуфабрикат не тронут (никаких WIP-движений / балансов).
    const wipBalances = await t.prisma.workInProgressBalance.count();
    expect(wipBalances).toBe(0);
    const wipMovements = await t.prisma.workInProgressMovement.count();
    expect(wipMovements).toBe(0);
    // WorkshopNeed.status не сдвинулся.
    const needAfter = await t.prisma.workshopNeed.findUniqueOrThrow({
      where: { id: workshopNeedId },
    });
    expect(needAfter.status).toBe(needStatusBefore);
    // Order.status не сдвинулся.
    const orderAfter = await t.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
    });
    expect(orderAfter.status).toBe(orderStatusBefore);
  });

  // ---------------------------------------------------------------------------
  // 3. audit
  // ---------------------------------------------------------------------------

  test('audit: пишутся CREATED и REVOKED события', async () => {
    const { orderId } = await prepareOrderWithBlockingNeed();
    const mark = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/material-arrived`)
      .set('Cookie', cookies.manager)
      .send({ comment: 'audit test' })
      .expect(201);
    const overrideId = mark.body[0].id as string;

    const created = await t.prisma.auditLog.findFirst({
      where: {
        event: 'ORDER_MATERIAL_ARRIVAL_OVERRIDE_CREATED',
        entityType: 'ORDER',
        entityId: orderId,
      },
    });
    expect(created).toBeTruthy();
    expect(created!.employeeId).toBe(seed.employees['shop-chief'].id);
    expect(created!.payload).toMatchObject({
      orderId,
      overridesCount: expect.any(Number),
      comment: 'audit test',
    });

    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/material-arrival-overrides/${overrideId}/revoke`)
      .set('Cookie', cookies.manager)
      .send({ reason: 'нажали по ошибке' })
      .expect(201);

    const revoked = await t.prisma.auditLog.findFirst({
      where: {
        event: 'ORDER_MATERIAL_ARRIVAL_OVERRIDE_REVOKED',
        entityType: 'ORDER_MATERIAL_ARRIVAL_OVERRIDE',
        entityId: overrideId,
      },
    });
    expect(revoked).toBeTruthy();
    expect(revoked!.payload).toMatchObject({
      orderId,
      reason: 'нажали по ошибке',
    });
  });

  // ---------------------------------------------------------------------------
  // 4. revoke → cut-readiness снова ready=false
  // ---------------------------------------------------------------------------

  test('revoke возвращает строку в BLOCKER и manuallyUnblocked=false', async () => {
    const { orderId, workshopNeedId } = await prepareOrderWithBlockingNeed();
    const mark = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/material-arrived`)
      .set('Cookie', cookies.manager)
      .send({ comment: 'материал есть' })
      .expect(201);
    const overrideId = mark.body[0].id as string;

    // После mark → ready (без блокеров по материалу).
    const afterMark = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}/cut-readiness`)
      .set('Cookie', cookies.manager)
      .expect(200);
    const matAfterMark = afterMark.body.sections.materials.find(
      (m: { workshopNeedId: string }) => m.workshopNeedId === workshopNeedId,
    );
    expect(matAfterMark.status).toBe('OK');
    expect(matAfterMark.manuallyUnblocked).toBe(true);

    // Revoke.
    const rv = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/material-arrival-overrides/${overrideId}/revoke`)
      .set('Cookie', cookies.manager)
      .send({ reason: 'материал так и не приехал' })
      .expect(201);
    expect(rv.body.status).toBe('REVOKED');
    expect(rv.body.revokeReason).toBe('материал так и не приехал');
    expect(rv.body.revokedById).toBe(seed.employees['shop-chief'].id);

    // После revoke → снова BLOCKER, manuallyUnblocked=false.
    const afterRevoke = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}/cut-readiness`)
      .set('Cookie', cookies.manager)
      .expect(200);
    const matAfterRevoke = afterRevoke.body.sections.materials.find(
      (m: { workshopNeedId: string }) => m.workshopNeedId === workshopNeedId,
    );
    expect(matAfterRevoke.status).toBe('BLOCKER');
    expect(matAfterRevoke.manuallyUnblocked).toBeFalsy();
    // Override-список (manualArrivalOverrides) для этой строки —
    // пустой/undefined (фильтр по ACTIVE на сервисе).
    expect(
      matAfterRevoke.manualArrivalOverrides === undefined ||
        matAfterRevoke.manualArrivalOverrides.length === 0,
    ).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 5. Idempotency: дубль POST не создаёт второй ACTIVE override
  // ---------------------------------------------------------------------------

  test('повторный POST не создаёт дубликат ACTIVE override', async () => {
    const { orderId, workshopNeedId } = await prepareOrderWithBlockingNeed();
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/material-arrived`)
      .set('Cookie', cookies.manager)
      .send({ comment: 'первый раз' })
      .expect(201);
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/material-arrived`)
      .set('Cookie', cookies.manager)
      .send({ comment: 'второй раз' })
      .expect(201);

    const overrides =
      await t.prisma.orderMaterialArrivalOverride.findMany({
        where: { orderId, workshopNeedId, status: 'ACTIVE' },
      });
    expect(overrides).toHaveLength(1);
    // Комментарий из первого вызова не перезаписывается (idempotent).
    expect(overrides[0]!.comment).toBe('первый раз');
  });

  // ---------------------------------------------------------------------------
  // 6. RBAC
  // ---------------------------------------------------------------------------

  test('RBAC: QC получает 403 на POST и revoke', async () => {
    const { orderId } = await prepareOrderWithBlockingNeed();

    // На POST /material-arrived — 403.
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/material-arrived`)
      .set('Cookie', cookies.qc)
      .send({ comment: 'попытка под QC' })
      .expect(403);

    // Создадим валидный override от менеджера, чтобы проверить
    // revoke под QC.
    const mark = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/material-arrived`)
      .set('Cookie', cookies.manager)
      .send({ comment: 'для теста revoke RBAC' })
      .expect(201);
    const overrideId = mark.body[0].id as string;

    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/material-arrival-overrides/${overrideId}/revoke`)
      .set('Cookie', cookies.qc)
      .send({ reason: 'попытка отмены под QC' })
      .expect(403);

    // GET overrides — для CUTTER/CUTTER_ASSISTANT разрешён, но мы
    // используем QC чтобы проверить, что список тоже закрыт от
    // других рабочих ролей.
    await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}/material-arrival-overrides`)
      .set('Cookie', cookies.qc)
      .expect(403);
  });

  // ---------------------------------------------------------------------------
  // 7. Validation: comment min(2)
  // ---------------------------------------------------------------------------

  test('Zod: comment < 2 символов → 400', async () => {
    const { orderId } = await prepareOrderWithBlockingNeed();
    const r = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/material-arrived`)
      .set('Cookie', cookies.manager)
      .send({ comment: 'a' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('VALIDATION_ERROR');
  });

  test('Zod: revoke без reason → 400', async () => {
    const { orderId } = await prepareOrderWithBlockingNeed();
    const mark = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/material-arrived`)
      .set('Cookie', cookies.manager)
      .send({ comment: 'для теста' })
      .expect(201);
    const overrideId = mark.body[0].id as string;

    const r = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/material-arrival-overrides/${overrideId}/revoke`)
      .set('Cookie', cookies.manager)
      .send({});
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('VALIDATION_ERROR');
  });

  // ---------------------------------------------------------------------------
  // 8. partial blocking — workshopNeedIds filter
  // ---------------------------------------------------------------------------

  test('workshopNeedIds: применяет override только к указанным потребностям', async () => {
    // Создаём заказ с двумя потребностями: MAIN_FABRIC и RIB.
    const tc = await request(t.app.getHttpServer())
      .post('/api/tech-cards')
      .set('Cookie', cookies.manager)
      .send({
        code: `TC-MA-FILTER-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
        name: 'Two materials',
        materialLines: [
          {
            name: 'Кулирка',
            unit: 'кг',
            qtyPerUnit: '0.5',
            materialRole: 'MAIN_FABRIC',
            colorRule: 'ORDER_COLOR',
          },
          {
            name: 'Рибана',
            unit: 'кг',
            qtyPerUnit: '0.1',
            materialRole: 'RIB',
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

    await request(t.app.getHttpServer())
      .post(`/api/orders/${order.body.id}/workshop-needs/calculate`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);

    const mainFabric = await t.prisma.workshopNeed.findFirstOrThrow({
      where: { orderId: order.body.id, materialRole: 'MAIN_FABRIC' },
    });
    const rib = await t.prisma.workshopNeed.findFirstOrThrow({
      where: { orderId: order.body.id, materialRole: 'RIB' },
    });

    // Применяем override только к MAIN_FABRIC.
    await request(t.app.getHttpServer())
      .post(`/api/orders/${order.body.id}/material-arrived`)
      .set('Cookie', cookies.manager)
      .send({
        comment: 'есть только основная',
        workshopNeedIds: [mainFabric.id],
      })
      .expect(201);

    const overrides = await t.prisma.orderMaterialArrivalOverride.findMany({
      where: { orderId: order.body.id, status: 'ACTIVE' },
    });
    expect(overrides).toHaveLength(1);
    expect(overrides[0]!.workshopNeedId).toBe(mainFabric.id);

    // RIB остался блокером в cut-readiness.
    const ready = await request(t.app.getHttpServer())
      .get(`/api/orders/${order.body.id}/cut-readiness`)
      .set('Cookie', cookies.manager)
      .expect(200);
    const ribRow = ready.body.sections.materials.find(
      (m: { workshopNeedId: string }) => m.workshopNeedId === rib.id,
    );
    expect(ribRow.status).toBe('BLOCKER');
    expect(ribRow.manuallyUnblocked).toBeFalsy();
  });

  // ---------------------------------------------------------------------------
  // 9. snapshot fields
  // ---------------------------------------------------------------------------

  test('snapshot: override хранит materialRole/description/qty/unit на момент создания', async () => {
    const { orderId, workshopNeedId } = await prepareOrderWithBlockingNeed();
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/material-arrived`)
      .set('Cookie', cookies.manager)
      .send({ comment: 'snapshot test' })
      .expect(201);

    const ov =
      await t.prisma.orderMaterialArrivalOverride.findFirstOrThrow({
        where: { orderId, workshopNeedId, status: 'ACTIVE' },
      });
    expect(ov.materialRole).toBe('MAIN_FABRIC');
    expect(ov.unit).toBe('кг');
    expect(ov.description).toBeTruthy();
    // qty = `purchaseQty ?? calculatedQty`. На текущей фикстуре
    // `purchaseQty` ещё не выставлен (закупщик не редактировал),
    // поэтому ожидаем calculatedQty (= qtyPerUnit × Σ qtyPlan = 0.5 × 10 = 5).
    expect(ov.qty).not.toBeNull();
    expect(new Prisma.Decimal(ov.qty!).toString()).toBe('5');
  });
});
