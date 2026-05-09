/**
 * Integration-тесты для управленческого удаления паспорта (см.
 * `PassportsService.delete`,
 * `apps/api/src/modules/passports/passports.controller.ts::delete`,
 * `docs/domain.md §7.8 «Удаление паспорта»`).
 *
 * Покрываем:
 *   1. Happy-path: SHOP_MANAGER удаляет «чистый» паспорт (только что
 *      выпущен), backend отдаёт 204 и зачищает PassportEvent /
 *      OperationEntry (PENDING_RELEASE) / PassportDefect одной
 *      транзакцией. AuditLog `PASSPORT_DELETED` записан с актором.
 *   2. RBAC: CUTTER, SEAMSTRESS, QC, ADMIN. Менеджерская операция,
 *      раскройщик/швея в управленческое удаление не лезут.
 *   3. Блокеры:
 *        - `BoxItem` существует → 409 `PASSPORT_HAS_BOX` (паспорт
 *          уже физически в коробке);
 *        - `OperationEntry { status: APPROVED }` существует → 409
 *          `PASSPORT_HAS_APPROVED_EARNINGS` (стирать выплаченную
 *          зарплату нельзя);
 *        - `MaterialIssue { status: POSTED }` ссылается на паспорт →
 *          409 `PASSPORT_HAS_POSTED_MATERIAL_ISSUE`.
 *   4. После успеха `Order.summary.qtyCutFact` пересчитывается на
 *      лету (см. `order-aggregator.ts`) — отдельная регрессия,
 *      чтобы UI не показывал сломанную цифру.
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

describeWithDb('integration — passports.delete (управленческое удаление)', () => {
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
    await refreshAdminCookie(t);
    cookies = {
      manager: loginAs(t, seed.employees['shop-chief']),
      cutter: loginAs(t, seed.employees.cutter),
      seamstress: loginAs(t, seed.employees.seamstress),
      qc: loginAs(t, seed.employees.qc),
      admin: t.adminCookie,
    };
  });

  /**
   * Создаёт заказ IN_PRODUCTION и выпускает «чистый» паспорт через
   * `PassportsService.create` (POST /api/passports). Это даёт нам
   * realistic стартовое состояние с записью PassportEvent
   * `PASSPORT_CREATED` и сдельным начислением раскройщику в
   * `PENDING_RELEASE` (`OperationEntry`). Возвращает {orderId,
   * passportId, passportNumber}.
   */
  async function setupOrderWithPassport(): Promise<{
    orderId: string;
    passportId: string;
    passportNumber: string;
  }> {
    const order = await t.prisma.order.create({
      data: {
        number: `O-DEL-${Math.random().toString(36).slice(2, 8)}`,
        orderDate: new Date(),
        color: 'Чёрный',
        status: 'IN_PRODUCTION',
        items: {
          create: [
            { productId: seed.product.id, sizeId: seed.sizes.M, qtyPlan: 8 },
          ],
        },
      },
    });
    const created = await request(t.app.getHttpServer())
      .post('/api/passports')
      .set('Cookie', cookies.manager)
      .send({
        orderId: order.id,
        sizeId: seed.sizes.M,
        rollNumber: 'R-DEL',
        cutDate: new Date().toISOString(),
        qtyCut: 4,
        cutterId: seed.employees.cutter.id,
      })
      .expect(201);
    return {
      orderId: order.id,
      passportId: created.body.id,
      passportNumber: created.body.number,
    };
  }

  // -------------------------------------------------------------------------
  // 1. Happy path
  // -------------------------------------------------------------------------

  test('SHOP_MANAGER удаляет чистый паспорт → 204, dependent rows вычищены, audit записан', async () => {
    const { passportId, orderId } = await setupOrderWithPassport();

    // У свежего паспорта PassportsService.create пишет хотя бы одно
    // событие `PASSPORT_CREATED` (это инвариант). `OperationEntry`
    // создаётся только для сдельщиков по сдельной операции — на
    // дефолтном seed это может быть 0, поэтому такую запись делаем
    // вручную, чтобы каскад был под покрытием.
    expect(
      await t.prisma.passportEvent.count({ where: { passportId } }),
    ).toBeGreaterThanOrEqual(1);
    await t.prisma.operationEntry.create({
      data: {
        passportId,
        operationId: seed.operations.CUT_DIVISION.id,
        employeeId: seed.employees.cutter.id,
        qty: 4,
        ratePerUnit: '1.00',
        amount: '4.00',
        status: 'PENDING_RELEASE',
      },
    });
    await t.prisma.passportDefect.create({
      data: {
        passportId,
        defectTypeId: seed.defectType.id,
        qty: 1,
        comment: 'дефект — будет снесён удалением',
      },
    });

    await request(t.app.getHttpServer())
      .delete(`/api/passports/${passportId}`)
      .set('Cookie', cookies.manager)
      .expect(204);

    expect(
      await t.prisma.passport.findUnique({ where: { id: passportId } }),
    ).toBeNull();
    expect(
      await t.prisma.passportEvent.count({ where: { passportId } }),
    ).toBe(0);
    expect(
      await t.prisma.operationEntry.count({ where: { passportId } }),
    ).toBe(0);
    expect(
      await t.prisma.passportDefect.count({ where: { passportId } }),
    ).toBe(0);

    const audits = await t.prisma.auditLog.findMany({
      where: { entityType: 'PASSPORT', entityId: passportId, event: 'PASSPORT_DELETED' },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.employeeId).toBe(seed.employees['shop-chief'].id);
    const payload = audits[0]!.payload as {
      number: string;
      orderId: string;
      sizeId: string;
      qtyCut: number;
    };
    expect(payload.orderId).toBe(orderId);
    expect(payload.qtyCut).toBe(4);
    expect(payload.number).toMatch(/^P-/);
  });

  test('Удаление паспорта в ячейке декрементит WorkInProgressBalance до 0', async () => {
    const { passportId } = await setupOrderWithPassport();
    const cell = seed.cells['A1'];
    expect(cell).toBeDefined();

    // Размещаем паспорт в ячейку — `place` создаёт WIP balance + PLACE.
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/place`)
      .set('Cookie', cookies.manager)
      .send({ cellCode: cell!.code })
      .expect(201);

    const before = await t.prisma.workInProgressBalance.findFirst({
      where: { cellId: cell!.id, sizeId: seed.sizes.M },
    });
    expect(before?.qty).toBe(4);

    await request(t.app.getHttpServer())
      .delete(`/api/passports/${passportId}`)
      .set('Cookie', cookies.manager)
      .expect(204);

    const after = await t.prisma.workInProgressBalance.findFirst({
      where: { cellId: cell!.id, sizeId: seed.sizes.M },
    });
    // Баланс остаётся (строка хранится для истории), но qty = 0.
    expect(after?.qty ?? 0).toBe(0);

    // Audit-payload содержит cellId — полезный след для разбора.
    const audit = await t.prisma.auditLog.findFirst({
      where: { entityType: 'PASSPORT', entityId: passportId, event: 'PASSPORT_DELETED' },
    });
    expect((audit!.payload as { cellId: string | null }).cellId).toBe(cell!.id);

    // DELETE-движение по стабильному sourceKey (passportId уходит в
    // null после delete через `onDelete: SetNull`).
    const deleteMovement = await t.prisma.workInProgressMovement.findUnique({
      where: { sourceKey: `WIP_DELETE:${passportId}` },
    });
    expect(deleteMovement).not.toBeNull();
    expect(deleteMovement!.direction).toBe('OUT');
    expect(deleteMovement!.balanceAfterQty).toBe(0);
  });

  test('Полный жизненный цикл паспорта в ячейке отражается в WorkInProgressBalance', async () => {
    const { passportId, orderId } = await setupOrderWithPassport();
    const cell = seed.cells['A1'];
    expect(cell).toBeDefined();

    // 1. PLACE — крой попадает в ячейку.
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/place`)
      .set('Cookie', cookies.manager)
      .send({ cellCode: cell!.code })
      .expect(201);

    let wipBalance = await t.prisma.workInProgressBalance.findFirst({
      where: { orderId, sizeId: seed.sizes.M, cellId: cell!.id },
    });
    expect(wipBalance?.qty).toBe(4);
    expect(wipBalance?.warehouseId).toBeDefined();

    // 2. DELETE — крой списывается. Баланс ушёл в 0, движений 2
    // (PLACE IN + DELETE OUT), в журнале есть оба.
    await request(t.app.getHttpServer())
      .delete(`/api/passports/${passportId}`)
      .set('Cookie', cookies.manager)
      .expect(204);

    wipBalance = await t.prisma.workInProgressBalance.findFirst({
      where: { orderId, sizeId: seed.sizes.M, cellId: cell!.id },
    });
    expect(wipBalance?.qty).toBe(0);

    // FK passportId уходит в null после delete (`onDelete: SetNull`),
    // но движения остаются — историческая лента.
    const movements = await t.prisma.workInProgressMovement.findMany({
      where: { orderId, sizeId: seed.sizes.M, cellId: cell!.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(movements.map((m) => m.type)).toEqual(['PLACE', 'DELETE']);
    expect(movements[0]!.balanceBeforeQty).toBe(0);
    expect(movements[0]!.balanceAfterQty).toBe(4);
    expect(movements[1]!.balanceBeforeQty).toBe(4);
    expect(movements[1]!.balanceAfterQty).toBe(0);
    // SetNull сработал на passportId, sourceKey остался уникальным.
    expect(movements[1]!.passportId).toBeNull();
    expect(movements[1]!.sourceKey).toBe(`WIP_DELETE:${passportId}`);
  });

  test('ADMIN тоже может удалять (админ — суперюзер)', async () => {
    const { passportId } = await setupOrderWithPassport();
    await request(t.app.getHttpServer())
      .delete(`/api/passports/${passportId}`)
      .set('Cookie', cookies.admin)
      .expect(204);
    expect(
      await t.prisma.passport.findUnique({ where: { id: passportId } }),
    ).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 2. RBAC
  // -------------------------------------------------------------------------

  test('CUTTER не может удалять (403)', async () => {
    const { passportId } = await setupOrderWithPassport();
    await request(t.app.getHttpServer())
      .delete(`/api/passports/${passportId}`)
      .set('Cookie', cookies.cutter)
      .expect(403);
    // Паспорт остался на месте.
    expect(
      await t.prisma.passport.findUnique({ where: { id: passportId } }),
    ).not.toBeNull();
  });

  test('SEAMSTRESS не может удалять (403)', async () => {
    const { passportId } = await setupOrderWithPassport();
    await request(t.app.getHttpServer())
      .delete(`/api/passports/${passportId}`)
      .set('Cookie', cookies.seamstress)
      .expect(403);
  });

  test('QC не может удалять (403)', async () => {
    const { passportId } = await setupOrderWithPassport();
    await request(t.app.getHttpServer())
      .delete(`/api/passports/${passportId}`)
      .set('Cookie', cookies.qc)
      .expect(403);
  });

  test('Без сессии — 401', async () => {
    const { passportId } = await setupOrderWithPassport();
    await request(t.app.getHttpServer())
      .delete(`/api/passports/${passportId}`)
      .expect(401);
  });

  // -------------------------------------------------------------------------
  // 3. Блокеры
  // -------------------------------------------------------------------------

  test('Несуществующий паспорт → 404 PASSPORT_NOT_FOUND', async () => {
    const res = await request(t.app.getHttpServer())
      .delete('/api/passports/cm-nonexistent-passport-id')
      .set('Cookie', cookies.manager)
      .expect(404);
    expect(res.body?.code).toBe('PASSPORT_NOT_FOUND');
  });

  test('Блокер: паспорт упакован в коробку → 409 PASSPORT_HAS_BOX', async () => {
    const { passportId } = await setupOrderWithPassport();

    // Создаём «фиктивную» коробку и BoxItem напрямую (через packing-
    // flow ушли бы в PackingService с предусловиями qtyGood/QC).
    // Контракт удаления нам важен, не реальный путь упаковки.
    const suffix = Math.random().toString(36).slice(2, 8);
    const box = await t.prisma.box.create({
      data: {
        number: `BOX-DEL-${suffix}`,
        qrCode: `box:DEL-${suffix}`,
        createdById: seed.employees['shop-chief'].id,
      },
    });
    await t.prisma.boxItem.create({
      data: { boxId: box.id, passportId, qty: 4 },
    });

    const res = await request(t.app.getHttpServer())
      .delete(`/api/passports/${passportId}`)
      .set('Cookie', cookies.manager)
      .expect(409);
    expect(res.body?.code).toBe('PASSPORT_HAS_BOX');
    // Паспорт не тронут.
    expect(
      await t.prisma.passport.findUnique({ where: { id: passportId } }),
    ).not.toBeNull();
  });

  test('Блокер: APPROVED-начисление → 409 PASSPORT_HAS_APPROVED_EARNINGS', async () => {
    const { passportId } = await setupOrderWithPassport();

    // Имитируем «выплачено в зарплату» вручную — без зависимости от
    // того, нагенерил ли PassportsService.create сдельную запись по
    // дефолтному seed (зависит от сдельных правил и компенсационной
    // модели сотрудника).
    await t.prisma.operationEntry.create({
      data: {
        passportId,
        operationId: seed.operations.CUT_DIVISION.id,
        employeeId: seed.employees.cutter.id,
        qty: 4,
        ratePerUnit: '1.00',
        amount: '4.00',
        status: 'APPROVED',
        approvedAt: new Date(),
      },
    });

    const res = await request(t.app.getHttpServer())
      .delete(`/api/passports/${passportId}`)
      .set('Cookie', cookies.manager)
      .expect(409);
    expect(res.body?.code).toBe('PASSPORT_HAS_APPROVED_EARNINGS');
    expect(
      await t.prisma.passport.findUnique({ where: { id: passportId } }),
    ).not.toBeNull();
  });

  test('Блокер: проведённый MaterialIssue → 409 PASSPORT_HAS_POSTED_MATERIAL_ISSUE', async () => {
    const { passportId, orderId } = await setupOrderWithPassport();

    // Создаём документ расхода материалов «сверху»: на MVP запись
    // нужна только чтобы проверить блокер. Минимальный rolling
    // contract — orderId + passportId + status.
    await t.prisma.materialIssue.create({
      data: {
        orderId,
        passportId,
        status: 'POSTED',
      },
    });

    const res = await request(t.app.getHttpServer())
      .delete(`/api/passports/${passportId}`)
      .set('Cookie', cookies.manager)
      .expect(409);
    expect(res.body?.code).toBe('PASSPORT_HAS_POSTED_MATERIAL_ISSUE');
    expect(
      await t.prisma.passport.findUnique({ where: { id: passportId } }),
    ).not.toBeNull();
  });

  test('DRAFT MaterialIssue (не POSTED) удалению не мешает — passportId уйдёт в null после delete', async () => {
    const { passportId, orderId } = await setupOrderWithPassport();
    const issue = await t.prisma.materialIssue.create({
      data: { orderId, passportId, status: 'DRAFT' },
    });

    await request(t.app.getHttpServer())
      .delete(`/api/passports/${passportId}`)
      .set('Cookie', cookies.manager)
      .expect(204);

    // Prisma-схема: MaterialIssue.passportId — onDelete: SetNull.
    // Документ остался, ссылка обнулилась — это и есть нужное
    // поведение «не сломать историю расхода».
    const after = await t.prisma.materialIssue.findUnique({
      where: { id: issue.id },
    });
    expect(after).not.toBeNull();
    expect(after!.passportId).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 4. Эффект на сводку заказа
  // -------------------------------------------------------------------------

  test('После удаления паспорта Order.summary.qtyCutFact пересчитывается (агрегатор on-the-fly)', async () => {
    const { passportId, orderId } = await setupOrderWithPassport();

    const before = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(before.body.summary.qtyCutFactTotal).toBe(4);

    await request(t.app.getHttpServer())
      .delete(`/api/passports/${passportId}`)
      .set('Cookie', cookies.manager)
      .expect(204);

    const after = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(after.body.summary.qtyCutFactTotal).toBe(0);
  });
});
