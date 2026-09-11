/**
 * Integration-тесты режима ДОБОРА потребности (`appendMissing`,
 * см. `WorkshopNeedsService.calculateForOrder`).
 *
 * Повод — прод-инцидент 11.09.2026 (заказ ФС-000003 «Анорак Basic»): в
 * спецификацию уже работающего заказа дописали два материала («Печать лекал»,
 * «Наклейки на зип-пакеты»), и они не дошли до закупки ВООБЩЕ. Обычный
 * пересчёт устроен «всё или ничего»: без `force` он спотыкается о любую
 * тронутую закупщиком строку, с `force` — о строки под заказом поставщику ERP.
 * То есть с момента создания первого ЗП новая позиция спецификации не могла
 * попасть в потребность уже никогда.
 *
 * Что проверяем:
 *   1. добор создаёт только НЕДОСТАЮЩИЕ строки, существующие не трогает —
 *      ни статус, ни `purchaseQty`, ни id;
 *   2. добор проходит там, где полный пересчёт законно отказывается: строка
 *      под заказом поставщику ERP (`erpManagedAt`);
 *   3. повторный добор ничего не задваивает;
 *   4. сквозной путь: материал, ДОПИСАННЫЙ В СПЕЦИФИКАЦИЮ заказа, доезжает до
 *      потребности сам, а отметка «потребность устарела» остаётся с честной
 *      причиной (нормы старых строк так и не пересчитаны).
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
import { createSpecPattern } from '../utils/spec';

describeWithDb('integration — workshop needs append missing', () => {
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
  });

  /** Заказ на карточке спецификации с одной строкой материала + расчёт. */
  async function orderWithCalculatedNeeds(article: string): Promise<{
    orderId: string;
    needId: string;
  }> {
    const pattern = await createSpecPattern(t, manager, {
      name: `Лекало ${article}`,
      article,
      materialLines: [{ name: 'Нитки', unit: 'м', qtyPerUnit: '1.5' }],
    });
    const created = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', manager)
      .send({
        orderDate: '2026-09-11T00:00:00.000Z',
        clientId: seed.client.id,
        productId: seed.product.id,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 10 }],
        patternItemId: pattern.id,
      })
      .expect(201);
    const orderId = created.body.id as string;
    // Потребность считают на этапе расчёта — туда же смотрит авто-пересчёт
    // после правки спецификации.
    await t.prisma.order.update({
      where: { id: orderId },
      data: { status: 'CALCULATION' },
    });
    const calc = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', manager)
      .send({})
      .expect(201);
    expect(calc.body.count).toBe(1);
    return { orderId, needId: calc.body.needs[0].id as string };
  }

  test('добор создаёт только новые строки, работу закупщика не трогает', async () => {
    const { orderId, needId } = await orderWithCalculatedNeeds('P-APP-1');

    // Закупщик забрал строку в работу — полный пересчёт с этого момента
    // отказывается (409 ALREADY_REVIEWED), и это правильно.
    await request(t.app.getHttpServer())
      .patch(`/api/workshop-needs/${needId}`)
      .set('Cookie', manager)
      .send({ status: 'REVIEWED', purchaseQty: '7.5' })
      .expect(200);
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', manager)
      .send({})
      .expect(409);

    // Материал дописали в спецификацию заказа.
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/tech-card/lines`)
      .set('Cookie', manager)
      .send({ name: 'Печать лекал', unit: 'шт', qtyPerUnit: '1' })
      .expect(201);
    // Правка спецификации сама зовёт добор (это отдельный тест ниже), поэтому
    // здесь возвращаем заказ в состояние «материал в спецификации есть, в
    // потребности его нет» — ровно то, в котором ФС-000003 застрял на проде, —
    // и проверяем саму ручку.
    await t.prisma.workshopNeed.deleteMany({
      where: { orderId, description: { contains: 'Печать лекал' } },
    });

    const appended = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', manager)
      .send({ appendMissing: true })
      .expect(201);
    expect(appended.body.appendMissing).toBe(true);
    expect(appended.body.count).toBe(1);

    const rows = await t.prisma.workshopNeed.findMany({
      where: { orderId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        description: true,
        status: true,
        purchaseQty: true,
        calculatedQty: true,
      },
    });
    expect(rows).toHaveLength(2);
    // Старая строка — та же самая: id, статус и число закупщика на месте.
    expect(rows[0].id).toBe(needId);
    expect(rows[0].status).toBe('REVIEWED');
    expect(Number(rows[0].purchaseQty)).toBeCloseTo(7.5, 4);
    // Новая — из дописанного материала, 1 шт × 10 изделий.
    expect(rows[1].description).toContain('Печать лекал');
    expect(rows[1].status).toBe('CALCULATED');
    expect(Number(rows[1].calculatedQty)).toBeCloseTo(10, 4);
  });

  test('добор проходит там, где полный пересчёт отбивается строкой под заказом ERP', async () => {
    const { orderId, needId } = await orderWithCalculatedNeeds('P-APP-2');
    // Строка ушла в заказ поставщику ERP — её пересоздавать нельзя ничем.
    await t.prisma.workshopNeed.update({
      where: { id: needId },
      data: {
        status: 'PURCHASE_PLANNED',
        erpManagedAt: new Date(),
        erpPurchaseOrderRef: 'ФС-000086',
      },
    });
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/tech-card/lines`)
      .set('Cookie', manager)
      .send({ name: 'Наклейки на зип-пакеты', unit: 'шт', qtyPerUnit: '1' })
      .expect(201);
    await t.prisma.workshopNeed.deleteMany({
      where: { orderId, description: { contains: 'Наклейки' } },
    });

    // Полный пересчёт — отказ даже с force: связь ERP повисла бы на удалённом id.
    const forced = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', manager)
      .send({ force: true })
      .expect(409);
    expect(String(forced.body.message)).toMatch(/ERP/u);

    const appended = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', manager)
      .send({ appendMissing: true })
      .expect(201);
    expect(appended.body.count).toBe(1);

    const underErp = await t.prisma.workshopNeed.findUnique({
      where: { id: needId },
      select: { erpManagedAt: true, erpPurchaseOrderRef: true, status: true },
    });
    expect(underErp?.erpManagedAt).not.toBeNull();
    expect(underErp?.erpPurchaseOrderRef).toBe('ФС-000086');
    expect(underErp?.status).toBe('PURCHASE_PLANNED');
  });

  test('повторный добор ничего не задваивает', async () => {
    const { orderId } = await orderWithCalculatedNeeds('P-APP-3');
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/tech-card/lines`)
      .set('Cookie', manager)
      .send({ name: 'Бирка', unit: 'шт', qtyPerUnit: '1' })
      .expect(201);

    const first = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', manager)
      .send({ appendMissing: true })
      .expect(201);
    const second = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', manager)
      .send({ appendMissing: true })
      .expect(201);
    expect(second.body.count).toBe(0);

    const rows = await t.prisma.workshopNeed.findMany({
      where: { orderId },
      select: { description: true },
    });
    // Сколько было после первого добора, столько и осталось.
    expect(rows).toHaveLength(first.body.needs.length);
    expect(rows.filter((r) => r.description.includes('Бирка'))).toHaveLength(1);
  });

  test('дописанный в спецификацию материал доезжает до потребности САМ', async () => {
    const { orderId, needId } = await orderWithCalculatedNeeds('P-APP-4');
    await request(t.app.getHttpServer())
      .patch(`/api/workshop-needs/${needId}`)
      .set('Cookie', manager)
      .send({ status: 'REVIEWED', purchaseQty: '7.5' })
      .expect(200);

    // Никакого явного пересчёта — только правка спецификации, как её делает
    // менеджер цеха или окно «Материалы» в ERP.
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/tech-card/lines`)
      .set('Cookie', manager)
      .send({ name: 'Печать лекал', unit: 'шт', qtyPerUnit: '1' })
      .expect(201);

    const rows = await t.prisma.workshopNeed.findMany({
      where: { orderId },
      select: { description: true, status: true },
    });
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.description.includes('Печать лекал'))).toBe(true);
    // Строка закупщика цела.
    expect(rows.some((r) => r.status === 'REVIEWED')).toBe(true);

    // Отметка «устарела» остаётся: нормы СТАРЫХ строк добор не пересчитывал,
    // и причина этого не исчезла. Но в ней теперь видно, что новое дописано.
    const order = await t.prisma.order.findUnique({
      where: { id: orderId },
      select: { needsStaleAt: true, needsStaleReason: true },
    });
    expect(order?.needsStaleAt).not.toBeNull();
    expect(order?.needsStaleReason).toMatch(/дописан/iu);
  });
});
