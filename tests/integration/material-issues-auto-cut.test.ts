/**
 * Integration-тесты backend-итерации «Автосписание материалов при
 * выдаче кроя» (см. ТЗ,
 * `apps/api/src/modules/material-issues/material-issues.service.ts::createAutoCutIssueForPassport`,
 * `apps/api/src/modules/passports/passports.service.ts::issueToEmployee`,
 * `prisma/schema.prisma::MaterialIssue.source / sourceKey`,
 * `docs/current-state.md §«Auto cut issue»`).
 *
 * Формула расхода (ТЗ §5):
 *   issuedQty = WorkshopNeed.calculatedQty * Passport.qtyCut / totalOrderQty
 * где `totalOrderQty = Σ OrderItem.qtyPlan`.
 *
 * Покрытие (см. ТЗ §13 «Tests»):
 *
 *   1. issueToEmployee создаёт POSTED MaterialIssue с
 *      source = AUTO_CUT_ISSUE и sourceKey = AUTO_CUT_ISSUE:<passportId>.
 *   2. Auto issue связан с orderId и passportId паспорта.
 *   3. Строки рассчитаны пропорционально по формуле.
 *   4. unitCost берётся из WorkshopNeed.quotedPrice (RUB / null-валюта).
 *   5. unitCost = 0, если quotedPrice отсутствует / USD без курса.
 *   6. totalCost = Σ строк.
 *   7. Повторный issueToEmployee / retry не создаёт дубль
 *      (UNIQUE sourceKey).
 *   8. Существующий неотменённый MaterialIssue по passportId блокирует
 *      автосписание.
 *   9. Если у заказа нет WorkshopNeed / все calculatedQty=0 —
 *      issueToEmployee проходит без MaterialIssue.
 *  10. totalOrderQty = 0 (невозможно с qtyPlan>0, но проверим skip)
 *      — issueToEmployee всё равно проходит без MaterialIssue.
 *  11. Ручной POST /api/material-issues по-прежнему создаёт
 *      source = MANUAL, sourceKey = null.
 *  12. Audit MATERIAL_ISSUE_CREATED и MATERIAL_ISSUE_POSTED
 *      записываются для auto issue.
 *  13. MaterialIssueLine не создаёт строк StockBalance/StockMovement
 *      (таблиц нет в этой MVP-итерации).
 *
 * Тесты используют `TEST_DATABASE_URL` — без неё `describeWithDb`
 * превращается в `describe.skip`.
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

describeWithDb('integration — material issues (auto cut issue on issueToEmployee)', () => {
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
    // Hardening-флаг автосписания (см.
    // `prisma/schema.prisma::CompanySettings.autoIssueMaterialsOnCutRelease`,
    // `apps/api/src/modules/company-settings/company-settings.service.ts::getAutoIssueMaterialsOnCutRelease`).
    // Default `false` сознательно — после миграции production
    // автосписание не включается само. Все тесты этого файла
    // проверяют поведение «автосписание ВКЛ», поэтому singleton
    // настроек создаём явно с `true`. Гейт «автосписание ВЫКЛ»
    // покрывается отдельным файлом
    // `tests/integration/material-issues-auto-cut-setting.test.ts`.
    await t.prisma.companySettings.upsert({
      where: { id: 'default' },
      create: {
        id: 'default',
        singleton: true,
        autoIssueMaterialsOnCutRelease: true,
      },
      update: { autoIssueMaterialsOnCutRelease: true },
    });
  });

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  /**
   * Создаёт техкарту, заказ с одним размером и qtyPlan, запускает
   * заказ в производство, создаёт паспорт и размещает в ячейку.
   * Возвращает orderId, passportId и id первой WorkshopNeed
   * (MAIN_FABRIC), плюс totalOrderQty.
   */
  async function prepareOrderAndPassport(opts: {
    qtyPlan: number;
    qtyCut: number;
    quotedPrice?: string | null;
    quotedCurrency?: string | null;
    calculatedQty?: string | null; // если нужно override
  }): Promise<{
    orderId: string;
    passportId: string;
    workshopNeedId: string;
    totalOrderQty: number;
  }> {
    const tcSuffix = Math.random().toString(36).slice(2, 7).toUpperCase();
    const tc = await request(t.app.getHttpServer())
      .post('/api/tech-cards')
      .set('Cookie', cookies.manager)
      .send({
        code: `TC-AUTO-${tcSuffix}`,
        name: 'Auto cut issue demo',
        materialLines: [
          {
            name: 'Кулирка чёрная',
            unit: 'кг',
            // 0.5 кг на изделие — легко считать.
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

    // Найдём MAIN_FABRIC need, при необходимости проставим price.
    const need = await t.prisma.workshopNeed.findFirstOrThrow({
      where: { orderId, materialRole: 'MAIN_FABRIC' },
    });
    const data: Prisma.WorkshopNeedUpdateInput = {};
    if (opts.quotedPrice !== undefined) {
      data.quotedPrice =
        opts.quotedPrice === null ? null : new Prisma.Decimal(opts.quotedPrice);
    }
    if (opts.quotedCurrency !== undefined) {
      data.quotedCurrency = opts.quotedCurrency;
    }
    if (opts.calculatedQty !== undefined && opts.calculatedQty !== null) {
      data.calculatedQty = new Prisma.Decimal(opts.calculatedQty);
    }
    if (Object.keys(data).length > 0) {
      await t.prisma.workshopNeed.update({ where: { id: need.id }, data });
    }

    // Запускаем заказ в производство, иначе паспорт не выпустим.
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);

    // Выпускаем паспорт с qtyCut.
    const passport = await request(t.app.getHttpServer())
      .post('/api/passports')
      .set('Cookie', cookies.manager)
      .send({
        orderId,
        sizeId: seed.sizes.M,
        rollNumber: `R-AUTO-${tcSuffix}`,
        cutDate: '2026-04-15T00:00:00.000Z',
        qtyCut: opts.qtyCut,
        cutterId: seed.employees.cutter.id,
      })
      .expect(201);
    const passportId: string = passport.body.id;

    // Размещаем в ячейку A1.
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/place`)
      .set('Cookie', cookies.manager)
      .send({ cellId: seed.cells.A1.id })
      .expect(201);

    // Старт смены у швеи, чтобы issueToEmployee прошёл.
    await request(t.app.getHttpServer())
      .post('/api/shifts/start')
      .set('Cookie', cookies.seamstress)
      .send({
        equipmentId: seed.equipment['overlock-01'].id,
        operationId: seed.operations.SEW_OVERLOCK_1.id,
      })
      .expect(201);

    return {
      orderId,
      passportId,
      workshopNeedId: need.id,
      totalOrderQty: opts.qtyPlan,
    };
  }

  async function issue(passportId: string): Promise<void> {
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);
  }

  // ---------------------------------------------------------------------------
  // 1-3, 6. Auto issue создаётся POSTED, source/sourceKey проставлены,
  //        пропорциональная формула работает.
  // ---------------------------------------------------------------------------

  test('issueToEmployee создаёт POSTED AUTO_CUT_ISSUE MaterialIssue с пропорциональной строкой', async () => {
    // Заказ: qtyPlan = 10 (Σ OrderItem.qtyPlan), qtyCut паспорта = 4.
    // WorkshopNeed.calculatedQty = 0.5 * 10 = 5 кг.
    // Ожидаем issuedQty = 5 * 4 / 10 = 2 кг.
    // quotedPrice = 100 RUB/кг → unitCost = 100, totalCost = 200.
    const { orderId, passportId, workshopNeedId } = await prepareOrderAndPassport({
      qtyPlan: 10,
      qtyCut: 4,
      quotedPrice: '100',
      quotedCurrency: 'RUB',
    });

    await issue(passportId);

    const issues = await t.prisma.materialIssue.findMany({
      where: { passportId },
      include: { lines: true },
    });
    expect(issues).toHaveLength(1);
    const auto = issues[0]!;
    expect(auto.source).toBe('AUTO_CUT_ISSUE');
    expect(auto.sourceKey).toBe(`AUTO_CUT_ISSUE:${passportId}`);
    expect(auto.status).toBe('POSTED');
    expect(auto.orderId).toBe(orderId);
    expect(auto.passportId).toBe(passportId);
    expect(auto.postedAt).not.toBeNull();
    expect(auto.createdById).toBe(seed.employees.seamstress.id);
    expect(auto.postedById).toBe(seed.employees.seamstress.id);

    expect(auto.lines).toHaveLength(1);
    const line = auto.lines[0]!;
    expect(line.workshopNeedId).toBe(workshopNeedId);
    expect(new Prisma.Decimal(line.issuedQty).toString()).toBe('2');
    expect(new Prisma.Decimal(line.unitCost).toString()).toBe('100');
    expect(new Prisma.Decimal(line.totalCost).toString()).toBe('200');
    expect(line.unit).toBe('кг');
    expect(line.materialRole).toBe('MAIN_FABRIC');
    expect(line.cellId).toBeNull();
    // totalCost документа = Σ строк
    expect(new Prisma.Decimal(auto.totalCost).toString()).toBe('200');
  });

  // ---------------------------------------------------------------------------
  // 4. unitCost использует quotedPrice при null-валюте тоже
  // ---------------------------------------------------------------------------

  test('unitCost берётся из quotedPrice даже если quotedCurrency = null', async () => {
    const { passportId } = await prepareOrderAndPassport({
      qtyPlan: 10,
      qtyCut: 2,
      quotedPrice: '50',
      quotedCurrency: null,
    });
    await issue(passportId);
    const auto = await t.prisma.materialIssue.findFirstOrThrow({
      where: { passportId, source: 'AUTO_CUT_ISSUE' },
      include: { lines: true },
    });
    expect(auto.lines).toHaveLength(1);
    // 5 * 2 / 10 = 1 кг × 50 = 50
    expect(new Prisma.Decimal(auto.lines[0]!.unitCost).toString()).toBe('50');
    expect(new Prisma.Decimal(auto.lines[0]!.totalCost).toString()).toBe('50');
  });

  // ---------------------------------------------------------------------------
  // 5. unitCost = 0 для USD без курса и для отсутствующей цены
  // ---------------------------------------------------------------------------

  test('unitCost = 0 при quotedCurrency = USD (конвертация на MVP не делается)', async () => {
    const { passportId } = await prepareOrderAndPassport({
      qtyPlan: 10,
      qtyCut: 5,
      quotedPrice: '3',
      quotedCurrency: 'USD',
    });
    await issue(passportId);
    const auto = await t.prisma.materialIssue.findFirstOrThrow({
      where: { passportId, source: 'AUTO_CUT_ISSUE' },
      include: { lines: true },
    });
    expect(auto.lines).toHaveLength(1);
    expect(new Prisma.Decimal(auto.lines[0]!.unitCost).toString()).toBe('0');
    expect(new Prisma.Decimal(auto.lines[0]!.totalCost).toString()).toBe('0');
    // Документ всё равно создан (с нулевой стоимостью и строками).
    expect(auto.status).toBe('POSTED');
  });

  test('unitCost = 0 при отсутствующем quotedPrice', async () => {
    const { passportId } = await prepareOrderAndPassport({
      qtyPlan: 10,
      qtyCut: 5,
      quotedPrice: null,
      quotedCurrency: null,
    });
    await issue(passportId);
    const auto = await t.prisma.materialIssue.findFirstOrThrow({
      where: { passportId, source: 'AUTO_CUT_ISSUE' },
      include: { lines: true },
    });
    expect(auto.lines).toHaveLength(1);
    expect(new Prisma.Decimal(auto.lines[0]!.unitCost).toString()).toBe('0');
    expect(new Prisma.Decimal(auto.lines[0]!.totalCost).toString()).toBe('0');
    expect(new Prisma.Decimal(auto.totalCost).toString()).toBe('0');
  });

  // ---------------------------------------------------------------------------
  // 7. Идемпотентность: retry не создаёт дубль
  // ---------------------------------------------------------------------------

  test('повторный issueToEmployee того же паспорта не создаёт второго auto MaterialIssue', async () => {
    const { passportId } = await prepareOrderAndPassport({
      qtyPlan: 10,
      qtyCut: 4,
      quotedPrice: '100',
      quotedCurrency: 'RUB',
    });
    await issue(passportId);
    const firstCount = await t.prisma.materialIssue.count({
      where: { passportId, source: 'AUTO_CUT_ISSUE' },
    });
    expect(firstCount).toBe(1);

    // Повторяем issue — это идемпотентный no-op для паспорта,
    // который уже в IN_PROGRESS у того же сотрудника.
    await request(t.app.getHttpServer())
      .post(`/api/passports/${passportId}/issue`)
      .set('Cookie', cookies.seamstress)
      .send({})
      .expect(201);

    const afterRetry = await t.prisma.materialIssue.count({
      where: { passportId, source: 'AUTO_CUT_ISSUE' },
    });
    expect(afterRetry).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 8. Существующий manual MaterialIssue по passportId блокирует
  //    автосписание
  // ---------------------------------------------------------------------------

  test('существующий неотменённый manual MaterialIssue по passportId предотвращает авто-дубль', async () => {
    const { passportId, orderId, workshopNeedId } = await prepareOrderAndPassport({
      qtyPlan: 10,
      qtyCut: 4,
      quotedPrice: '100',
      quotedCurrency: 'RUB',
    });

    // Создаём MANUAL документ ДО issueToEmployee.
    await request(t.app.getHttpServer())
      .post('/api/material-issues')
      .set('Cookie', cookies.manager)
      .send({
        orderId,
        passportId,
        lines: [
          { workshopNeedId, issuedQty: '1', unitCost: '100' },
        ],
      })
      .expect(201);

    await issue(passportId);

    const issues = await t.prisma.materialIssue.findMany({
      where: { passportId },
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.source).toBe('MANUAL');
    expect(issues[0]!.sourceKey).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // 9. Нет WorkshopNeed — issue проходит без MaterialIssue
  // ---------------------------------------------------------------------------

  test('если у заказа нет WorkshopNeed, issueToEmployee проходит и MaterialIssue не создаётся', async () => {
    // Создаём заказ без техкарты — WorkshopNeeds пустые (calculate
    // либо не вызываем, либо он ничего не положит).
    const order = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookies.manager)
      .send({
        orderDate: '2026-04-15T00:00:00.000Z',
        productId: seed.product.id,
        color: 'Чёрный',
        items: [{ sizeId: seed.sizes.M, qtyPlan: 3 }],
      })
      .expect(201);
    const orderId: string = order.body.id;

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
        rollNumber: 'R-NO-NEED',
        cutDate: '2026-04-15T00:00:00.000Z',
        qtyCut: 1,
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

    await issue(passportId);

    const issues = await t.prisma.materialIssue.findMany({
      where: { passportId },
    });
    expect(issues).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // 10. totalOrderQty = 0 путь — через qtyPlan > 0 достичь нельзя,
  //     но можно убедиться, что при всех CANCELLED needs авто-документ
  //     не создаётся (all_lines_zero / no_material_needs).
  // ---------------------------------------------------------------------------

  test('все WorkshopNeed отменены — issueToEmployee проходит без MaterialIssue', async () => {
    const { passportId, workshopNeedId } = await prepareOrderAndPassport({
      qtyPlan: 5,
      qtyCut: 2,
      quotedPrice: '100',
      quotedCurrency: 'RUB',
    });

    // Отменяем единственную строку WorkshopNeed ДО выдачи.
    await t.prisma.workshopNeed.update({
      where: { id: workshopNeedId },
      data: { status: 'CANCELLED' },
    });

    await issue(passportId);

    const issues = await t.prisma.materialIssue.findMany({
      where: { passportId },
    });
    expect(issues).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // 11. Manual create по-прежнему source=MANUAL, sourceKey=null
  // ---------------------------------------------------------------------------

  test('manual POST /api/material-issues создаёт source=MANUAL, sourceKey=null', async () => {
    const { orderId, workshopNeedId } = await prepareOrderAndPassport({
      qtyPlan: 5,
      qtyCut: 1,
      quotedPrice: '100',
      quotedCurrency: 'RUB',
    });

    const res = await request(t.app.getHttpServer())
      .post('/api/material-issues')
      .set('Cookie', cookies.manager)
      .send({
        orderId,
        lines: [{ workshopNeedId, issuedQty: '1', unitCost: '10' }],
      })
      .expect(201);
    expect(res.body.source).toBe('MANUAL');

    const fromDb = await t.prisma.materialIssue.findUniqueOrThrow({
      where: { id: res.body.id },
    });
    expect(fromDb.source).toBe('MANUAL');
    expect(fromDb.sourceKey).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // 12. Audit MATERIAL_ISSUE_CREATED и MATERIAL_ISSUE_POSTED для auto
  // ---------------------------------------------------------------------------

  test('audit MATERIAL_ISSUE_CREATED и MATERIAL_ISSUE_POSTED записываются для авто-документа', async () => {
    const { passportId } = await prepareOrderAndPassport({
      qtyPlan: 10,
      qtyCut: 4,
      quotedPrice: '100',
      quotedCurrency: 'RUB',
    });
    await issue(passportId);

    const auto = await t.prisma.materialIssue.findFirstOrThrow({
      where: { passportId, source: 'AUTO_CUT_ISSUE' },
    });

    const created = await t.prisma.auditLog.findFirst({
      where: {
        event: 'MATERIAL_ISSUE_CREATED',
        entityType: 'MATERIAL_ISSUE',
        entityId: auto.id,
      },
    });
    expect(created).toBeTruthy();
    const createdPayload = created!.payload as {
      source: string;
      sourceKey: string | null;
      status: string;
      calculation?: { totalOrderQty: number; passportQtyCut: number; formula: string };
    };
    expect(createdPayload.source).toBe('AUTO_CUT_ISSUE');
    expect(createdPayload.sourceKey).toBe(`AUTO_CUT_ISSUE:${passportId}`);
    expect(createdPayload.status).toBe('POSTED');
    expect(createdPayload.calculation?.totalOrderQty).toBe(10);
    expect(createdPayload.calculation?.passportQtyCut).toBe(4);
    expect(createdPayload.calculation?.formula).toBe(
      'WorkshopNeed.calculatedQty * Passport.qtyCut / totalOrderQty',
    );

    const posted = await t.prisma.auditLog.findFirst({
      where: {
        event: 'MATERIAL_ISSUE_POSTED',
        entityType: 'MATERIAL_ISSUE',
        entityId: auto.id,
      },
    });
    expect(posted).toBeTruthy();
    const postedPayload = posted!.payload as { source: string; status: string };
    expect(postedPayload.source).toBe('AUTO_CUT_ISSUE');
    expect(postedPayload.status).toBe('POSTED');
  });

  // ---------------------------------------------------------------------------
  // 13. Auto issue НЕ создаёт записей StockBalance / StockMovement
  //     (эти модели в MVP отсутствуют вообще) — проверяем косвенно,
  //     что в БД нет соответствующих таблиц.
  // ---------------------------------------------------------------------------

  test('backend-итерация не создаёт таблиц StockBalance / StockMovement / MaterialStockLot', async () => {
    // На Prisma-клиенте этих моделей не должно быть в сгенерированном
    // типе. Проверка — через runtime `Object.prototype.hasOwnProperty`
    // по `t.prisma` (обычный клиент).
    const prismaAny = t.prisma as unknown as Record<string, unknown>;
    expect(prismaAny.stockBalance).toBeUndefined();
    expect(prismaAny.stockMovement).toBeUndefined();
    expect(prismaAny.materialStockLot).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // 14. Проверка формулы округления: issuedQty хранится с точностью 4.
  // ---------------------------------------------------------------------------

  test('issuedQty хранится с точностью Decimal(14,4) и пропорционален qtyCut/totalQty', async () => {
    // qtyPlan=7, qtyCut=3, calculatedQty=0.5*7=3.5
    // issuedQty = 3.5 * 3 / 7 = 1.5 (точно)
    const { passportId } = await prepareOrderAndPassport({
      qtyPlan: 7,
      qtyCut: 3,
      quotedPrice: '100',
      quotedCurrency: 'RUB',
    });
    await issue(passportId);
    const auto = await t.prisma.materialIssue.findFirstOrThrow({
      where: { passportId, source: 'AUTO_CUT_ISSUE' },
      include: { lines: true },
    });
    expect(auto.lines).toHaveLength(1);
    expect(new Prisma.Decimal(auto.lines[0]!.issuedQty).toString()).toBe('1.5');
    expect(new Prisma.Decimal(auto.lines[0]!.totalCost).toString()).toBe('150');
  });
});
