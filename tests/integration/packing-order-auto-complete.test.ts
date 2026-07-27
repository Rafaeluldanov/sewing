/**
 * Integration-тест авто-завершения заказа при полной упаковке
 * (`PackingService.maybeCompleteOrderOnPack`, вызывается из
 * `addPassport`-транзакции).
 *
 * Правило: заказ переходит `IN_PRODUCTION → DONE` автоматически ровно
 * тогда, когда упаковка последнего изделия закрывает тираж — но ТОЛЬКО
 * если весь тираж уже ВЫПУЩЕН (все ожидаемые тройки `(расклад, размер,
 * рулон)` завершённой задачи раскроя покрыты non-CANCELLED паспортами).
 * Гейт полноты выпуска (`isOrderCuttingFullyReleased`) защищает от
 * преждевременного и НЕОБРАТИМОГО закрытия при инкрементальном
 * порулонном выпуске (`PassportsService.releaseFromRolls`): `DONE`
 * блокирует дальнейший выпуск.
 *
 * Что покрываем:
 *   1. happy-path: 1 рулон выпущен + упакован → заказ DONE + аудит
 *      `ORDER_AUTO_COMPLETED`;
 *   2. частичный выпуск (2 рулона, упакован 1) → заказ остаётся
 *      IN_PRODUCTION; после упаковки второго → DONE;
 *   3. задача раскроя ещё не DONE → упаковка не закрывает заказ;
 *   4. отменённый рулон (CANCELLED-паспорт) не считается выпущенным →
 *      заказ не закрывается (симметрия с меткой «Завершено» на доске
 *      помощника).
 *
 * Стиль — как `packing-add-validation.test.ts`: passport-ы создаём
 * напрямую через Prisma в нужном «состоянии входа», через HTTP идём
 * только сам `POST /api/packing/boxes/:id/add-passport`.
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

describeWithDb('integration — авто-DONE заказа при полной упаковке', () => {
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
    cookies = { packer: loginAs(t, seed.employees['packer']) };

    // Упаковщику нужна активная PACKING-смена (assertPackingActor).
    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.packer)
      .send({
        equipmentId: seed.equipment['packing-station-01'].id,
        operationId: seed.operations.PACKING.id,
      })
      .expect(201);
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Заказ в IN_PRODUCTION без QC/IRONING-шагов (route-gate пропускается). */
  async function createOrder(): Promise<string> {
    const order = await t.prisma.order.create({
      data: {
        number: `O-AC-${Math.random().toString(36).slice(2, 8)}`,
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
    return order.id;
  }

  /**
   * Задача раскроя: 1 расклад, размер M на настиле (`perLayerQty=3`),
   * `rollCount` рулонов (по 5 слоёв). `status` — по умолчанию DONE.
   * Ожидаемых троек = rollCount.
   */
  async function createCuttingTask(
    orderId: string,
    rollCount: number,
    status: 'IN_PROGRESS' | 'DONE' = 'DONE',
    /**
     * Частичное завершение раскроя: закрыт ли расклад («Расклад готов»).
     * Нужен, чтобы зафиксировать осознанное решение — авто-завершение
     * заказа при упаковке смотрит на статус ЗАДАЧИ, а не на закрытые
     * расклады (см. кейс 3b и `isOrderCuttingFullyReleased`).
     */
    layClosed = false,
  ): Promise<void> {
    await t.prisma.cuttingTask.create({
      data: {
        orderId,
        status,
        completedAt: status === 'DONE' ? new Date() : null,
        lays: {
          create: [
            {
              ordinal: 1,
              completedAt: layClosed || status === 'DONE' ? new Date() : null,
              laySizes: {
                create: [
                  {
                    sizeId: seed.sizes.M,
                    sizeCodeSnapshot: 'M',
                    sortOrder: 20,
                    perLayerQty: 3,
                  },
                ],
              },
              rolls: {
                create: Array.from({ length: rollCount }, (_, i) => ({
                  ordinal: i + 1,
                  layers: 5,
                })),
              },
            },
          ],
        },
      },
    });
  }

  /** Паспорт, «выпущенный» из рулона `rollOrdinal` расклада 1, размер M. */
  async function releasePassport(
    orderId: string,
    rollOrdinal: number,
    status: 'IN_PROGRESS' | 'CANCELLED' = 'IN_PROGRESS',
  ): Promise<string> {
    const random = Math.random().toString(36).slice(2, 8);
    const passport = await t.prisma.passport.create({
      data: {
        number: `P-AC-${random}`,
        qrCode: `passport:ac-${random}`,
        orderId,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: seed.product.color,
        rollNumber: `R-${random}`,
        cutDate: new Date(),
        qtyPlan: 2,
        qtyCut: 2,
        qtyGood: 2,
        status,
        cuttingLayOrdinal: 1,
        rollOrdinal,
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

  /** Упаковать паспорт (`POST add-passport`); по умолчанию ждём 201. */
  async function packPassport(
    boxId: string,
    passportId: string,
  ): Promise<void> {
    const res = await request(t.app.getHttpServer())
      .post(`/api/packing/boxes/${boxId}/add-passport`)
      .set('Cookie', cookies.packer)
      .send({ passportId });
    expect(res.status).toBe(201);
  }

  async function orderStatus(orderId: string): Promise<string> {
    const o = await t.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { status: true },
    });
    return o.status;
  }

  async function autoCompleteAuditCount(orderId: string): Promise<number> {
    return t.prisma.auditLog.count({
      where: { event: 'ORDER_AUTO_COMPLETED', entityId: orderId },
    });
  }

  // ---------------------------------------------------------------------------
  // 1. Happy path — 1 рулон, выпущен и упакован → DONE + аудит.
  // ---------------------------------------------------------------------------

  test('полностью выпущенный тираж (1 рулон): упаковка последнего изделия → DONE + аудит', async () => {
    const orderId = await createOrder();
    await createCuttingTask(orderId, 1);
    const passportId = await releasePassport(orderId, 1);
    const boxId = await createBox();

    expect(await orderStatus(orderId)).toBe('IN_PRODUCTION');
    await packPassport(boxId, passportId);

    expect(await orderStatus(orderId)).toBe('DONE');
    expect(await autoCompleteAuditCount(orderId)).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 2. Частичный выпуск — гейт полноты не даёт закрыть заказ раньше.
  // ---------------------------------------------------------------------------

  test('2 рулона, выпущен и упакован только первый → заказ остаётся IN_PRODUCTION', async () => {
    const orderId = await createOrder();
    await createCuttingTask(orderId, 2); // ожидается 2 тройки
    const roll1 = await releasePassport(orderId, 1);
    const boxId = await createBox();

    await packPassport(boxId, roll1);

    // Второй рулон ещё НЕ выпущен → releasedPairs(1) < totalPairs(2).
    expect(await orderStatus(orderId)).toBe('IN_PRODUCTION');
    expect(await autoCompleteAuditCount(orderId)).toBe(0);
  });

  test('2 рулона: после выпуска и упаковки ВТОРОГО рулона заказ → DONE', async () => {
    const orderId = await createOrder();
    await createCuttingTask(orderId, 2);
    const roll1 = await releasePassport(orderId, 1);
    const box1 = await createBox();
    await packPassport(box1, roll1);
    expect(await orderStatus(orderId)).toBe('IN_PRODUCTION');

    // Помощник выпустил остаток тиража; упаковываем второй рулон.
    const roll2 = await releasePassport(orderId, 2);
    const box2 = await createBox();
    await packPassport(box2, roll2);

    expect(await orderStatus(orderId)).toBe('DONE');
    expect(await autoCompleteAuditCount(orderId)).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 3. Задача раскроя ещё не DONE — «полнота выпуска» недостижима.
  // ---------------------------------------------------------------------------

  test('задача раскроя IN_PROGRESS: упаковка не закрывает заказ', async () => {
    const orderId = await createOrder();
    await createCuttingTask(orderId, 1, 'IN_PROGRESS');
    const passportId = await releasePassport(orderId, 1);
    const boxId = await createBox();

    await packPassport(boxId, passportId);

    expect(await orderStatus(orderId)).toBe('IN_PRODUCTION');
    expect(await autoCompleteAuditCount(orderId)).toBe(0);
  });

  /**
   * 3b. Частичное завершение раскроя: расклад ЗАКРЫТ, весь тираж по нему
   * выпущен и упакован, но раскройщик ещё не нажал «Раскрой завершён».
   *
   * Заказ СОЗНАТЕЛЬНО не закрывается: пока задача `IN_PROGRESS`,
   * раскройщик может добавить ещё расклад, и авто-`DONE` заблокировал бы
   * дальнейший выпуск (`create`/`releaseFromRolls` требуют
   * `IN_PRODUCTION`). Очередь выпуска при этом считает полноту по закрытым
   * раскладам и покажет строку `WAITING` — это разные критерии, и так и
   * задумано (см. `isOrderCuttingFullyReleased`,
   * `CuttingTasksService.listReadyForRelease`).
   */
  test('закрытый расклад при задаче IN_PROGRESS: заказ всё равно не закрывается', async () => {
    const orderId = await createOrder();
    await createCuttingTask(orderId, 1, 'IN_PROGRESS', true);
    const passportId = await releasePassport(orderId, 1);
    const boxId = await createBox();

    await packPassport(boxId, passportId);

    expect(await orderStatus(orderId)).toBe('IN_PRODUCTION');
    expect(await autoCompleteAuditCount(orderId)).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // 4. Отменённый рулон не считается выпущенным.
  // ---------------------------------------------------------------------------

  test('2 рулона: первый отменён (CANCELLED), второй упакован → заказ НЕ закрывается', async () => {
    const orderId = await createOrder();
    await createCuttingTask(orderId, 2);
    // Рулон 1 выпущен, но паспорт отменён — тройка не покрыта.
    await releasePassport(orderId, 1, 'CANCELLED');
    const roll2 = await releasePassport(orderId, 2);
    const boxId = await createBox();

    await packPassport(boxId, roll2);

    // releasedPairs учитывает только non-CANCELLED → 1 из 2.
    expect(await orderStatus(orderId)).toBe('IN_PRODUCTION');
    expect(await autoCompleteAuditCount(orderId)).toBe(0);
  });
});
