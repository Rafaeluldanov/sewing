/**
 * Integration-тесты «незакрытой работы» со стороны САМОГО сотрудника:
 * список `GET /api/shifts/my-unclosed` и закрытие долга
 * `POST /api/passports/:id/close-unclosed-operation`.
 *
 * Зачем это вообще появилось. До 01.09.2026 паспорт, взятый швеёй,
 * мог увести вперёд любой следующий скан — в том числе ОТК (гейт не
 * проверял шаг, на котором паспорт СТОИТ, см.
 * `PassportsService.evaluateRouteOrder::currentStepCandidate`). Паспорт
 * молча исчезал из «В работе у вас», `OPERATION_FINISHED` по взятой
 * операции не появлялся, а без него нет `OperationEntry`: сделка за уже
 * сделанную работу не начислялась НИКОМУ. Инцидент 17-18.08.2026 на
 * 02-00013 стоил 3 743,44 руб., 31.08.2026 на 02-00020 так потерялся
 * P-20260822-0013 (19 изделий).
 *
 * Гейт эту дыру закрыл, но остаётся накопленный долг и мастерский
 * `set-route-step`, который паспорт продавливает вперёд намеренно.
 * Поэтому у сотрудника обязан быть свой список и своя кнопка — иначе
 * гейт просто превратится в «залипший паспорт до мастера», ровно то,
 * чего боялись 23.08.2026.
 *
 * Ключевое свойство закрытия: паспорт НЕ двигается. Пере-взятие тянуло
 * бы его назад на швейный шаг, и уже пройденный ОТК пришлось бы
 * проходить второй раз (то, что реально случилось на 02-00020).
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import { loginAs, startTestApp, stopTestApp, type TestApp } from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

describeWithDb('integration — passports.unclosed-work', () => {
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
    cookies = { seamstress: loginAs(t, seed.employees['seamstress']) };
  });

  /**
   * Воспроизводит долг ровно так, как он возникал на проде: швея взяла
   * SEW_OVERLOCK_2 (событие `ISSUED_TO_EMPLOYEE`), закрытия нет, а
   * паспорт уже уехал на ОТК и владельца потерял.
   *
   * `takenAway = false` оставляет паспорт на руках у швеи — это НЕ долг,
   * а нормальная работа, и её показывает «В работе у вас».
   */
  async function setupDebt(opts: { takenAway?: boolean } = {}) {
    const takenAway = opts.takenAway ?? true;
    const today = new Date();
    const order = await t.prisma.order.create({
      data: {
        number: `O-UNC-${Math.random().toString(36).slice(2, 8)}`,
        orderDate: today,
        color: 'Чёрный',
        status: 'IN_PRODUCTION',
        items: {
          create: [
            { productId: seed.product.id, sizeId: seed.sizes.M, qtyPlan: 4 },
          ],
        },
      },
    });
    await t.prisma.orderRouteStep.createMany({
      data: [
        { orderId: order.id, index: 0, operationId: seed.operations.CUT_DIVISION.id },
        { orderId: order.id, index: 1, operationId: seed.operations.SEW_OVERLOCK_1.id },
        { orderId: order.id, index: 2, operationId: seed.operations.SEW_OVERLOCK_2.id },
        { orderId: order.id, index: 3, operationId: seed.operations.QC.id },
      ],
    });
    const passport = await t.prisma.passport.create({
      data: {
        number: `P-UNC-${Math.random().toString(36).slice(2, 8)}`,
        qrCode: `passport:unc-${Math.random().toString(36).slice(2, 8)}`,
        orderId: order.id,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: 'Чёрный',
        rollNumber: 'R-UNC',
        cutDate: today,
        qtyPlan: 4,
        qtyCut: 4,
        qtyGood: 4,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
        status: 'IN_PROGRESS',
        // Паспорт уже на ОТК (idx 3) и ничей — так выглядит перехват.
        currentOperationId: takenAway
          ? seed.operations.QC.id
          : seed.operations.SEW_OVERLOCK_2.id,
        currentRouteStepIndex: takenAway ? 3 : 2,
        currentEmployeeId: takenAway ? null : seed.employees.seamstress.id,
      },
    });
    // Предыдущий швейный шаг закрыт, свой — нет: это и есть долг.
    await t.prisma.passportEvent.create({
      data: {
        passportId: passport.id,
        type: 'OPERATION_FINISHED',
        operationId: seed.operations.SEW_OVERLOCK_1.id,
        employeeId: seed.employees.seamstress.id,
        qty: 4,
      },
    });
    await t.prisma.passportEvent.create({
      data: {
        passportId: passport.id,
        type: 'ISSUED_TO_EMPLOYEE',
        operationId: seed.operations.SEW_OVERLOCK_2.id,
        employeeId: seed.employees.seamstress.id,
        equipmentId: seed.equipment['overlock-01'].id,
        qty: 4,
      },
    });
    return { passportId: passport.id, orderId: order.id };
  }

  test('A. список: паспорт, который увели, виден с указанием, где он сейчас', async () => {
    const { passportId } = await setupDebt();

    const res = await request(t.app.getHttpServer())
      .get('/api/shifts/my-unclosed')
      .set('Cookie', cookies.seamstress)
      .expect(200);

    expect(res.body).toHaveLength(1);
    expect(res.body[0].passportId).toBe(passportId);
    expect(res.body[0].operationCode).toBe('SEW_OVERLOCK_2');
    // Ответ на «где искать» — без него человек пойдёт искать паспорт
    // по цеху, хотя для закрытия долга он не нужен вовсе.
    expect(res.body[0].standsOnOperationCode).toBe('QC');
    expect(res.body[0].heldByEmployeeName).toBeNull();
  });

  test('A-2. паспорт НА РУКАХ в список не попадает — его показывает «В работе у вас»', async () => {
    await setupDebt({ takenAway: false });

    const res = await request(t.app.getHttpServer())
      .get('/api/shifts/my-unclosed')
      .set('Cookie', cookies.seamstress)
      .expect(200);
    expect(res.body).toEqual([]);
  });

  test('B. закрытие долга: событие и начисление есть, паспорт НЕ сдвинулся', async () => {
    const { passportId } = await setupDebt();

    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/close-unclosed-operation`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);

    const finished = await t.prisma.passportEvent.findMany({
      where: {
        passportId,
        type: 'OPERATION_FINISHED',
        operationId: seed.operations.SEW_OVERLOCK_2.id,
      },
    });
    expect(finished).toHaveLength(1);
    expect(finished[0].employeeId).toBe(seed.employees.seamstress.id);
    // Станок берётся из события ВЗЯТИЯ, а не из текущей смены: долг
    // закрывают на следующий день, смена уже другая.
    expect(finished[0].equipmentId).toBe(seed.equipment['overlock-01'].id);

    const earnings = await t.prisma.operationEntry.findMany({
      where: { passportId, operationId: seed.operations.SEW_OVERLOCK_2.id },
    });
    expect(earnings).toHaveLength(1);
    expect(earnings[0].employeeId).toBe(seed.employees.seamstress.id);

    // Главное свойство: паспорт остался на ОТК. Пере-взятие утянуло бы
    // его назад и заставило проходить ОТК второй раз.
    const inDb = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passportId },
    });
    expect(inDb.currentRouteStepIndex).toBe(3);
    expect(inDb.currentOperationId).toBe(seed.operations.QC.id);
    expect(inDb.currentEmployeeId).toBeNull();

    // И долг ушёл из списка.
    const list = await request(t.app.getHttpServer())
      .get('/api/shifts/my-unclosed')
      .set('Cookie', cookies.seamstress)
      .expect(200);
    expect(list.body).toEqual([]);
  });

  test('B-2. повторное закрытие → 409, второго начисления нет', async () => {
    const { passportId } = await setupDebt();
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/close-unclosed-operation`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);

    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/close-unclosed-operation`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(409);

    const earnings = await t.prisma.operationEntry.findMany({
      where: { passportId, operationId: seed.operations.SEW_OVERLOCK_2.id },
    });
    expect(earnings).toHaveLength(1);
  });

  test('B-3. чужой долг закрыть нельзя: без своего взятия → 409', async () => {
    const { passportId } = await setupDebt();
    // Взятие переписываем на другого сотрудника — у швеи открытого
    // назначения по этому паспорту больше нет.
    await t.prisma.passportEvent.updateMany({
      where: { passportId, type: 'ISSUED_TO_EMPLOYEE' },
      data: { employeeId: seed.employees.cutter.id },
    });

    const res = await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/close-unclosed-operation`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(409);
    expect(res.body?.code).toBe('PASSPORT_NO_UNCLOSED_WORK');
  });
});
