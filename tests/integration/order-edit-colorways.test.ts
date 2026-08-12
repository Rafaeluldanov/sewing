/**
 * Integration-тесты: редактирование расцветок заказа через
 * `PATCH /api/orders/:id` (`UpdateOrderDto.variants`).
 *
 * Контекст. Форма редактирования заказа (`/admin/orders/[id]/edit`) под
 * флагом FEATURE_COLORWAYS теперь шлёт карточки расцветок — тот же UX,
 * что форма создания и карточка заказа. Раньше edit-форма писала плоский
 * агрегат `OrderItem` напрямую, минуя `OrderVariant/OrderVariantSize`:
 * это была обратная (одно-направленному ресинку расцветка→агрегат)
 * запись, и правки либо затирались, либо расходились с карточками.
 *
 * Покрытие:
 *   1. PATCH с `variants` ПОЛНОСТЬЮ заменяет `OrderVariant` и через тот же
 *      `resyncColorwayDerived`, что и карточки, пересобирает агрегат
 *      `OrderItem = Σ по цветам` (в т.ч. новый размер). Старый код оставил
 *      бы агрегат устаревшим — это и есть починенная рассинхронизация.
 *   2. PATCH одной расцветкой — полная замена: прежние расцветки исчезают,
 *      агрегат следует за оставшейся.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';

import { loginAs, startTestApp, stopTestApp, type TestApp } from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';
import { copySpecLinesTo, createSpecPattern } from '../utils/spec';

describeWithDb('integration — редактирование расцветок заказа (PATCH variants)', () => {
  let t: TestApp;
  let seed: SeedResult;
  let manager: string;
  let patternItemId: string;

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
    const pattern = await t.prisma.patternItem.create({
      data: {
        name: 'Худи',
        article: `ART-${Date.now().toString(36)}`,
        status: 'ACTIVE',
      },
    });
    patternItemId = pattern.id;
  });

  /**
   * Простая спецификация с одной строкой полотна на лекале заказа
   * (справочника техкарт больше нет — состав даёт номенклатура).
   */
  async function seedMainFabricSpec(): Promise<void> {
    const spec = await createSpecPattern(t, manager, {
      name: 'Кулирка простая',
      materialLines: [
        {
          name: 'Полотно',
          unit: 'м2',
          qtyPerUnit: '0.42',
          materialRole: 'MAIN_FABRIC',
          fabricType: 'кулирка',
          colorRule: 'ORDER_COLOR',
        },
      ],
    });
    await copySpecLinesTo(t, spec.id, patternItemId);
  }

  /** Заказ с двумя расцветками (Белый 60 / Чёрный 40 по размеру M). */
  async function createOrderWithTwoColorways(): Promise<string> {
    const res = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', manager)
      .send({
        orderDate: '2026-07-15T00:00:00.000Z',
        patternItemId,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 100 }],
        variants: [
          {
            color: 'Белый',
            sizes: [{ sizeId: seed.sizes.M, qtyPlan: 60 }],
          },
          {
            color: 'Чёрный',
            sizes: [{ sizeId: seed.sizes.M, qtyPlan: 40 }],
          },
        ],
      })
      .expect(201);
    return res.body.id as string;
  }

  /** Агрегат заказа как карта `sizeId → Σ qtyPlan`. */
  async function aggregate(orderId: string): Promise<Record<string, number>> {
    const items = await t.prisma.orderItem.findMany({ where: { orderId } });
    const map: Record<string, number> = {};
    for (const it of items) map[it.sizeId] = (map[it.sizeId] ?? 0) + it.qtyPlan;
    return map;
  }

  test('PATCH variants заменяет расцветки и пересобирает агрегат OrderItem', async () => {
    await seedMainFabricSpec();
    const orderId = await createOrderWithTwoColorways();

    // Исходно: 2 расцветки, агрегат M = 100.
    expect(await t.prisma.orderVariant.count({ where: { orderId } })).toBe(2);
    expect(await aggregate(orderId)).toEqual({ [seed.sizes.M]: 100 });

    // Правим расцветки: Белый {M:70, L:20}, Чёрный {M:30}. Добавляем размер L.
    await request(t.app.getHttpServer())
      .patch(`/api/orders/${orderId}`)
      .set('Cookie', manager)
      .send({
        variants: [
          {
            color: 'Белый',
            sizes: [
              { sizeId: seed.sizes.M, qtyPlan: 70 },
              { sizeId: seed.sizes.L, qtyPlan: 20 },
            ],
          },
          {
            color: 'Чёрный',
            sizes: [{ sizeId: seed.sizes.M, qtyPlan: 30 }],
          },
        ],
      })
      .expect(200);

    // Расцветки заменены (не задвоены).
    const variants = await t.prisma.orderVariant.findMany({
      where: { orderId },
      include: { sizes: true },
    });
    expect(variants).toHaveLength(2);
    const white = variants.find((v) => v.color === 'Белый')!;
    const black = variants.find((v) => v.color === 'Чёрный')!;
    const whiteSizes = Object.fromEntries(
      white.sizes.map((s) => [s.sizeId, s.qtyPlan]),
    );
    const blackSizes = Object.fromEntries(
      black.sizes.map((s) => [s.sizeId, s.qtyPlan]),
    );
    expect(whiteSizes).toEqual({ [seed.sizes.M]: 70, [seed.sizes.L]: 20 });
    expect(blackSizes).toEqual({ [seed.sizes.M]: 30 });

    // ГЛАВНОЕ: агрегат OrderItem пересобран = Σ по цветам, включая новый
    // размер L. Старый код оставил бы агрегат устаревшим (M:100, без L).
    expect(await aggregate(orderId)).toEqual({
      [seed.sizes.M]: 100,
      [seed.sizes.L]: 20,
    });
  });

  test('PATCH одной расцветкой полностью заменяет прежние, агрегат следует', async () => {
    await seedMainFabricSpec();
    const orderId = await createOrderWithTwoColorways();

    await request(t.app.getHttpServer())
      .patch(`/api/orders/${orderId}`)
      .set('Cookie', manager)
      .send({
        variants: [
          {
            color: 'Белый',
            sizes: [{ sizeId: seed.sizes.M, qtyPlan: 50 }],
          },
        ],
      })
      .expect(200);

    expect(await t.prisma.orderVariant.count({ where: { orderId } })).toBe(1);
    const only = await t.prisma.orderVariant.findFirstOrThrow({
      where: { orderId },
    });
    expect(only.color).toBe('Белый');
    expect(await aggregate(orderId)).toEqual({ [seed.sizes.M]: 50 });
  });
});
