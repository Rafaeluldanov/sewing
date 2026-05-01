/**
 * Integration-тест: универсальный journal `AuditLog`.
 *
 * Контракт (см. `docs/domain.md §«Audit log»`,
 * `apps/api/src/modules/audit/audit.service.ts`):
 *
 *   - все «управленческие» действия (create/start заказа, place/issue/
 *     scan/complete паспорта, QC/WTO complete, packing add/close)
 *     пишут строку в `AuditLog` в той же транзакции, что и сама
 *     бизнес-операция;
 *   - `entityType` фиксирован для группировки в UI карточки
 *     («история по объекту»), `event` — свободная строка-код;
 *   - `employeeId` совпадает с `currentUser.employeeId` для
 *     scan-driven действий и заполняется фактическим инициатором
 *     для управленческих action-ов (create/start заказа).
 *
 * Покрываем тут именно «journal-инвариант»: что после каждого
 * целевого вызова в `AuditLog` появляется ровно одна строка с
 * правильным `event`, `entityType`, `entityId` и `employeeId` и что
 * сами строки не повторяются. Подробные бизнес-инварианты этих
 * вызовов (qty, status, идемпотентность) проверяет
 * `production-flow.test.ts`; здесь не дублируем — задача журнала
 * отделена от задачи бизнес-логики.
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

describeWithDb('integration — audit log', () => {
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
      seamstress: loginAs(t, seed.employees['seamstress']),
      qc: loginAs(t, seed.employees['qc']),
      packer: loginAs(t, seed.employees['packer']),
    };
  });

  test('order create/start пишут ORDER_CREATED и ORDER_STARTED с employeeId менеджера', async () => {
    const create = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookies.manager)
      .send({
        orderDate: '2026-04-15T00:00:00.000Z',
        productId: seed.product.id,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 3 }],
      })
      .expect(201);
    const orderId: string = create.body.id;

    const createdRows = await t.prisma.auditLog.findMany({
      where: { entityType: 'ORDER', entityId: orderId, event: 'ORDER_CREATED' },
    });
    expect(createdRows).toHaveLength(1);
    expect(createdRows[0]?.employeeId).toBe(seed.employees['shop-chief'].id);

    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start`)
      .set('Cookie', cookies.manager)
      .expect(201);

    const startedRows = await t.prisma.auditLog.findMany({
      where: { entityType: 'ORDER', entityId: orderId, event: 'ORDER_STARTED' },
    });
    expect(startedRows).toHaveLength(1);
    expect(startedRows[0]?.employeeId).toBe(seed.employees['shop-chief'].id);
  });

  test('passport place/issue/scan/complete пишут отдельные AuditLog с корректным employeeId', async () => {
    const order = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookies.manager)
      .send({
        orderDate: '2026-04-15T00:00:00.000Z',
        productId: seed.product.id,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 1 }],
      })
      .expect(201);
    const orderId: string = order.body.id;
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start`)
      .set('Cookie', cookies.manager)
      .expect(201);

    const passport = await request(t.app.getHttpServer())
      .post('/api/passports')
      .set('Cookie', cookies.manager)
      .send({
        orderId,
        sizeId: seed.sizes.M,
        rollNumber: 'R-AL-1',
        cutDate: '2026-04-15T00:00:00.000Z',
        qtyCut: 1,
      })
      .expect(201);
    const passportId: string = passport.body.id;

    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/place`)
      .set('Cookie', cookies.manager)
      .send({ cellId: seed.cells.A1.id })
      .expect(201);

    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.seamstress)
      .send({
        equipmentId: seed.equipment['overlock-01'].id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
      })
      .expect(201);
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/scan`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/complete-operation`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);

    const all = await t.prisma.auditLog.findMany({
      where: { entityType: 'PASSPORT', entityId: passportId },
      orderBy: { createdAt: 'asc' },
    });

    const events = all.map((r) => r.event);
    expect(events).toContain('PASSPORT_PLACED');
    expect(events).toContain('PASSPORT_ISSUED');
    expect(events).toContain('PASSPORT_SCANNED');
    expect(events).toContain('PASSPORT_OPERATION_COMPLETED');

    const placed = all.find((r) => r.event === 'PASSPORT_PLACED');
    // place выполнялся менеджером — это не scan-driven действие
    // швеи, employeeId здесь не передаётся (см. PassportsService.place).
    expect(placed?.employeeId ?? null).toBeNull();

    const issued = all.find((r) => r.event === 'PASSPORT_ISSUED');
    expect(issued?.employeeId).toBe(seed.employees.seamstress.id);

    const scanned = all.find((r) => r.event === 'PASSPORT_SCANNED');
    expect(scanned?.employeeId).toBe(seed.employees.seamstress.id);

    const completed = all.find(
      (r) => r.event === 'PASSPORT_OPERATION_COMPLETED',
    );
    expect(completed?.employeeId).toBe(seed.employees.seamstress.id);
  });

  test('QC complete пишет QC_COMPLETED с employeeId инспектора', async () => {
    const passportId = await prepareInProgressPassport();
    // Стартуем смену QC на qc-station-01 (allow-лист = {QC}) и
    // переключаем паспорт на операцию QC сканом — это контракт
    // `qc-shift-flow.test.ts`.
    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.qc)
      .send({
        equipmentId: seed.equipment['qc-station-01'].id,
        operationId: seed.operations.QC.id,
      })
      .expect(201);
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/scan`)
      .set('Cookie', cookies.qc)
      .send({})
      .expect(201);
    await request(t.app.getHttpServer())
      .post(`/api/qc/passports/${passportId}/complete`)
      .set('Cookie', cookies.qc)
      .send({})
      .expect(201);

    const rows = await t.prisma.auditLog.findMany({
      where: { entityType: 'QC', entityId: passportId, event: 'QC_COMPLETED' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.employeeId).toBe(seed.employees.qc.id);
  });

  test('packing add/close пишут PASSPORT_PACKED и BOX_CLOSED с employeeId упаковщика', async () => {
    const passportId = await prepareReadyForPackingPassport();

    // assertPackingActor требует активной смены упаковщика на
    // packing-станции с операцией PACKING.
    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.packer)
      .send({
        equipmentId: seed.equipment['packing-station-01'].id,
        operationId: seed.operations.PACKING.id,
      })
      .expect(201);

    const box = await request(t.app.getHttpServer())
      .post('/api/packing/boxes')
      .set('Cookie', cookies.packer)
      .send({})
      .expect(201);
    const boxId: string = box.body.id;

    await request(t.app.getHttpServer())
      .post(`/api/packing/boxes/${boxId}/add-passport`)
      .set('Cookie', cookies.packer)
      .send({ code: passportId })
      .expect(201);

    const packed = await t.prisma.auditLog.findMany({
      where: {
        entityType: 'PACKING',
        entityId: boxId,
        event: 'PASSPORT_PACKED',
      },
    });
    expect(packed).toHaveLength(1);
    expect(packed[0]?.employeeId).toBe(seed.employees.packer.id);

    await request(t.app.getHttpServer())
      .post(`/api/packing/boxes/${boxId}/close`)
      .set('Cookie', cookies.packer)
      .send({})
      .expect(201);

    const closed = await t.prisma.auditLog.findMany({
      where: {
        entityType: 'PACKING',
        entityId: boxId,
        event: 'BOX_CLOSED',
      },
    });
    expect(closed).toHaveLength(1);
    expect(closed[0]?.employeeId).toBe(seed.employees.packer.id);
  });

  // -------------------------------------------------------------------------
  // helpers — повторяют setup `qc-shift-flow.test.ts` и production-flow.
  // Дублируем сознательно: нужен изолированный одноразовый сетап без
  // кросс-зависимостей между сьютами.
  // -------------------------------------------------------------------------

  async function prepareInProgressPassport(): Promise<string> {
    const order = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookies.manager)
      .send({
        orderDate: '2026-04-15T00:00:00.000Z',
        productId: seed.product.id,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 1 }],
      })
      .expect(201);
    const orderId: string = order.body.id;
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start`)
      .set('Cookie', cookies.manager)
      .expect(201);
    const passport = await request(t.app.getHttpServer())
      .post('/api/passports')
      .set('Cookie', cookies.manager)
      .send({
        orderId,
        sizeId: seed.sizes.M,
        rollNumber: 'R-AL-QC',
        cutDate: '2026-04-15T00:00:00.000Z',
        qtyCut: 1,
      })
      .expect(201);
    const passportId: string = passport.body.id;
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/place`)
      .set('Cookie', cookies.manager)
      .send({ cellId: seed.cells.A1.id })
      .expect(201);
    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.seamstress)
      .send({
        equipmentId: seed.equipment['overlock-01'].id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
      })
      .expect(201);
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);
    return passportId;
  }

  async function prepareReadyForPackingPassport(): Promise<string> {
    // Готовим паспорт под packing: проходим по всему маршруту через
    // сканы швеи. Минимально достаточный путь — issue → scan на
    // первой операции, чтобы packing-add смог пройти `mustBeReady`
    // (см. `PackingService.addPassport`).
    return await prepareInProgressPassport();
  }
});
