/**
 * Integration-тест: возврат ОТК на переделку шага, закрытого через
 * `OperationSubstitution` (см. `QcService.computeEligibleReworkTargets`
 * и `returnToRework`).
 *
 * Реальный кейс прод-цеха: на сплит-маршруте шаг «Распошив рукав» (16)
 * фактически закрывается операцией «04 РАСПОШИВ» (substitute), своего
 * `OPERATION_FINISHED` шаг не получает. Прямой AND-гейт ОТК
 * (`assertParallelGroupCompleteForQc`) подстановку учитывает и
 * пропускает паспорт, а возврат на переделку раньше — нет, поэтому ОТК
 * «не мог вернуть на распошив». Здесь моделируем это на seed-операциях:
 *   - шаг маршрута   = `SEW_OVERLOCK_2`   (аналог «16 Распошив рукав»);
 *   - substitute     = `SEW_OVERLOCK_1`   (аналог «04 РАСПОШИВ»),
 *     по нему есть FINISHED швеи и висящее pending-начисление.
 *
 * Проверяем:
 *   1. qc-detail отдаёт шаг в `eligibleReworkTargets` с
 *      `finishedOperationId = substitute` и швеёй-финишёром;
 *   2. return-to-rework переводит паспорт на шаг маршрута, пишет
 *      `OPERATION_REWORK_OPENED` на швею-финишёра;
 *   3. висящее начисление по substitute-операции отменяется.
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

describeWithDb('integration — QC return to rework via substitute', () => {
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
    cookies = { master: loginAs(t, seed.employees['master']) };
  });

  /**
   * Паспорт на ОТК, где шаг `SEW_OVERLOCK_2` закрыт не сам, а через
   * substitute `SEW_OVERLOCK_1`: есть FINISHED по substitute (швея) и
   * pending-начисление под substitute. Своего FINISHED у шага нет.
   */
  async function setupSubstituteClosedPassport(): Promise<{
    passportId: string;
    stepOpId: string;
    substituteOpId: string;
  }> {
    const stepOpId = seed.operations.SEW_OVERLOCK_2.id; // «16 Распошив рукав»
    const substituteOpId = seed.operations.SEW_OVERLOCK_1.id; // «04 РАСПОШИВ»
    const qtyCut = 5;

    const order = await t.prisma.order.create({
      data: {
        number: `O-SUB-${Math.random().toString(36).slice(2, 8)}`,
        orderDate: new Date(),
        color: 'Чёрный',
        status: 'IN_PRODUCTION',
        items: {
          create: [
            { productId: seed.product.id, sizeId: seed.sizes.M, qtyPlan: qtyCut },
          ],
        },
      },
    });
    await t.prisma.orderRouteStep.createMany({
      data: [
        { orderId: order.id, index: 0, operationId: seed.operations.CUT_DIVISION.id },
        { orderId: order.id, index: 1, operationId: stepOpId },
        { orderId: order.id, index: 2, operationId: seed.operations.QC.id },
      ],
    });
    // Правило подстановки: закрытие substitute засчитывает шаг.
    await t.prisma.operationSubstitution.create({
      data: { satisfiesOpId: stepOpId, substituteOpId },
    });

    const passport = await t.prisma.passport.create({
      data: {
        number: `P-SUB-${Math.random().toString(36).slice(2, 8)}`,
        qrCode: `passport:sub-${Math.random().toString(36).slice(2, 8)}`,
        orderId: order.id,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: 'Чёрный',
        rollNumber: 'R-SUB',
        cutDate: new Date(),
        qtyPlan: qtyCut,
        qtyCut,
        qtyGood: qtyCut,
        cutterId: seed.employees['cutter'].id,
        creatorId: seed.employees['cutter'].id,
        status: 'IN_PROGRESS',
        currentOperationId: seed.operations.QC.id,
        currentRouteStepIndex: 2,
        currentEmployeeId: null,
      },
    });
    // FINISHED пишется на ФАКТИЧЕСКИ выполненную (substitute) операцию.
    await t.prisma.passportEvent.create({
      data: {
        passportId: passport.id,
        type: 'OPERATION_FINISHED',
        employeeId: seed.employees['seamstress'].id,
        operationId: substituteOpId,
        qty: qtyCut,
        createdAt: new Date(Date.now() - 60_000),
      },
    });
    // Висящее сдельное начисление создаётся под substitute-операцией
    // (см. EarningsService) — именно его должен снять возврат.
    await t.prisma.operationEntry.create({
      data: {
        passportId: passport.id,
        operationId: substituteOpId,
        employeeId: seed.employees['seamstress'].id,
        qty: qtyCut,
        ratePerUnit: '20.00',
        amount: '100.00',
        status: 'PENDING_RELEASE',
      },
    });
    return { passportId: passport.id, stepOpId, substituteOpId };
  }

  test('qc-detail: шаг, закрытый substitute, попадает в eligibleReworkTargets', async () => {
    const { passportId, stepOpId, substituteOpId } =
      await setupSubstituteClosedPassport();

    const res = await request(t.app.getHttpServer())
      .get(`/api/master-actions/passports/${passportId}/qc-detail`)
      .set('Cookie', cookies.master);
    expect(res.status).toBe(200);
    expect(res.body.canReturnToRework).toBe(true);

    const target = res.body.eligibleReworkTargets.find(
      (x: { operationId: string }) => x.operationId === stepOpId,
    );
    expect(target).toBeTruthy();
    // Возвращаем на шаг маршрута, но finisher/начисление — от substitute.
    expect(target.finishedOperationId).toBe(substituteOpId);
    expect(target.finisherEmployeeId).toBe(seed.employees['seamstress'].id);
  });

  test('return-to-rework: паспорт уходит на шаг, REWORK_OPENED швее, pending по substitute снят', async () => {
    const { passportId, stepOpId, substituteOpId } =
      await setupSubstituteClosedPassport();

    const res = await request(t.app.getHttpServer())
      .post(`/api/master-actions/passports/${passportId}/return-to-rework`)
      .set('Cookie', cookies.master)
      .send({ targetOperationId: stepOpId });
    expect(res.status).toBe(201);

    const passport = await t.prisma.passport.findUnique({
      where: { id: passportId },
    });
    expect(passport?.currentOperationId).toBe(stepOpId);
    expect(passport?.currentRouteStepIndex).toBe(1);
    expect(passport?.currentEmployeeId).toBeNull();

    const rework = await t.prisma.passportEvent.findFirst({
      where: { passportId, type: 'OPERATION_REWORK_OPENED' },
      orderBy: { createdAt: 'desc' },
    });
    expect(rework?.operationId).toBe(stepOpId);
    expect(rework?.employeeId).toBe(seed.employees['seamstress'].id);

    // Висящее начисление под substitute-операцией должно исчезнуть.
    const pending = await t.prisma.operationEntry.findFirst({
      where: { passportId, operationId: substituteOpId },
    });
    expect(pending).toBeNull();
  });
});
