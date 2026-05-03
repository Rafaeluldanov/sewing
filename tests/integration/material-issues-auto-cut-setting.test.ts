/**
 * Hardening-итерация «Автосписание материалов при выдаче кроя» —
 * gate по `CompanySettings.autoIssueMaterialsOnCutRelease`
 * (см. `prisma/schema.prisma::CompanySettings`,
 * `apps/api/src/modules/company-settings/company-settings.service.ts::getAutoIssueMaterialsOnCutRelease`,
 * `apps/api/src/modules/passports/passports.service.ts::issueToEmployee`,
 * `apps/api/src/modules/material-issues/material-issues.service.ts::createAutoCutIssueForPassport`,
 * `docs/current-state.md §«Auto cut issue»`).
 *
 * Покрытие:
 *   1. `autoIssueMaterialsOnCutRelease = false`: `issueToEmployee`
 *      проходит, MaterialIssue НЕ создаётся.
 *   2. `autoIssueMaterialsOnCutRelease = true`: `issueToEmployee`
 *      создаёт POSTED AUTO_CUT_ISSUE MaterialIssue (поведение
 *      hardening = no-regression относительно предыдущей итерации).
 *   3. Singleton-строки `CompanySettings` нет вообще
 *      (свежая БД): `getAutoIssueMaterialsOnCutRelease()` ⇒ `false`,
 *      issueToEmployee проходит без авто-документа.
 *   4. При `false` событие `PassportEvent(ISSUED_TO_EMPLOYEE)` всё
 *      равно создаётся, статус паспорта переходит в `IN_PROGRESS`,
 *      `currentEmployeeId` фиксируется. То есть гейт ВЫКЛЮЧАЕТ
 *      только материальный документ, не саму выдачу.
 *
 * Тесты используют `TEST_DATABASE_URL` — без него `describeWithDb`
 * превращается в `describe.skip`.
 */
import { Prisma, PassportEventType } from '@prisma/client';
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

describeWithDb('integration — material issues auto cut gate (CompanySettings.autoIssueMaterialsOnCutRelease)', () => {
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
    };
    // CompanySettings не входит в truncate-набор `resetDatabase`,
    // поэтому каждый тест явно управляет состоянием singleton-а:
    //   - создаёт строку с нужным значением флага, либо
    //   - удаляет её (см. test «settings missing» ниже).
    // По умолчанию начинаем с чистого состояния (нет строки) —
    // тесты сами решат, что им нужно.
    await t.prisma.companySettings.deleteMany({});
  });

  /**
   * Готовит заказ + WorkshopNeed + паспорт на ячейке + активную
   * смену швеи. Возвращает `passportId` для дальнейшего issue.
   * Аналог `prepareOrderAndPassport` из основного test-файла —
   * локальная копия, чтобы файл оставался независимым.
   */
  async function prepareOrderAndPassport(opts: {
    qtyPlan: number;
    qtyCut: number;
    quotedPrice?: string;
    quotedCurrency?: string;
  }): Promise<{ orderId: string; passportId: string; workshopNeedId: string }> {
    const tcSuffix = Math.random().toString(36).slice(2, 7).toUpperCase();
    const tc = await request(t.app.getHttpServer())
      .post('/api/tech-cards')
      .set('Cookie', cookies.manager)
      .send({
        code: `TC-AUTO-GATE-${tcSuffix}`,
        name: 'Auto cut gate demo',
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
        items: [{ sizeId: seed.sizes.M, qtyPlan: opts.qtyPlan }],
        techCardId: tc.body.id,
      })
      .expect(201);
    const orderId: string = order.body.id;

    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);

    const need = await t.prisma.workshopNeed.findFirstOrThrow({
      where: { orderId, materialRole: 'MAIN_FABRIC' },
    });
    if (opts.quotedPrice !== undefined) {
      await t.prisma.workshopNeed.update({
        where: { id: need.id },
        data: {
          quotedPrice: new Prisma.Decimal(opts.quotedPrice),
          quotedCurrency: opts.quotedCurrency ?? 'RUB',
        },
      });
    }

    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);

    const passport = await request(t.app.getHttpServer())
      .post('/api/passports')
      .set('Cookie', cookies.manager)
      .send({
        orderId,
        sizeId: seed.sizes.M,
        rollNumber: `R-AUTO-GATE-${tcSuffix}`,
        cutDate: '2026-04-15T00:00:00.000Z',
        qtyCut: opts.qtyCut,
        cutterId: seed.employees.cutter.id,
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

    return { orderId, passportId, workshopNeedId: need.id };
  }

  async function issue(passportId: string): Promise<void> {
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);
  }

  // ---------------------------------------------------------------------------
  // 1. autoIssueMaterialsOnCutRelease = false → MaterialIssue не создаётся
  // ---------------------------------------------------------------------------

  test('флаг = false: issueToEmployee проходит, MaterialIssue не создаётся', async () => {
    await t.prisma.companySettings.upsert({
      where: { id: 'default' },
      create: {
        id: 'default',
        singleton: true,
        autoIssueMaterialsOnCutRelease: false,
      },
      update: { autoIssueMaterialsOnCutRelease: false },
    });

    const { passportId } = await prepareOrderAndPassport({
      qtyPlan: 10,
      qtyCut: 4,
      quotedPrice: '100',
      quotedCurrency: 'RUB',
    });

    await issue(passportId);

    const issues = await t.prisma.materialIssue.findMany({
      where: { passportId },
    });
    expect(issues).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // 2. autoIssueMaterialsOnCutRelease = true → POSTED AUTO_CUT_ISSUE
  //    создаётся (no-regression относительно предыдущей итерации)
  // ---------------------------------------------------------------------------

  test('флаг = true: issueToEmployee создаёт POSTED AUTO_CUT_ISSUE MaterialIssue', async () => {
    await t.prisma.companySettings.upsert({
      where: { id: 'default' },
      create: {
        id: 'default',
        singleton: true,
        autoIssueMaterialsOnCutRelease: true,
      },
      update: { autoIssueMaterialsOnCutRelease: true },
    });

    const { passportId } = await prepareOrderAndPassport({
      qtyPlan: 10,
      qtyCut: 4,
      quotedPrice: '100',
      quotedCurrency: 'RUB',
    });

    await issue(passportId);

    const issues = await t.prisma.materialIssue.findMany({
      where: { passportId },
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.source).toBe('AUTO_CUT_ISSUE');
    expect(issues[0]!.sourceKey).toBe(`AUTO_CUT_ISSUE:${passportId}`);
    expect(issues[0]!.status).toBe('POSTED');
  });

  // ---------------------------------------------------------------------------
  // 3. Singleton-строки CompanySettings нет → trampoline на false
  // ---------------------------------------------------------------------------

  test('строки CompanySettings нет: считается false, MaterialIssue не создаётся', async () => {
    // beforeEach уже сделал deleteMany — отдельной подготовки не нужно.
    const before = await t.prisma.companySettings.findUnique({
      where: { id: 'default' },
    });
    expect(before).toBeNull();

    const { passportId } = await prepareOrderAndPassport({
      qtyPlan: 10,
      qtyCut: 4,
      quotedPrice: '100',
      quotedCurrency: 'RUB',
    });

    await issue(passportId);

    const issues = await t.prisma.materialIssue.findMany({
      where: { passportId },
    });
    expect(issues).toHaveLength(0);

    // Гейт НЕ должен был сам создавать singleton-строку
    // (см. JSDoc `getAutoIssueMaterialsOnCutRelease`).
    const after = await t.prisma.companySettings.findUnique({
      where: { id: 'default' },
    });
    expect(after).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // 4. При false штатная выдача (event/status/currentEmployee) не ломается
  // ---------------------------------------------------------------------------

  test('флаг = false: PassportEvent(ISSUED_TO_EMPLOYEE) и обновление паспорта проходят как раньше', async () => {
    await t.prisma.companySettings.upsert({
      where: { id: 'default' },
      create: {
        id: 'default',
        singleton: true,
        autoIssueMaterialsOnCutRelease: false,
      },
      update: { autoIssueMaterialsOnCutRelease: false },
    });

    const { passportId } = await prepareOrderAndPassport({
      qtyPlan: 10,
      qtyCut: 4,
      quotedPrice: '100',
      quotedCurrency: 'RUB',
    });

    await issue(passportId);

    const passport = await t.prisma.passport.findUniqueOrThrow({
      where: { id: passportId },
    });
    expect(passport.status).toBe('IN_PROGRESS');
    expect(passport.currentEmployeeId).toBe(seed.employees.seamstress.id);
    expect(passport.currentCellId).toBeNull();

    const event = await t.prisma.passportEvent.findFirst({
      where: { passportId, type: PassportEventType.ISSUED_TO_EMPLOYEE },
    });
    expect(event).not.toBeNull();
    expect(event!.employeeId).toBe(seed.employees.seamstress.id);
    expect(event!.qty).toBe(4);
  });
});
