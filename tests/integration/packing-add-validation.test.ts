/**
 * Integration-тест валидационных веток `PackingService.addPassport` —
 * dedicated coverage по плану `docs/test-gap-plan.md §P0-1`.
 *
 * Что покрываем здесь и больше нигде:
 *   - happy-path **с проверкой счётчиков `PassportEvent(PACKED)` и
 *     `AuditLog(event=PASSPORT_PACKED)`** (production-flow.test.ts
 *     этого не делает, у него только `Box.totalQty` и `Passport.status`);
 *   - все негативные ветки `addPassport` через `POST /api/packing/
 *     boxes/:id/add-passport`:
 *       1. `PASSPORT_NOT_PACKABLE` для `status != IN_PROGRESS` (CREATED);
 *       2. `PASSPORT_ALREADY_PACKED` для `PACKED`;
 *       3. `PASSPORT_CANCELLED` для `CANCELLED`;
 *       4. `PASSPORT_NOT_PACKABLE` для `qtyGood = 0`;
 *       5. `BOX_CLOSED` для закрытой коробки;
 *       6. `BOX_HOMOGENEITY_VIOLATED` для product/size/color
 *          mismatch — отдельные тесты по каждому из трёх измерений;
 *       7. `BOX_CAPACITY_EXCEEDED` (422) при `qtyGood > maxQty - totalQty`;
 *       8. дубль add — повторный POST для уже упакованного паспорта
 *          ловит `PASSPORT_ALREADY_PACKED` без второго `BoxItem`,
 *          без второго `PASSPORT_PACKED` события и без второй записи
 *          в AuditLog.
 *   - на каждом негативном кейсе сравниваем before/after-снимок:
 *     `BoxItem` count, `Box.totalQty`, `Passport.status`,
 *     `PassportEvent(PACKED)` count, `AuditLog(PASSPORT_PACKED)` count.
 *
 * Чего сознательно НЕ покрываем — у соседей уже есть, не дублируем:
 *   - полный happy-path CUT→SEWING→QC→WTO→PACKING — есть в
 *     `production-flow.test.ts` и `e2e-production-flow.test.ts`;
 *   - `closeBox` идемпотентность и переход PENDING_RELEASE → APPROVED —
 *     есть в `production-flow.test.ts §F` (line 1137-1180); P0-2 в
 *     gap-plan ещё открыт и будет отдельным решением;
 *   - RBAC matrix для `/api/packing/boxes` — есть в
 *     `role-rbac.test.ts §«2. /api/packing/boxes»` (line 242-307);
 *   - `EarningsService.approvePendingForPassport` напрямую — есть в
 *     `earnings-service.test.ts §5..§7`.
 *
 * Стиль: создаём passport-ы напрямую через `t.prisma.passport.create`
 * (тот же приём, что в `cutter-compensation.test.ts`/`earnings-service.
 * test.ts`) — нам не нужен полный cut→issue→scan, только конкретное
 * «состояние входа» в `addPassport`. Через HTTP идём только сам
 * `POST /api/packing/boxes/:id/add-passport` и `POST /api/packing/
 * boxes` (они проходят validation pipe + AuthGuard + сервис actor-чек).
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

describeWithDb('integration — PackingService.addPassport validation (P0-1)', () => {
  let t: TestApp;
  let seed: SeedResult;
  let cookies: Record<string, string>;
  /** Order id, прогретый под тест: один заказ с `MARKETPLACE`-division. */
  let orderId: string;
  /** Дополнительный продукт «Test Hoodie» для homogeneity-проверки product. */
  let altProductId: string;

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
      manager: loginAs(t, seed.employees['shop-chief']),
      seamstress: loginAs(t, seed.employees['seamstress']),
    };

    // У упаковщика должна быть активная PACKING-смена (см.
    // PackingService.assertPackingActor → PACKING_SHIFT_REQUIRED).
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
        number: `O-PK-${Math.random().toString(36).slice(2, 8)}`,
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

    const altProduct = await t.prisma.product.create({
      data: { name: 'Test Hoodie', color: seed.product.color, active: true },
    });
    altProductId = altProduct.id;
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Создаёт passport напрямую через Prisma в нужном «состоянии входа»
   * для `addPassport`. По умолчанию — IN_PROGRESS, qtyCut=qtyGood=2,
   * product/size/color из seed-минимума.
   */
  async function makePassport(args: {
    status?: 'CREATED' | 'IN_PROGRESS' | 'PACKED' | 'CANCELLED';
    qtyCut?: number;
    qtyGood?: number;
    productId?: string;
    sizeId?: string;
    color?: string;
  } = {}): Promise<string> {
    const random = Math.random().toString(36).slice(2, 8);
    const passport = await t.prisma.passport.create({
      data: {
        number: `P-PK-${random}`,
        qrCode: `passport:pk-${random}`,
        orderId,
        productId: args.productId ?? seed.product.id,
        sizeId: args.sizeId ?? seed.sizes.M,
        color: args.color ?? seed.product.color,
        rollNumber: `R-${random}`,
        cutDate: new Date(),
        qtyPlan: args.qtyCut ?? 2,
        qtyCut: args.qtyCut ?? 2,
        qtyGood: args.qtyGood ?? args.qtyCut ?? 2,
        status: args.status ?? 'IN_PROGRESS',
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
      },
    });
    return passport.id;
  }

  /** Создаёт открытую коробку упаковщиком через HTTP. */
  async function createBox(maxQty?: number): Promise<string> {
    const res = await request(t.app.getHttpServer())
      .post('/api/packing/boxes')
      .set('Cookie', cookies.packer)
      .send(maxQty !== undefined ? { maxQty } : {});
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  /** Закрывает коробку упаковщиком через HTTP (для теста BOX_CLOSED). */
  async function closeBox(boxId: string): Promise<void> {
    const res = await request(t.app.getHttpServer())
      .post(`/api/packing/boxes/${boxId}/close`)
      .set('Cookie', cookies.packer)
      .send({});
    expect(res.status).toBe(201);
  }

  /** Снимок состояния, которое должно остаться неизменным при отказе. */
  async function snapshot(boxId: string, passportId: string): Promise<{
    boxItemCount: number;
    boxTotalQty: number;
    passportStatus: string;
    passportCurrentEmployeeId: string | null;
    passportCurrentCellId: string | null;
    packedEventCount: number;
    auditPackedCount: number;
  }> {
    const [box, passport, packedEvents, auditPacked] = await Promise.all([
      t.prisma.box.findUniqueOrThrow({
        where: { id: boxId },
        select: {
          totalQty: true,
          items: { select: { id: true } },
        },
      }),
      t.prisma.passport.findUniqueOrThrow({
        where: { id: passportId },
        select: {
          status: true,
          currentEmployeeId: true,
          currentCellId: true,
        },
      }),
      t.prisma.passportEvent.count({
        where: { passportId, type: 'PACKED' },
      }),
      t.prisma.auditLog.count({
        where: { event: 'PASSPORT_PACKED', entityId: boxId },
      }),
    ]);
    return {
      boxItemCount: box.items.length,
      boxTotalQty: box.totalQty,
      passportStatus: passport.status,
      passportCurrentEmployeeId: passport.currentEmployeeId,
      passportCurrentCellId: passport.currentCellId,
      packedEventCount: packedEvents,
      auditPackedCount: auditPacked,
    };
  }

  /** Утверждение: после неудачного `addPassport` снимок не изменился. */
  function expectNoSideEffects(
    before: Awaited<ReturnType<typeof snapshot>>,
    after: Awaited<ReturnType<typeof snapshot>>,
  ): void {
    expect(after.boxItemCount).toBe(before.boxItemCount);
    expect(after.boxTotalQty).toBe(before.boxTotalQty);
    expect(after.passportStatus).toBe(before.passportStatus);
    expect(after.passportCurrentEmployeeId).toBe(
      before.passportCurrentEmployeeId,
    );
    expect(after.passportCurrentCellId).toBe(before.passportCurrentCellId);
    expect(after.packedEventCount).toBe(before.packedEventCount);
    expect(after.auditPackedCount).toBe(before.auditPackedCount);
  }

  /** Удобный POST add-passport. */
  function postAdd(boxId: string, body: { passportId?: string; code?: string }) {
    return request(t.app.getHttpServer())
      .post(`/api/packing/boxes/${boxId}/add-passport`)
      .set('Cookie', cookies.packer)
      .send(body);
  }

  // ---------------------------------------------------------------------------
  // 1. HAPPY PATH MINIMAL — баланс счётчиков, которые не проверяет
  //    production-flow.test.ts.
  // ---------------------------------------------------------------------------

  test('happy path: BoxItem +1, totalQty += qtyGood, Passport.status=PACKED, ровно один PACKED event и один PASSPORT_PACKED audit', async () => {
    const passportId = await makePassport({
      status: 'IN_PROGRESS',
      qtyCut: 4,
      qtyGood: 4,
    });
    const boxId = await createBox(10);

    const res = await postAdd(boxId, { passportId });
    expect(res.status).toBe(201);
    expect(res.body.totalQty).toBe(4);

    const after = await snapshot(boxId, passportId);
    expect(after.boxItemCount).toBe(1);
    expect(after.boxTotalQty).toBe(4);
    expect(after.passportStatus).toBe('PACKED');
    expect(after.passportCurrentEmployeeId).toBeNull();
    expect(after.passportCurrentCellId).toBeNull();
    expect(after.packedEventCount).toBe(1);
    expect(after.auditPackedCount).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 2. status != IN_PROGRESS — ловится PassportNotPackableException (409),
  //    PACKED ловится PassportAlreadyPackedException, CANCELLED — Passport-
  //    CancelledException. Проверяем все три ветки.
  // ---------------------------------------------------------------------------

  test('CREATED → 409 PASSPORT_NOT_PACKABLE, без сайд-эффектов', async () => {
    const passportId = await makePassport({ status: 'CREATED' });
    const boxId = await createBox();
    const before = await snapshot(boxId, passportId);

    const res = await postAdd(boxId, { passportId });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PASSPORT_NOT_PACKABLE');

    expectNoSideEffects(before, await snapshot(boxId, passportId));
  });

  test('PACKED → 409 PASSPORT_ALREADY_PACKED, без сайд-эффектов', async () => {
    const passportId = await makePassport({ status: 'PACKED' });
    const boxId = await createBox();
    const before = await snapshot(boxId, passportId);

    const res = await postAdd(boxId, { passportId });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PASSPORT_ALREADY_PACKED');

    expectNoSideEffects(before, await snapshot(boxId, passportId));
  });

  test('CANCELLED → 409 PASSPORT_CANCELLED, без сайд-эффектов', async () => {
    const passportId = await makePassport({ status: 'CANCELLED' });
    const boxId = await createBox();
    const before = await snapshot(boxId, passportId);

    const res = await postAdd(boxId, { passportId });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PASSPORT_CANCELLED');

    expectNoSideEffects(before, await snapshot(boxId, passportId));
  });

  // ---------------------------------------------------------------------------
  // 3. qtyGood = 0 — даже при IN_PROGRESS отвергается как
  //    PASSPORT_NOT_PACKABLE.
  // ---------------------------------------------------------------------------

  test('qtyGood=0 → 409 PASSPORT_NOT_PACKABLE, без сайд-эффектов', async () => {
    const passportId = await makePassport({
      status: 'IN_PROGRESS',
      qtyCut: 3,
      qtyGood: 0,
    });
    const boxId = await createBox();
    const before = await snapshot(boxId, passportId);

    const res = await postAdd(boxId, { passportId });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PASSPORT_NOT_PACKABLE');

    expectNoSideEffects(before, await snapshot(boxId, passportId));
  });

  // ---------------------------------------------------------------------------
  // 4. Box закрыт — BOX_CLOSED.
  // ---------------------------------------------------------------------------

  test('закрытая коробка → 409 BOX_CLOSED, без сайд-эффектов на втором паспорте', async () => {
    // Кладём в коробку первый паспорт, чтобы её можно было закрыть
    // (closeBox требует totalQty > 0). Затем пробуем добавить второй.
    const firstPassportId = await makePassport({ qtyCut: 2, qtyGood: 2 });
    const boxId = await createBox();
    await postAdd(boxId, { passportId: firstPassportId }).expect(201);
    await closeBox(boxId);

    const secondPassportId = await makePassport({ qtyCut: 1, qtyGood: 1 });
    const before = await snapshot(boxId, secondPassportId);

    const res = await postAdd(boxId, { passportId: secondPassportId });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('BOX_CLOSED');

    expectNoSideEffects(before, await snapshot(boxId, secondPassportId));
    // Контрольно: первый паспорт по-прежнему PACKED и в коробке.
    const box = await t.prisma.box.findUniqueOrThrow({
      where: { id: boxId },
      select: { totalQty: true, closedAt: true, items: true },
    });
    expect(box.totalQty).toBe(2);
    expect(box.items).toHaveLength(1);
    expect(box.closedAt).not.toBeNull();
  });

  // ---------------------------------------------------------------------------
  // 5. Однородность: product / size / color — три отдельных кейса.
  //    Каждый из трёх должен ловиться BOX_HOMOGENEITY_VIOLATED.
  // ---------------------------------------------------------------------------

  test('homogeneity: разный productId → 409 BOX_HOMOGENEITY_VIOLATED, без сайд-эффектов', async () => {
    const refPassportId = await makePassport({
      productId: seed.product.id,
      sizeId: seed.sizes.M,
      color: seed.product.color,
    });
    const altPassportId = await makePassport({
      productId: altProductId,
      sizeId: seed.sizes.M,
      color: seed.product.color,
    });
    const boxId = await createBox();
    await postAdd(boxId, { passportId: refPassportId }).expect(201);
    const before = await snapshot(boxId, altPassportId);

    const res = await postAdd(boxId, { passportId: altPassportId });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('BOX_HOMOGENEITY_VIOLATED');

    expectNoSideEffects(before, await snapshot(boxId, altPassportId));
  });

  test('homogeneity: разный sizeId → 409 BOX_HOMOGENEITY_VIOLATED, без сайд-эффектов', async () => {
    const refPassportId = await makePassport({
      productId: seed.product.id,
      sizeId: seed.sizes.M,
      color: seed.product.color,
    });
    const altPassportId = await makePassport({
      productId: seed.product.id,
      sizeId: seed.sizes.L,
      color: seed.product.color,
    });
    const boxId = await createBox();
    await postAdd(boxId, { passportId: refPassportId }).expect(201);
    const before = await snapshot(boxId, altPassportId);

    const res = await postAdd(boxId, { passportId: altPassportId });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('BOX_HOMOGENEITY_VIOLATED');

    expectNoSideEffects(before, await snapshot(boxId, altPassportId));
  });

  test('homogeneity: разный color → 409 BOX_HOMOGENEITY_VIOLATED, без сайд-эффектов', async () => {
    const refPassportId = await makePassport({
      productId: seed.product.id,
      sizeId: seed.sizes.M,
      color: 'Белая',
    });
    const altPassportId = await makePassport({
      productId: seed.product.id,
      sizeId: seed.sizes.M,
      color: 'Чёрная',
    });
    const boxId = await createBox();
    await postAdd(boxId, { passportId: refPassportId }).expect(201);
    const before = await snapshot(boxId, altPassportId);

    const res = await postAdd(boxId, { passportId: altPassportId });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('BOX_HOMOGENEITY_VIOLATED');

    expectNoSideEffects(before, await snapshot(boxId, altPassportId));
  });

  // ---------------------------------------------------------------------------
  // 6. Capacity overflow: qtyGood > maxQty - totalQty → 422 BOX_CAPACITY.
  // ---------------------------------------------------------------------------

  test('capacity: qtyGood > maxQty-totalQty → 422 BOX_CAPACITY_EXCEEDED, без сайд-эффектов', async () => {
    // maxQty=10. Добавляем p1 на 8 → totalQty=8, remaining=2.
    // p2.qtyGood=3 — не помещается.
    const p1 = await makePassport({ qtyCut: 8, qtyGood: 8 });
    const p2 = await makePassport({ qtyCut: 3, qtyGood: 3 });
    const boxId = await createBox(10);
    await postAdd(boxId, { passportId: p1 }).expect(201);
    const before = await snapshot(boxId, p2);
    expect(before.boxTotalQty).toBe(8);

    const res = await postAdd(boxId, { passportId: p2 });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('BOX_CAPACITY_EXCEEDED');

    expectNoSideEffects(before, await snapshot(boxId, p2));
  });

  // ---------------------------------------------------------------------------
  // 7. Дубль add: повторный add того же паспорта в ту же коробку
  //    после успешного add ловит PASSPORT_ALREADY_PACKED и не плодит
  //    второй BoxItem / второй PACKED event / второй audit.
  // ---------------------------------------------------------------------------

  test('повторный add того же passport → 409 PASSPORT_ALREADY_PACKED, BoxItem/event/audit count = 1', async () => {
    const passportId = await makePassport({ qtyCut: 2, qtyGood: 2 });
    const boxId = await createBox();

    const first = await postAdd(boxId, { passportId });
    expect(first.status).toBe(201);
    const afterFirst = await snapshot(boxId, passportId);
    expect(afterFirst.boxItemCount).toBe(1);
    expect(afterFirst.boxTotalQty).toBe(2);
    expect(afterFirst.packedEventCount).toBe(1);
    expect(afterFirst.auditPackedCount).toBe(1);

    const second = await postAdd(boxId, { passportId });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('PASSPORT_ALREADY_PACKED');

    // После второго вызова ничего не сдвинулось.
    expectNoSideEffects(afterFirst, await snapshot(boxId, passportId));
  });
});
