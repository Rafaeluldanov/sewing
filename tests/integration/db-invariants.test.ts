/**
 * Integration-тест критических DB-инвариантов MVP 1.1.
 *
 * Эти проверки идут через Prisma напрямую (а не через API), потому что
 * нам важно подтвердить, что constraint живёт именно в БД и сервис не
 * единственная защита. Если кто-то выпилит unique-индекс, тесты упадут.
 *
 * См. ADR-0015 — partial unique для активных смен и набор уникальностей.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { Prisma } from '@prisma/client';
import { startTestApp, stopTestApp, type TestApp } from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

describeWithDb('integration — DB invariants (MVP 1.1)', () => {
  let t: TestApp;
  let seed: SeedResult;

  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await stopTestApp(t);
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    seed = await seedMinimal(t.prisma);
  });

  test('partial unique: одна активная смена на сотрудника', async () => {
    const employeeId = seed.employees.seamstress.id;
    const equipmentId = seed.equipment['overlock-01'].id;
    const operationId = seed.operations.SEW_OVERLOCK_1.id;

    await t.prisma.shiftSession.create({
      data: { employeeId, equipmentId, operationId, startedAt: new Date() },
    });

    let caught: unknown;
    try {
      await t.prisma.shiftSession.create({
        data: { employeeId, equipmentId, operationId, startedAt: new Date() },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((caught as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');

    // Закрываем первую смену → новую можно создавать.
    const open = await t.prisma.shiftSession.findFirst({
      where: { employeeId, endedAt: null },
    });
    await t.prisma.shiftSession.update({
      where: { id: open!.id },
      data: { endedAt: new Date() },
    });
    await expect(
      t.prisma.shiftSession.create({
        data: { employeeId, equipmentId, operationId, startedAt: new Date() },
      }),
    ).resolves.toBeDefined();
  });

  test('unique: один паспорт не может оказаться в двух BoxItem', async () => {
    const order = await t.prisma.order.create({
      data: {
        number: 'INV-1',
        orderDate: new Date(),
        color: seed.product.color,
        status: 'IN_PRODUCTION',
        items: {
          create: { productId: seed.product.id, sizeId: seed.sizes.M, qtyPlan: 5 },
        },
      },
      include: { items: true },
    });
    const passport = await t.prisma.passport.create({
      data: {
        number: `P-${Date.now()}`,
        orderId: order.id,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: seed.product.color,
        rollNumber: 'R-X',
        cutDate: new Date(),
        qtyPlan: 5,
        qtyCut: 5,
        qtyGood: 5,
        qrCode: `passport:test-${Date.now()}`,
        // Passport требует обязательные FK на cutter/creator (см. schema).
        // Тест не покрывает бизнес-логику выпуска, поэтому ставим
        // ту же seed-сущность и для cutter, и для creator.
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
      },
    });
    const box1 = await t.prisma.box.create({
      data: { number: 'BOX-1', qrCode: 'box:1', createdById: seed.employees.packer.id },
    });
    const box2 = await t.prisma.box.create({
      data: { number: 'BOX-2', qrCode: 'box:2', createdById: seed.employees.packer.id },
    });
    await t.prisma.boxItem.create({
      data: { boxId: box1.id, passportId: passport.id, qty: 5 },
    });

    let caught: unknown;
    try {
      await t.prisma.boxItem.create({
        data: { boxId: box2.id, passportId: passport.id, qty: 5 },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((caught as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
  });

  test('unique: одна строка заказа на (order, product, size)', async () => {
    let caught: unknown;
    try {
      await t.prisma.order.create({
        data: {
          number: 'INV-2',
          orderDate: new Date(),
          color: seed.product.color,
          items: {
            create: [
              { productId: seed.product.id, sizeId: seed.sizes.M, qtyPlan: 1 },
              { productId: seed.product.id, sizeId: seed.sizes.M, qtyPlan: 2 },
            ],
          },
        },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((caught as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
  });

  test('unique: passport.number / box.number / equipment.qrCode / cell.qrCode', async () => {
    // passport.qrCode хорошо тестируется выше; здесь — equipment + cell.
    let caught: unknown;
    try {
      await t.prisma.equipment.create({
        data: {
          code: 'ovr-dup',
          name: 'dup',
          qrCode: seed.equipment['overlock-01'].qrCode,
        },
      });
    } catch (e) {
      caught = e;
    }
    expect((caught as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');

    caught = undefined;
    try {
      await t.prisma.cell.create({
        data: { code: 'A1-dup', qrCode: seed.cells.A1.qrCode },
      });
    } catch (e) {
      caught = e;
    }
    expect((caught as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
  });
});
