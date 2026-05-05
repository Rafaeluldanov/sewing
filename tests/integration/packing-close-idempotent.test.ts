/**
 * Integration-тест идемпотентности `PackingService.close` через
 * `POST /api/packing/boxes/:id/close` — targeted coverage по плану
 * `docs/test-gap-plan.md §P0-2`.
 *
 * **RECON-decision (см. gap-plan §P0-2):** основная часть закрытия
 * коробки уже покрыта другими тестами:
 *   - `production-flow.test.ts §F` (line 1107-1180): close happy path,
 *     `Box.status='CLOSED'`, PENDING_RELEASE → APPROVED через endpoint,
 *     `approvedAt !== null`, close × 2 → 409 `BOX_CLOSED`, count
 *     `OperationEntry` стабилен.
 *   - `e2e-production-flow.test.ts` (line 496): `BOX_CLOSED` audit
 *     присутствует (≥ 1, не строго 1).
 *   - `earnings-service.test.ts §5..§7`: service-level
 *     `approvePendingForPassport` — count, idempotency (`approvedAt`
 *     не сдвигается), терминальные `CANCELLED`/`REVERSED`/`APPROVED`
 *     не затрагиваются.
 *
 * Этот файл закрывает **четыре оставшихся «дырки» через endpoint**,
 * которые не зафиксированы выше:
 *   1. `BOX_CLOSED` AuditLog count = **ровно 1** после close × 2 (а не
 *      ≥ 1, как в e2e-production-flow);
 *   2. **значение** `approvedAt` (timestamp) сохраняется между close 1
 *      и close 2 — production-flow проверяет только `!== null`;
 *   3. close box с MIXED entries (`PENDING_RELEASE` + `CANCELLED` +
 *      `REVERSED` + уже `APPROVED`) через endpoint — service-level
 *      это закрыто в `earnings-service.test.ts §7`, через endpoint
 *      ещё нет;
 *   4. `BOX_EMPTY`-ветка (закрытие пустой коробки → 409, никаких
 *      сайд-эффектов) — нигде не покрыта.
 *
 * Чего сознательно НЕ делаем:
 *   - не дублируем golden-path и не пересоздаём CUT→SEWING→…→close;
 *   - не пересчитываем суммы amount/ratePerUnit (формула — в
 *     `cutter-compensation.test.ts`);
 *   - не повторяем addPassport-валидацию (это P0-1).
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

describeWithDb('integration — PackingService.close idempotency (P0-2 missing assertions)', () => {
  let t: TestApp;
  let seed: SeedResult;
  let cookies: Record<string, string>;
  let orderId: string;

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
      packer: loginAs(t, seed.employees['packer']),
    };

    // PACKING-смена (assertPackingActor → PACKING_SHIFT_REQUIRED).
    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.packer)
      .send({
        equipmentId: seed.equipment['packing-station-01'].id,
        operationId: seed.operations.PACKING.id,
      })
      .expect(201);

    const order = await t.prisma.order.create({
      data: {
        number: `O-PKC-${Math.random().toString(36).slice(2, 8)}`,
        orderDate: new Date(),
        color: seed.product.color,
        status: 'IN_PRODUCTION',
        companyDivisionId: seed.companyDivisions.MARKETPLACE.id,
        items: {
          create: {
            productId: seed.product.id,
            sizeId: seed.sizes.M,
            qtyPlan: 100,
          },
        },
      },
    });
    orderId = order.id;
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  async function makePassport(qty = 2): Promise<string> {
    const random = Math.random().toString(36).slice(2, 8);
    const passport = await t.prisma.passport.create({
      data: {
        number: `P-PKC-${random}`,
        qrCode: `passport:pkc-${random}`,
        orderId,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: seed.product.color,
        rollNumber: `R-${random}`,
        cutDate: new Date(),
        qtyPlan: qty,
        qtyCut: qty,
        qtyGood: qty,
        status: 'IN_PROGRESS',
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
      },
    });
    return passport.id;
  }

  async function createBox(): Promise<string> {
    const res = await request(t.app.getHttpServer())
      .post('/api/packing/boxes')
      .set('Cookie', cookies.packer)
      .send({});
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  async function addToBox(boxId: string, passportId: string): Promise<void> {
    await request(t.app.getHttpServer())
      .post(`/api/packing/boxes/${boxId}/add-passport`)
      .set('Cookie', cookies.packer)
      .send({ passportId })
      .expect(201);
  }

  async function postClose(boxId: string) {
    return request(t.app.getHttpServer())
      .post(`/api/packing/boxes/${boxId}/close`)
      .set('Cookie', cookies.packer)
      .send({});
  }

  async function countAudit(boxId: string, event: string): Promise<number> {
    return t.prisma.auditLog.count({
      where: { entityType: 'PACKING', entityId: boxId, event },
    });
  }

  // ---------------------------------------------------------------------------
  // 1. close × 2 → AuditLog BOX_CLOSED count = ровно 1.
  // ---------------------------------------------------------------------------

  test('close × 2: AuditLog BOX_CLOSED count = 1 (не плодит audit на повторе)', async () => {
    const passportId = await makePassport(2);
    const boxId = await createBox();
    await addToBox(boxId, passportId);

    const first = await postClose(boxId);
    expect(first.status).toBe(201);
    expect(await countAudit(boxId, 'BOX_CLOSED')).toBe(1);

    const second = await postClose(boxId);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('BOX_CLOSED');
    expect(await countAudit(boxId, 'BOX_CLOSED')).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 2. close × 2: значение approvedAt сохраняется между двумя вызовами
  //    (production-flow проверяет только `!== null`).
  // ---------------------------------------------------------------------------

  test('close × 2: approvedAt у уже APPROVED не перезаписывается', async () => {
    const passportId = await makePassport(2);
    const boxId = await createBox();
    await addToBox(boxId, passportId);

    // Создаём вручную PENDING_RELEASE, чтобы первый close его промотировал
    // и зафиксировал approvedAt. Используем оверлок — для совместимости с
    // composite-key (passport, op, emp, source).
    await t.prisma.operationEntry.create({
      data: {
        passportId,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
        employeeId: seed.employees.seamstress.id,
        qty: 2,
        ratePerUnit: new Prisma.Decimal(10),
        amount: new Prisma.Decimal(20),
        status: 'PENDING_RELEASE',
        approvalMode: 'AFTER_RELEASE',
        sourceEventType: 'OPERATION_TRANSITION',
      },
    });

    await postClose(boxId).then((r) => expect(r.status).toBe(201));

    const afterFirst = await t.prisma.operationEntry.findFirstOrThrow({
      where: { passportId, operationId: seed.operations.SEW_OVERLOCK_1.id },
    });
    expect(afterFirst.status).toBe('APPROVED');
    const approvedAt1 = afterFirst.approvedAt;
    expect(approvedAt1).not.toBeNull();

    // Технически второй close стопится `BoxClosedException` ещё до
    // апрува — но именно через endpoint этот контракт тут и пиним.
    await new Promise((r) => setTimeout(r, 5));
    const second = await postClose(boxId);
    expect(second.status).toBe(409);

    const afterSecond = await t.prisma.operationEntry.findFirstOrThrow({
      where: { passportId, operationId: seed.operations.SEW_OVERLOCK_1.id },
    });
    expect(afterSecond.status).toBe('APPROVED');
    expect(afterSecond.approvedAt?.toISOString()).toBe(
      approvedAt1!.toISOString(),
    );
  });

  // ---------------------------------------------------------------------------
  // 3. close с MIXED entries: PENDING_RELEASE → APPROVED, остальные не тронуты.
  //    Service-level это уже в earnings-service.test.ts §7; здесь
  //    закрепляем тот же контракт через `POST /close`-маршрут.
  // ---------------------------------------------------------------------------

  test('close: PENDING_RELEASE → APPROVED, CANCELLED / REVERSED / уже APPROVED не меняются', async () => {
    const passportId = await makePassport(3);
    const boxId = await createBox();
    await addToBox(boxId, passportId);

    const fixedApprovedAt = new Date('2026-01-15T12:00:00Z');
    await t.prisma.operationEntry.createMany({
      data: [
        {
          passportId,
          operationId: seed.operations.SEW_OVERLOCK_1.id,
          employeeId: seed.employees.seamstress.id,
          qty: 3,
          ratePerUnit: new Prisma.Decimal(10),
          amount: new Prisma.Decimal(30),
          status: 'PENDING_RELEASE',
          approvalMode: 'AFTER_RELEASE',
          sourceEventType: 'OPERATION_TRANSITION',
        },
        {
          passportId,
          operationId: seed.operations.SEW_OVERLOCK_2.id,
          employeeId: seed.employees.seamstress.id,
          qty: 3,
          ratePerUnit: new Prisma.Decimal(10),
          amount: new Prisma.Decimal(30),
          status: 'CANCELLED',
          approvalMode: 'AFTER_RELEASE',
          sourceEventType: 'OPERATION_TRANSITION',
        },
        {
          passportId,
          operationId: seed.operations.QC.id,
          employeeId: seed.employees.qc.id,
          qty: 3,
          ratePerUnit: new Prisma.Decimal(0),
          amount: new Prisma.Decimal(0),
          status: 'REVERSED',
          approvalMode: 'AFTER_RELEASE',
          sourceEventType: 'OPERATION_TRANSITION',
        },
        {
          passportId,
          operationId: seed.operations.CUT_CUT.id,
          employeeId: seed.employees.cutter.id,
          qty: 3,
          ratePerUnit: new Prisma.Decimal(10),
          amount: new Prisma.Decimal(30),
          status: 'APPROVED',
          approvalMode: 'IMMEDIATE',
          sourceEventType: 'PASSPORT_CREATED',
          approvedAt: fixedApprovedAt,
        },
      ],
    });

    const close = await postClose(boxId);
    expect(close.status).toBe(201);

    const rows = await t.prisma.operationEntry.findMany({
      where: { passportId },
    });
    const byOp = new Map(rows.map((r) => [r.operationId, r]));

    // PENDING_RELEASE → APPROVED.
    const overlock1 = byOp.get(seed.operations.SEW_OVERLOCK_1.id)!;
    expect(overlock1.status).toBe('APPROVED');
    expect(overlock1.approvedAt).not.toBeNull();

    // CANCELLED не тронут.
    expect(byOp.get(seed.operations.SEW_OVERLOCK_2.id)!.status).toBe(
      'CANCELLED',
    );
    // REVERSED не тронут.
    expect(byOp.get(seed.operations.QC.id)!.status).toBe('REVERSED');
    // Уже APPROVED не пересчитан.
    const cutCut = byOp.get(seed.operations.CUT_CUT.id)!;
    expect(cutCut.status).toBe('APPROVED');
    expect(cutCut.approvedAt?.toISOString()).toBe(fixedApprovedAt.toISOString());

    // Никаких новых OperationEntry не появилось.
    expect(rows).toHaveLength(4);
  });

  // ---------------------------------------------------------------------------
  // 4. close пустой коробки → 409 BOX_EMPTY, никаких сайд-эффектов.
  // ---------------------------------------------------------------------------

  test('пустая коробка → 409 BOX_EMPTY, closedAt=null, audit BOX_CLOSED не пишется', async () => {
    const boxId = await createBox();
    const before = await t.prisma.box.findUniqueOrThrow({
      where: { id: boxId },
      select: { totalQty: true, closedAt: true },
    });
    expect(before.totalQty).toBe(0);
    expect(before.closedAt).toBeNull();

    const res = await postClose(boxId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('BOX_EMPTY');

    const after = await t.prisma.box.findUniqueOrThrow({
      where: { id: boxId },
      select: { totalQty: true, closedAt: true },
    });
    expect(after.totalQty).toBe(0);
    expect(after.closedAt).toBeNull();
    expect(await countAudit(boxId, 'BOX_CLOSED')).toBe(0);
  });
});
