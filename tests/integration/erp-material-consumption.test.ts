/**
 * Лестница остатков, шаги 5–6: материал под ERP цех у себя не списывает, а его расход
 * приезжает фактом из ERP и попадает в себестоимость цеха.
 *
 * Правило владельца §0.3 (`service/docs/kb/sewing.md`): материал списывается ПРИ ВЫПУСКЕ и на
 * складе ERP — с конкретного рулона и по цене его партии. Отсюда три проверки:
 *
 *   1. очередь `GET /api/integrations/erp-consumption` отдаёт упакованный паспорт со строкой
 *      потребности под ERP, посчитанной той же формулой, что автосписание кроя;
 *   2. автосписание при выдаче кроя строк под ERP НЕ создаёт (иначе расход задвоится), и
 *      ручной документ расхода по такой потребности отбивается 409;
 *   3. факт ERP (`PUT /api/integrations/erp-consumption`) входит в себестоимость паспорта и в
 *      план→факт заказа как «списано».
 */
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';

import { loginAs, startTestApp, stopTestApp, type TestApp } from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';
import { createSpecPattern } from '../utils/spec';
import { ErpConsumptionService } from '../../apps/api/src/modules/integrations/erp-consumption.service.js';

describeWithDb('integration — материал под ERP: списание при выпуске и факт в себестоимости', () => {
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
    // Автосписание кроя ВКЛ: только с ним видно, что строк под ERP оно не создаёт.
    await t.prisma.companySettings.upsert({
      where: { id: 'default' },
      create: { id: 'default', singleton: true, autoIssueMaterialsOnCutRelease: true },
      update: { autoIssueMaterialsOnCutRelease: true },
    });
  });

  /** Заказ с одной потребностью, паспорт на 4 шт из 10 плановых, потребность переведена «под ERP». */
  async function prepare(): Promise<{
    orderId: string;
    passportId: string;
    workshopNeedId: string;
  }> {
    const spec = await createSpecPattern(t, cookies.manager, {
      materialLines: [
        {
          name: 'Кулирка чёрная',
          unit: 'кг',
          qtyPerUnit: '0.5',
          materialRole: 'MAIN_FABRIC',
          colorRule: 'ORDER_COLOR',
        },
      ],
    });
    const order = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookies.manager)
      .send({
        orderDate: '2026-04-15T00:00:00.000Z',
        productId: seed.product.id,
        color: 'Чёрный',
        items: [{ sizeId: seed.sizes.M, qtyPlan: 10 }],
        patternItemId: spec.id,
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
    // «Под ERP» — как это делает закупочный шов: номенклатура, единица и цена её заказа.
    await t.prisma.workshopNeed.update({
      where: { id: need.id },
      data: {
        erpManagedAt: new Date('2026-04-14T00:00:00.000Z'),
        erpPurchaseOrderRef: 'УР-000001',
        erpNomenclatureId: '11111111-1111-4111-8111-111111111111',
        erpUnitId: '22222222-2222-4222-8222-222222222222',
        erpUnitPriceRub: new Prisma.Decimal('300'),
        quotedPrice: new Prisma.Decimal('100'),
        quotedCurrency: 'RUB',
      },
    });
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
        rollNumber: 'R-ERP-1',
        cutDate: '2026-04-15T00:00:00.000Z',
        qtyCut: 4,
        cutterId: seed.employees.cutter.id,
      })
      .expect(201);
    return { orderId, passportId: passport.body.id, workshopNeedId: need.id };
  }

  /** Упаковать паспорт «как цех»: статус + событие PACKED (очередь смотрит именно на них). */
  async function pack(passportId: string): Promise<void> {
    await t.prisma.passport.update({
      where: { id: passportId },
      data: {
        status: 'PACKED',
        erpSeriesId: '33333333-3333-4333-8333-333333333333',
        erpRollLabel: 'Рулон TEST-1',
      },
    });
    await t.prisma.passportEvent.create({
      data: { passportId, type: 'PACKED', qty: 4 },
    });
  }

  test('автосписание кроя не создаёт строк по материалу под ERP', async () => {
    const { passportId, workshopNeedId } = await prepare();
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
    const lines = await t.prisma.materialIssueLine.findMany({
      where: { workshopNeedId },
    });
    expect(lines).toHaveLength(0);
  });

  test('ручной документ расхода по материалу под ERP отбивается', async () => {
    const { orderId, workshopNeedId } = await prepare();
    const res = await request(t.app.getHttpServer())
      .post('/api/material-issues')
      .set('Cookie', cookies.manager)
      .send({
        orderId,
        lines: [{ workshopNeedId, issuedQty: '1', unitCost: '100' }],
      });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('MATERIAL_ISSUE_WORKSHOP_NEED_MANAGED_BY_ERP');
  });

  test('очередь отдаёт упакованный паспорт с долей потребности и рулоном', async () => {
    const { passportId, workshopNeedId } = await prepare();
    await pack(passportId);
    // Сервис зовём напрямую: ручка машинная (@MachineScopes), а машинного токена в тестовом
    // приложении нет — проверяем контракт очереди, а не авторизацию.
    const queue = await new ErpConsumptionService(t.prisma).listPending(10);
    expect(queue.count).toBe(1);
    const item = queue.items[0] as Record<string, any>;
    expect(item.passport_id).toBe(passportId);
    expect(item.erp_roll_label).toBe('Рулон TEST-1');
    // calculatedQty 5 кг × qtyCut 4 / плановые 10 = 2 кг.
    expect(item.lines).toHaveLength(1);
    expect(item.lines[0].workshop_need_id).toBe(workshopNeedId);
    expect(String(item.lines[0].qty)).toBe('2');
    expect(String(item.lines[0].erp_unit_price_rub)).toBe('300');
  });

  test('факт ERP входит в себестоимость паспорта и в план→факт заказа', async () => {
    const { orderId, passportId, workshopNeedId } = await prepare();
    await pack(passportId);
    // Ответ ERP: списала 2 кг на 640 ₽ (цена партии рулона, а не план закупщика).
    await t.prisma.erpMaterialConsumption.create({
      data: {
        passportId,
        orderId,
        state: 'POSTED',
        erpDocumentRef: 'TEST-1',
        amountRub: new Prisma.Decimal('640'),
        writtenOffAt: new Date('2026-04-16T00:00:00.000Z'),
        lines: {
          create: [
            {
              workshopNeedId,
              description: 'Кулирка чёрная',
              unit: 'кг',
              qty: new Prisma.Decimal('2'),
              amountRub: new Prisma.Decimal('640'),
              erpSeriesId: '33333333-3333-4333-8333-333333333333',
              rollLabel: 'Рулон TEST-1',
            },
          ],
        },
      },
    });

    const cost = await request(t.app.getHttpServer())
      .get(`/api/costs/passport/${passportId}`)
      .set('Cookie', cookies.manager)
      .expect(200);
    expect(Number(cost.body.materialCost ?? cost.body.materialCostRub)).toBe(640);

    const doc = await request(t.app.getHttpServer())
      .get(`/api/admin/production-cost/order/${orderId}/document`)
      .set('Cookie', cookies.manager)
      .expect(200);
    const row = (doc.body.materials as Array<Record<string, any>>).find(
      (m) => m.workshopNeedId === workshopNeedId || m.key === workshopNeedId,
    );
    expect(row).toBeTruthy();
    expect(Number(row!.issuedQty)).toBe(2);
    expect(Number(row!.issuedRub)).toBe(640);
    // План — по цене ERP: 5 кг × 300 ₽.
    expect(Number(row!.planRub)).toBe(1500);
  });
});
