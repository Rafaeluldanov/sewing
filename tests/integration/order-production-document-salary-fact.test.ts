/**
 * Документ план→факт заказа: ФАКТ окладных операций (решение владельца
 * 14.09.2026).
 *
 * До этого у операций `pricingMode = SALARY_ONLY` (ОТК, ВТО, упаковка) в
 * документе был план, а факт — всегда 0: они не пишут `OperationEntry`.
 * Теперь факт = разнесённый оклад по факту выполненных работ — для
 * терминалов без accept это норма времени × объём × ставка сотрудника.
 *
 * Проверяем:
 *   1) ОТК прошёл паспорт на 10 шт при норме 36 сек/шт и ставке 600 ₽/ч →
 *      факт строки ОТК = 6 мин × 10 ₽/мин = 60 ₽, `factSalaryRub` = 60,
 *      `factQty` = 10, план (4800 ₽/смена ÷ 28 800 с × 36 с × 10) = 60 ₽;
 *   2) норма не задана → факт 0 и предупреждение `SALARY_NORM_MISSING`.
 */
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';

import { loginAs, startTestApp, stopTestApp, type TestApp } from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

type OpRow = {
  operationCode: string;
  planRub: string | null;
  factQty: number;
  factRub: string;
  factSalaryRub: string;
  factApprovedRub: string;
  breakdown: { sizeCode: string | null; factQty: string; factRub: string }[];
};
type DocBody = {
  operations: OpRow[];
  totals: { factOperationsRub: string };
  warnings: string[];
};

const AT = new Date('2026-06-10T09:00:00.000Z');

describeWithDb('integration — документ план→факт: факт окладных операций', () => {
  let t: TestApp;
  let seed: SeedResult;
  let manager: string;

  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await stopTestApp(t);
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    seed = await seedMinimal(t.prisma);
    manager = loginAs(t, seed.employees['shop-chief']);
    // ОТК — окладник 600 ₽/ч = 10 ₽/мин.
    await t.prisma.employee.update({
      where: { id: seed.employees.qc.id },
      data: { compensationType: 'SALARY', salaryPerHour: new Prisma.Decimal(600) },
    });
    // Плановая ставка окладной операции: 4800 ₽ за смену 28 800 с.
    await t.prisma.operation.update({
      where: { id: seed.operations.QC.id },
      data: {
        salaryPlanRubPerShift: new Prisma.Decimal(4800),
        salaryPlanShiftSeconds: 28800,
      },
    });
  });

  async function prepareOrder(): Promise<string> {
    const order = await t.prisma.order.create({
      data: {
        number: 'O-DOC-SAL',
        orderDate: AT,
        color: seed.product.color,
        status: 'IN_PRODUCTION',
        inProductionAt: AT,
        items: { create: { productId: seed.product.id, sizeId: seed.sizes.M, qtyPlan: 10 } },
        routeSteps: { create: { index: 0, operationId: seed.operations.QC.id } },
      },
    });
    const passport = await t.prisma.passport.create({
      data: {
        number: 'P-DOC-SAL',
        orderId: order.id,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: seed.product.color,
        rollNumber: 'R-1',
        cutDate: AT,
        qtyPlan: 10,
        qtyCut: 10,
        qtyGood: 10,
        qrCode: 'passport:P-DOC-SAL',
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
        status: 'IN_PROGRESS',
      },
    });
    // Так ОТК и отмечается в реальном флоу: только `QC_PASSED`, без accept.
    await t.prisma.passportEvent.create({
      data: {
        passportId: passport.id,
        type: 'QC_PASSED',
        operationId: seed.operations.QC.id,
        employeeId: seed.employees.qc.id,
        qty: 10,
        createdAt: AT,
      },
    });
    return order.id;
  }

  async function getDocument(orderId: string): Promise<DocBody> {
    const res = await request(t.app.getHttpServer())
      .get(`/api/admin/production-cost/order/${orderId}/document`)
      .set('Cookie', manager)
      .expect(200);
    return res.body as DocBody;
  }

  test('ОТК по норме × объём: факт строки = оклад, план сходится по той же норме', async () => {
    await t.prisma.operation.update({
      where: { id: seed.operations.QC.id },
      data: { timeNormMode: 'FIXED', timeNormSec: 36 },
    });
    const orderId = await prepareOrder();
    const doc = await getDocument(orderId);

    const qc = doc.operations.find((r) => r.operationCode === 'QC');
    expect(qc).toBeDefined();
    expect(qc!.planRub).toBe('60.00');
    expect(qc!.factQty).toBe(10);
    expect(qc!.factRub).toBe('60.00');
    expect(qc!.factSalaryRub).toBe('60.00');
    expect(qc!.factApprovedRub).toBe('60.00');
    expect(qc!.breakdown).toHaveLength(1);
    expect(qc!.breakdown[0].sizeCode).toBe('M');
    expect(qc!.breakdown[0].factQty).toBe('10');
    expect(qc!.breakdown[0].factRub).toBe('60.00');
    expect(Number(doc.totals.factOperationsRub)).toBeCloseTo(60, 2);
    expect(doc.warnings).not.toContain('SALARY_NORM_MISSING');
  });

  test('норма не задана: факт 0 и предупреждение SALARY_NORM_MISSING', async () => {
    const orderId = await prepareOrder();
    const doc = await getDocument(orderId);

    const qc = doc.operations.find((r) => r.operationCode === 'QC');
    expect(qc).toBeDefined();
    expect(qc!.factQty).toBe(0);
    expect(qc!.factRub).toBe('0.00');
    expect(qc!.factSalaryRub).toBe('0.00');
    expect(doc.warnings).toContain('SALARY_NORM_MISSING');
  });
});
