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
 *      причиной (нормы старых строк так и не пересчитаны);
 *   5. аудит движка расчёта 13.09.2026, N2-11: погашенная закупщиком строка
 *      (`CANCELLED`) с тем же описанием не считается «уже существующей» —
 *      материал, вернувшийся в спецификацию с новым id строки снимка,
 *      доезжает до закупки заново;
 *   6. аудит движка расчёта 13.09.2026, N1-7/N2-3: схлопнутая order-level
 *      строка «материала без цвета» узнаёт живые строки по расцветкам,
 *      посчитанные до правила схлопывания (da74850), — третья, суммарная
 *      строка не дописывается (иначе 30 + 20 + 50 = 100 м при норме 50).
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
import { copySpecLinesTo, createSpecPattern } from '../utils/spec';

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

  test('N2-11: погашенная строка с тем же описанием не мешает добору вернувшегося материала', async () => {
    const pattern = await createSpecPattern(t, manager, {
      name: 'Лекало P-APP-5',
      article: 'P-APP-5',
      materialLines: [
        { name: 'Нитки', unit: 'м', qtyPerUnit: '1' },
        { name: 'Резинка', unit: 'м', qtyPerUnit: '0.5' },
      ],
    });
    const created = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', manager)
      .send({
        orderDate: '2026-09-13T00:00:00.000Z',
        clientId: seed.client.id,
        productId: seed.product.id,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 100 }],
        patternItemId: pattern.id,
      })
      .expect(201);
    const orderId = created.body.id as string;
    await t.prisma.order.update({ where: { id: orderId }, data: { status: 'CALCULATION' } });
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', manager)
      .send({})
      .expect(201);
    const needs = await t.prisma.workshopNeed.findMany({ where: { orderId } });
    expect(needs).toHaveLength(2);
    const threads = needs.find((n) => n.description.startsWith('Нитки'))!;
    const elastic = needs.find((n) => n.description.startsWith('Резинка'))!;

    // Закупщик работает по ниткам (полный пересчёт закрыт) и гасит резинку.
    await request(t.app.getHttpServer())
      .patch(`/api/workshop-needs/${threads.id}`)
      .set('Cookie', manager)
      .send({ status: 'REVIEWED' })
      .expect(200);
    await request(t.app.getHttpServer())
      .post(`/api/workshop-needs/${elastic.id}/cancel`)
      .set('Cookie', manager)
      .send({})
      .expect(201);

    // «Резинку» вернули в спецификацию: строка снимка рождается с НОВЫМ id.
    const snapElastic = await t.prisma.orderMaterialRequirement.findFirstOrThrow({
      where: { orderId, name: 'Резинка' },
    });
    const { id: _oldId, createdAt: _c, updatedAt: _u, ...rest } = snapElastic;
    await t.prisma.orderMaterialRequirement.delete({ where: { id: snapElastic.id } });
    const recreated = await t.prisma.orderMaterialRequirement.create({
      data: {
        ...rest,
        characteristics: rest.characteristics ?? undefined,
        parameterBindings: rest.parameterBindings ?? undefined,
      } as never,
    });
    expect(recreated.id).not.toBe(snapElastic.id);

    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', manager)
      .send({})
      .expect(409);
    const append = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', manager)
      .send({ appendMissing: true })
      .expect(201);
    expect(append.body.count).toBe(1);

    const live = await t.prisma.workshopNeed.findMany({
      where: { orderId, NOT: { status: 'CANCELLED' } },
    });
    const liveElastic = live.filter((n) => n.description.startsWith('Резинка'));
    expect(liveElastic).toHaveLength(1);
    expect(liveElastic[0]!.sourceId).toBe(recreated.id);
    expect(Number(liveElastic[0]!.calculatedQty)).toBeCloseTo(50, 4);
    // Погашенная строка остаётся погашенной, нитки закупщика не тронуты.
    const cancelled = await t.prisma.workshopNeed.findMany({ where: { orderId, status: 'CANCELLED' } });
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]!.id).toBe(elastic.id);
    expect(live.find((n) => n.id === threads.id)?.status).toBe('REVIEWED');
  });

  test('N1-7/N2-3: схлопнутая строка без цвета не дописывается поверх строк по расцветкам', async () => {
    const pattern = await request(t.app.getHttpServer())
      .post('/api/patterns')
      .set('Cookie', manager)
      .send({ name: 'Футболка P-APP-6', article: 'P-APP-6' })
      .expect(201);
    const patternItemId = pattern.body.id as string;
    const spec = await createSpecPattern(t, manager, {
      article: 'P-APP-6-SPEC',
      materialLines: [
        { name: 'Кулирка', unit: 'м пог.', qtyPerUnit: '1', materialRole: 'MAIN_FABRIC', fabricType: 'Кулирка', colorRule: 'ORDER_COLOR' },
        { name: 'Дублерин', unit: 'м пог.', qtyPerUnit: '0.5', materialRole: 'LINING', fabricType: 'Дублерин', colorRule: 'NO_COLOR' },
      ],
    });
    await copySpecLinesTo(t, spec.id, patternItemId);
    const created = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', manager)
      .send({
        orderDate: '2026-09-13T00:00:00.000Z',
        productId: seed.product.id,
        clientId: seed.client.id,
        patternItemId,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 100 }],
        variants: [
          { color: 'Белый', sizes: [{ sizeId: seed.sizes.M, qtyPlan: 60 }] },
          { color: 'Чёрный', sizes: [{ sizeId: seed.sizes.M, qtyPlan: 40 }] },
        ],
      })
      .expect(201);
    const orderId = created.body.id as string;
    await t.prisma.order.update({ where: { id: orderId }, data: { status: 'CALCULATION' } });
    const calc = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', manager)
      .send({})
      .expect(201);
    const lining = (calc.body.needs as Array<{ id: string; sourceName: string | null; orderVariantId: string | null; calculatedQty: string }>)
      .filter((x) => x.sourceName === 'Дублерин');
    expect(lining).toHaveLength(1);
    expect(lining[0]!.orderVariantId).toBeNull();
    expect(Number(lining[0]!.calculatedQty)).toBeCloseTo(50, 4);

    // Заказ, посчитанный ДО da74850: две строки дублерина по расцветкам (30 + 20).
    const row = await t.prisma.workshopNeed.findUniqueOrThrow({ where: { id: lining[0]!.id } });
    const specRows = await t.prisma.orderMaterialRequirement.findMany({
      where: { orderId, materialRole: 'LINING' },
      include: { orderVariant: true },
      orderBy: { orderVariant: { ordinal: 'asc' } },
    });
    expect(specRows).toHaveLength(2);
    const { id: _id, createdAt: _c, updatedAt: _u, calculationNote: _n, ...base } = row;
    await t.prisma.workshopNeed.delete({ where: { id: row.id } });
    const legacyIds: string[] = [];
    for (const sp of specRows) {
      const legacy = await t.prisma.workshopNeed.create({
        data: {
          ...base,
          calculationNote: null,
          sourceId: sp.id,
          orderVariantId: sp.orderVariantId,
          variantColor: sp.variantColor,
          calculatedQty: sp.totalQty,
        },
      });
      legacyIds.push(legacy.id);
    }
    // Закупщик тронул строку белого → полный пересчёт запрещён, работает добор.
    await request(t.app.getHttpServer())
      .patch(`/api/workshop-needs/${legacyIds[0]}`)
      .set('Cookie', manager)
      .send({ status: 'REVIEWED', purchaseQty: '30', quotedPrice: '120', quotedCurrency: 'RUB' })
      .expect(200);
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', manager)
      .send({})
      .expect(409);

    const liningRows = () =>
      t.prisma.workshopNeed.findMany({
        where: { orderId, materialRole: 'LINING' },
        select: { id: true, orderVariantId: true, calculatedQty: true },
      });

    // Явный добор: дублерин уже есть (по расцветкам) — ничего не дописывает.
    const appended = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', manager)
      .send({ appendMissing: true })
      .expect(201);
    expect(appended.body.count).toBe(0);
    let rows = await liningRows();
    expect(rows.map((r) => r.id).sort()).toEqual([...legacyIds].sort());
    expect(rows.reduce((s, r) => s + Number(r.calculatedQty), 0)).toBeCloseTo(50, 4);

    // Авто-путь: правка спецификации при тронутой строке → 409 → добор.
    // Дописывается только новая «Бирка», дублерин не задваивается.
    const variants = await t.prisma.orderVariant.findMany({ where: { orderId }, orderBy: { ordinal: 'asc' } });
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/tech-card/lines`)
      .set('Cookie', manager)
      .send({ orderVariantId: variants[0]!.id, name: 'Бирка', unit: 'шт', qtyPerUnit: '1', materialRole: 'LABEL' })
      .expect(201);
    rows = await liningRows();
    expect(rows).toHaveLength(2);
    expect(rows.reduce((s, r) => s + Number(r.calculatedQty), 0)).toBeCloseTo(50, 4);
    const all = await t.prisma.workshopNeed.findMany({ where: { orderId }, select: { description: true } });
    expect(all.filter((r) => r.description.includes('Бирка'))).toHaveLength(1);
    const order = await t.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { needsStaleAt: true, needsStaleReason: true },
    });
    expect(order.needsStaleAt).not.toBeNull();
    expect(order.needsStaleReason ?? '').toMatch(/дописан/u);
  });
});
