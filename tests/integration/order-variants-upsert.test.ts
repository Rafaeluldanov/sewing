/**
 * Integration-тесты: полная картина расцветок (`PATCH /api/orders/:id`
 * с `variants` из edit-формы и `PATCH /api/integrations/erp-orders/:id/plan`
 * «дослать» из ERP) НЕ пересоздаёт `OrderVariant` — расцветки
 * сопоставляются по цвету, id живут, меняется только поразмерный план
 * (`OrdersService.upsertOrderVariants`).
 *
 * Аудит движка расчёта 13.09.2026:
 *   - G9-1 — раньше `deleteMany` + create давал новые id, и каскады БД
 *     стирали значения слот-параметров расцветок, отвязывали строки снимка;
 *     пересборка материализовала группы заново (ORDER-норма 0.35 → 0.30,
 *     плотность 220 → 180), ручные строки всех расцветок съезжали на
 *     расцветку №0 и считались по её тиражу (80 м Чёрного → 140 м Белого).
 *   - G6-1 — при тронутой строке потребности (ORDERED под ЗП ERP /
 *     REVIEWED закупщика) полный пересчёт законно отбит, а добор не узнавал
 *     старые строки (orderVariantId = null после SetNull) по новым id
 *     расцветок и дописывал полный комплект строк по расцветкам заново:
 *     Кулирка 18 + 12 + 21 + 12 = 63 кг вместо 30, доля паспорта 40 кг
 *     вместо 18, каждый повтор PATCH — ещё +33 кг.
 *
 * Сетапы взяты из проб `tests/scratch/calc_G/G9-1.test.ts` и `G6-1.test.ts`;
 * ассерты здесь закрепляют ПРАВИЛЬНОЕ поведение.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { refreshAdminCookie, startTestApp, stopTestApp, type TestApp } from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';
import { createSpecPattern } from '../utils/spec';
import { resolvePassportNeedShares } from '../../apps/api/src/modules/material-issues/passport-need-share.js';

describeWithDb('integration — расцветки заказа: upsert вместо пересоздания (G9-1, G6-1)', () => {
  let t: TestApp;
  let seed: SeedResult;
  let erpToken: string;

  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await stopTestApp(t);
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    seed = await seedMinimal(t.prisma);
    await refreshAdminCookie(t);
    // Машинный токен ERP — как в erp-order-guards.test.ts.
    erpToken = 'sew_test_upsert_token';
    await t.prisma.serviceToken.create({
      data: {
        name: 'ERP (тест upsert расцветок)',
        tokenHash: createHash('sha256').update(erpToken, 'utf8').digest('hex'),
        tokenPrefix: erpToken.slice(0, 10),
        roles: ['SHOP_MANAGER'],
        scopes: ['orders:read', 'orders:write', 'needs:read', 'needs:write'],
      },
    });
  });

  const http = () => request(t.app.getHttpServer());

  async function variantsOf(orderId: string) {
    const vs = await t.prisma.orderVariant.findMany({
      where: { orderId },
      include: { sizes: true },
      orderBy: { ordinal: 'asc' },
    });
    return {
      vs,
      byColor: new Map(vs.map((v) => [v.color, v] as const)),
    };
  }

  const snapshot = (orderId: string) =>
    t.prisma.orderMaterialRequirement.findMany({
      where: { orderId },
      select: {
        id: true,
        name: true,
        isManual: true,
        orderVariantId: true,
        variantColor: true,
        qtyPerUnit: true,
        totalQty: true,
        qtySource: true,
        densityGsm: true,
      },
    });

  const needs = (orderId: string) =>
    t.prisma.workshopNeed.findMany({
      where: { orderId },
      select: {
        id: true,
        sourceName: true,
        calculatedQty: true,
        orderVariantId: true,
        variantColor: true,
        status: true,
        erpManagedAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

  const sumBy = (rows: Array<{ sourceName: string | null; calculatedQty: any }>, name: string) =>
    rows.filter((r) => r.sourceName === name).reduce((s, r) => s + Number(r.calculatedQty), 0);

  // ---------------------------------------------------------------------------
  // G9-1: досылка из ERP сохраняет правки цеха внутри расцветок
  // ---------------------------------------------------------------------------

  /**
   * ERP-заказ Белый M=60 / Чёрный M=40 в CALCULATION со спецификацией
   * «Кулирка» 0.30 кг/шт и «Кашкорсе» 1 м пог./шт (ширина 180, плотность ←
   * слот main_density, default 180). Правки цеха: норма Кулирки Чёрного
   * 0.30 → 0.35 (ORDER), плотность Чёрного 220, ручная строка «Кант чёрный»
   * 2 м/шт у Чёрного (только withManual).
   */
  async function setupErpOrder(tag: string, opts: { withManual: boolean }) {
    const spec = await createSpecPattern(t, t.adminCookie, {
      article: `UPS-SPEC-${tag}`,
      parameters: [
        {
          key: 'main_density',
          label: 'Плотность',
          inputType: 'NUMBER',
          unit: 'г/м²',
          isRequired: false,
          defaultValue: '180',
        },
      ],
      materialLines: [
        {
          name: 'Кулирка',
          unit: 'кг',
          qtyPerUnit: '0.30',
          materialRole: 'MAIN_FABRIC',
          fabricType: 'Кулирка',
          colorRule: 'ORDER_COLOR',
        },
        {
          name: 'Кашкорсе',
          unit: 'кг',
          normUnit: 'м пог.',
          qtyPerUnit: '1',
          materialRole: 'RIB',
          fabricType: 'Кашкорсе',
          plannedWidthCm: 180,
          colorRule: 'ORDER_COLOR',
          parameterBindings: { 'char:density': 'main_density' },
        },
      ],
    });
    const created = await http()
      .post('/api/orders')
      .set('Cookie', t.adminCookie)
      .send({
        orderDate: '2026-09-13T00:00:00.000Z',
        productId: seed.product.id,
        clientId: seed.client.id,
        patternItemId: spec.id,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 100 }],
        variants: [
          { color: 'Белый', sizes: [{ sizeId: seed.sizes.M, qtyPlan: 60 }] },
          { color: 'Чёрный', sizes: [{ sizeId: seed.sizes.M, qtyPlan: 40 }] },
        ],
        erpCustomerOrderId: `erp-co-ups-${tag}`,
        erpCustomerOrderNumber: `ФС-00${tag}`,
      })
      .expect(201);
    const orderId = created.body.id as string;
    await http()
      .post(`/api/orders/${orderId}/start-calculation`)
      .set('Cookie', t.adminCookie)
      .send({})
      .expect(201);

    const { byColor } = await variantsOf(orderId);
    const whiteId = byColor.get('Белый')!.id;
    const blackId = byColor.get('Чёрный')!.id;

    const rows = await snapshot(orderId);
    const kulBlack = rows.find((r) => r.name === 'Кулирка' && r.orderVariantId === blackId)!;
    await http()
      .patch(`/api/orders/${orderId}/tech-card/lines/${kulBlack.id}`)
      .set('Cookie', t.adminCookie)
      .send({ qtyPerUnit: '0.35' })
      .expect(200);
    if (opts.withManual) {
      await http()
        .post(`/api/orders/${orderId}/tech-card/lines`)
        .set('Cookie', t.adminCookie)
        .send({ orderVariantId: blackId, name: 'Кант чёрный', unit: 'м', qtyPerUnit: '2', colorText: 'Чёрный' })
        .expect(201);
    }
    const densBlack = await t.prisma.orderTechCardParameter.findFirstOrThrow({
      where: { orderId, key: 'main_density', orderVariantId: blackId },
      select: { id: true },
    });
    await http()
      .patch(`/api/orders/${orderId}/tech-card-parameters/${densBlack.id}`)
      .set('Cookie', t.adminCookie)
      .send({ value: '220' })
      .expect(200);

    // Контроль ДО досылки — правки применились.
    const before = await snapshot(orderId);
    expect(Number(before.find((r) => r.name === 'Кулирка' && r.orderVariantId === blackId)!.totalQty)).toBeCloseTo(14, 4);
    expect(before.find((r) => r.name === 'Кашкорсе' && r.orderVariantId === blackId)!.densityGsm).toBe(220);
    const nb = await needs(orderId);
    expect(sumBy(nb, 'Кулирка')).toBeCloseTo(32, 4);
    expect(sumBy(nb, 'Кашкорсе')).toBeCloseTo(35.28, 4);

    return { orderId, whiteId, blackId };
  }

  /** ERP досылает Белому L=10 (полная картина плана). */
  async function appendWhiteL10(orderId: string) {
    const res = await http()
      .patch(`/api/integrations/erp-orders/${orderId}/plan`)
      .set('Authorization', `Bearer ${erpToken}`)
      .send({
        variants: [
          {
            color: 'Белый',
            sizes: [
              { sizeId: seed.sizes.M, qtyPlan: 60 },
              { sizeId: seed.sizes.L, qtyPlan: 10 },
            ],
          },
          { color: 'Чёрный', sizes: [{ sizeId: seed.sizes.M, qtyPlan: 40 }] },
        ],
      })
      .expect(200);
    expect(res.body.qtyPlan).toBe(110);
  }

  test('G9-1: досылка из ERP сохраняет id расцветок, ORDER-норму, значение параметра и ручную строку расцветки', async () => {
    const { orderId, whiteId, blackId } = await setupErpOrder('T1', { withManual: true });
    await appendWhiteL10(orderId);

    // Расцветки те же (id живут), план догнал: Белый 70, Чёрный 40.
    const { vs, byColor } = await variantsOf(orderId);
    expect(vs).toHaveLength(2);
    expect(byColor.get('Белый')!.id).toBe(whiteId);
    expect(byColor.get('Чёрный')!.id).toBe(blackId);
    expect(byColor.get('Белый')!.sizes.reduce((s, x) => s + x.qtyPlan, 0)).toBe(70);
    expect(byColor.get('Чёрный')!.sizes.reduce((s, x) => s + x.qtyPlan, 0)).toBe(40);

    const rows = await snapshot(orderId);
    // Снимок собран по расцветкам: 2 шаблонных × 2 расцветки + 1 ручная, сирот нет.
    expect(rows.filter((r) => r.orderVariantId === null)).toHaveLength(0);
    expect(rows).toHaveLength(5);

    const kulBlack = rows.find((r) => r.name === 'Кулирка' && r.orderVariantId === blackId)!;
    const kulWhite = rows.find((r) => r.name === 'Кулирка' && r.orderVariantId === whiteId)!;
    const kashBlack = rows.find((r) => r.name === 'Кашкорсе' && r.orderVariantId === blackId)!;
    const kashWhite = rows.find((r) => r.name === 'Кашкорсе' && r.orderVariantId === whiteId)!;
    const kant = rows.filter((r) => r.name === 'Кант чёрный');

    // ORDER-норма Чёрного пережила досылку; Белый догнал тираж 70.
    expect(kulBlack.qtySource).toBe('ORDER');
    expect(Number(kulBlack.qtyPerUnit)).toBeCloseTo(0.35, 4);
    expect(Number(kulBlack.totalQty)).toBeCloseTo(14, 4);
    expect(Number(kulWhite.totalQty)).toBeCloseTo(21, 4);

    // Ручная строка осталась у Чёрного и считается по ЕГО тиражу.
    expect(kant).toHaveLength(1);
    expect(kant[0].orderVariantId).toBe(blackId);
    expect(kant[0].variantColor).toBe('Чёрный');
    expect(Number(kant[0].totalQty)).toBeCloseTo(80, 4);

    // Значение параметра Чёрного 220/MANUAL живёт и подставлено в расщеплённую строку.
    const densBlack = await t.prisma.orderTechCardParameter.findFirstOrThrow({
      where: { orderId, key: 'main_density', orderVariantId: blackId },
    });
    expect(densBlack.value).toBe('220');
    expect(densBlack.valueSource).toBe('MANUAL');
    expect(kashBlack.densityGsm).toBe(220);
    expect(Number(kashBlack.totalQty)).toBeCloseTo(15.84, 4); // 40 × 1.8 × 0.220
    expect(kashWhite.densityGsm).toBe(180);
    expect(Number(kashWhite.totalQty)).toBeCloseTo(22.68, 4); // 70 × 1.8 × 0.180

    // Потребность (строки нетронуты → полный пересчёт прошёл): Белый 70 не остался без полотна.
    const na = await needs(orderId);
    expect(na.filter((n) => n.orderVariantId === null && n.sourceName !== 'Кант чёрный')).toHaveLength(0);
    expect(sumBy(na, 'Кулирка')).toBeCloseTo(35, 4); // 21 + 14
    expect(sumBy(na, 'Кашкорсе')).toBeCloseTo(38.52, 4); // 22.68 + 15.84
    expect(sumBy(na, 'Кант чёрный')).toBeCloseTo(80, 4);
    const order = await t.prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { needsStaleAt: true } });
    expect(order.needsStaleAt).toBeNull();
  });

  test('G9-1: без ручных строк — ORDER-норма и параметр Чёрного переживают досылку', async () => {
    const { orderId, whiteId, blackId } = await setupErpOrder('T2', { withManual: false });
    await appendWhiteL10(orderId);

    const { byColor } = await variantsOf(orderId);
    expect(byColor.get('Белый')!.id).toBe(whiteId);
    expect(byColor.get('Чёрный')!.id).toBe(blackId);

    const rows = await snapshot(orderId);
    expect(rows.filter((r) => r.orderVariantId === null)).toHaveLength(0);
    expect(rows).toHaveLength(4);
    const kulBlack = rows.find((r) => r.name === 'Кулирка' && r.orderVariantId === blackId)!;
    const kashBlack = rows.find((r) => r.name === 'Кашкорсе' && r.orderVariantId === blackId)!;
    expect(kulBlack.qtySource).toBe('ORDER');
    expect(Number(kulBlack.totalQty)).toBeCloseTo(14, 4);
    expect(kashBlack.densityGsm).toBe(220);
    expect(Number(kashBlack.totalQty)).toBeCloseTo(15.84, 4);
    const densBlack = await t.prisma.orderTechCardParameter.findFirstOrThrow({
      where: { orderId, key: 'main_density', orderVariantId: blackId },
    });
    expect(densBlack.value).toBe('220');
    expect(densBlack.valueSource).toBe('MANUAL');
    const na = await needs(orderId);
    expect(sumBy(na, 'Кулирка')).toBeCloseTo(35, 4);
    expect(sumBy(na, 'Кашкорсе')).toBeCloseTo(38.52, 4);
  });

  // ---------------------------------------------------------------------------
  // G6-1: тронутая строка потребности + замена расцветок → без дублей
  // ---------------------------------------------------------------------------

  /** Заказ Белый M 60 / Чёрный L 40, «Кулирка» 0.3 кг/шт ORDER_COLOR + «Дублерин» 0.5 м/шт NO_COLOR, в CALCULATION. */
  async function createNeedsOrder(fromErp: boolean): Promise<string> {
    const spec = await createSpecPattern(t, t.adminCookie, {
      name: 'Футболка G6-1',
      materialLines: [
        { name: 'Кулирка', unit: 'кг', qtyPerUnit: '0.3', materialRole: 'MAIN_FABRIC', fabricType: 'Кулирка', colorRule: 'ORDER_COLOR' },
        { name: 'Дублерин', unit: 'м пог.', qtyPerUnit: '0.5', materialRole: 'LINING', fabricType: 'Дублерин', colorRule: 'NO_COLOR' },
      ],
    });
    const res = await http()
      .post('/api/orders')
      .set('Cookie', t.adminCookie)
      .send({
        orderDate: '2026-09-13T00:00:00.000Z',
        productId: seed.product.id,
        clientId: seed.client.id,
        patternItemId: spec.id,
        items: [
          { sizeId: seed.sizes.M, qtyPlan: 60 },
          { sizeId: seed.sizes.L, qtyPlan: 40 },
        ],
        variants: [
          { color: 'Белый', sizes: [{ sizeId: seed.sizes.M, qtyPlan: 60 }] },
          { color: 'Чёрный', sizes: [{ sizeId: seed.sizes.L, qtyPlan: 40 }] },
        ],
        ...(fromErp ? { erpCustomerOrderId: 'erp-co-g61', erpCustomerOrderNumber: 'ФС-00G61' } : {}),
      })
      .expect(201);
    const orderId = res.body.id as string;
    await http()
      .post(`/api/orders/${orderId}/start-calculation`)
      .set('Cookie', t.adminCookie)
      .send({})
      .expect(201);
    const rows = await needs(orderId);
    expect(rows.filter((r) => r.sourceName === 'Кулирка')).toHaveLength(2);
    expect(rows.filter((r) => r.sourceName === 'Дублерин')).toHaveLength(1);
    return orderId;
  }

  test('G6-1: «дослать план» при строке ORDERED под ЗП ERP — строки потребности не дублируются, ре-линк не нужен', async () => {
    const orderId = await createNeedsOrder(true);
    const baseline = await needs(orderId);
    const whiteKulirka = baseline.find((r) => r.sourceName === 'Кулирка' && r.variantColor === 'Белый')!;
    const oldVariantIds = (await variantsOf(orderId)).vs.map((v) => v.id);

    // ERP заказала «Кулирка Белый» → ORDERED + erpManagedAt (тронутая строка).
    await http()
      .post(`/api/workshop-needs/${whiteKulirka.id}/erp-link`)
      .set('Authorization', `Bearer ${erpToken}`)
      .send({ status: 'ORDERED', erpPurchaseOrderId: 'erp-po-1', erpPurchaseOrderRef: 'ЗП-000001', erpUnitPriceRub: '620' })
      .expect(201);

    const plan = {
      variants: [
        { color: 'Белый', sizes: [{ sizeId: seed.sizes.M, qtyPlan: 70 }] },
        { color: 'Чёрный', sizes: [{ sizeId: seed.sizes.L, qtyPlan: 40 }] },
      ],
    };
    const res = await http()
      .patch(`/api/integrations/erp-orders/${orderId}/plan`)
      .set('Authorization', `Bearer ${erpToken}`)
      .send(plan)
      .expect(200);
    expect(res.body.qtyPlan).toBe(110);

    // Расцветки те же.
    const { vs, byColor } = await variantsOf(orderId);
    expect(vs.map((v) => v.id).sort()).toEqual([...oldVariantIds].sort());
    expect(byColor.get('Белый')!.sizes[0].qtyPlan).toBe(70);

    // Потребность: полный пересчёт законно отбит (строка под ЗП ERP) — отметка
    // «устарела» стоит, но добор НИЧЕГО не дописал: строки узнаны по прежним id.
    const order = await t.prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { needsStaleAt: true, needsStaleReason: true } });
    expect(order.needsStaleAt).not.toBeNull();
    expect(order.needsStaleReason ?? '').not.toMatch(/дописан/u);

    const rows = await needs(orderId);
    const kulirka = rows.filter((r) => r.sourceName === 'Кулирка');
    expect(kulirka).toHaveLength(2);
    expect(kulirka.every((r) => r.orderVariantId !== null)).toBe(true);
    expect(sumBy(rows, 'Кулирка')).toBeCloseTo(30, 4); // 18 (ORDERED, не переписана) + 12
    expect(kulirka.find((r) => r.status === 'ORDERED')!.orderVariantId).toBe(byColor.get('Белый')!.id);
    expect(rows.filter((r) => r.sourceName === 'Дублерин')).toHaveLength(1);

    // Доля паспорта Белый M qtyCut 70: только строка Белого (18), сирот-«order-level» нет.
    const passport = await t.prisma.passport.create({
      data: {
        number: 'P-UPS-1',
        qrCode: 'QR-P-UPS-1',
        orderId,
        productId: seed.product.id,
        sizeId: seed.sizes.M,
        color: 'Белый',
        orderVariantId: byColor.get('Белый')!.id,
        rollNumber: 'R-1',
        cutDate: new Date('2026-09-13T00:00:00.000Z'),
        qtyPlan: 70,
        qtyCut: 70,
        qtyGood: 70,
        cutterId: seed.employees.cutter.id,
        creatorId: seed.employees.cutter.id,
      },
      select: { id: true },
    });
    const shares = await resolvePassportNeedShares(t.prisma as any, passport.id);
    expect(shares.ok).toBe(true);
    if (!shares.ok) throw new Error('unreachable');
    const kulirkaShare = shares.shares
      .filter((s) => s.need.sourceName === 'Кулирка')
      .reduce((sum, s) => sum + Number(s.qty), 0);
    expect(kulirkaShare).toBeCloseTo(18, 3);

    // Повтор той же картины (ретрай ERP после молчания сети) — ничего не прибавляет.
    await http()
      .patch(`/api/integrations/erp-orders/${orderId}/plan`)
      .set('Authorization', `Bearer ${erpToken}`)
      .send(plan)
      .expect(200);
    const rows2 = await needs(orderId);
    expect(rows2.filter((r) => r.sourceName === 'Кулирка')).toHaveLength(2);
    expect(sumBy(rows2, 'Кулирка')).toBeCloseTo(30, 4);
    expect(rows2.every((r) => r.orderVariantId !== null || r.sourceName === 'Дублерин')).toBe(true);
  });

  test('G6-1: собственный заказ, edit-форма с variants при REVIEWED-строке закупщика — без дублей', async () => {
    const orderId = await createNeedsOrder(false);
    const baseline = await needs(orderId);
    const whiteKulirka = baseline.find((r) => r.sourceName === 'Кулирка' && r.variantColor === 'Белый')!;

    await http()
      .patch(`/api/workshop-needs/${whiteKulirka.id}`)
      .set('Cookie', t.adminCookie)
      .send({ status: 'REVIEWED', purchaseQty: '18', quotedPrice: '620', quotedCurrency: 'RUB' })
      .expect(200);

    await http()
      .patch(`/api/orders/${orderId}`)
      .set('Cookie', t.adminCookie)
      .send({
        variants: [
          { color: 'Белый', sizes: [{ sizeId: seed.sizes.M, qtyPlan: 70 }] },
          { color: 'Чёрный', sizes: [{ sizeId: seed.sizes.L, qtyPlan: 40 }] },
        ],
      })
      .expect(200);

    const rows = await needs(orderId);
    const kulirka = rows.filter((r) => r.sourceName === 'Кулирка');
    expect(kulirka).toHaveLength(2);
    expect(kulirka.every((r) => r.orderVariantId !== null)).toBe(true);
    const reviewed = kulirka.find((r) => r.status === 'REVIEWED')!;
    expect(reviewed.id).toBe(whiteKulirka.id);
    expect(reviewed.orderVariantId).toBe(whiteKulirka.orderVariantId);
    expect(sumBy(rows, 'Кулирка')).toBeCloseTo(30, 4);
  });

  // ---------------------------------------------------------------------------
  // Семантика сопоставления edit-формы
  // ---------------------------------------------------------------------------

  test('edit-форма: перестановка и новый цвет — совпавшие по цвету расцветки живут, остаток по порядку (переименование), лишние удаляются', async () => {
    const spec = await createSpecPattern(t, t.adminCookie, {
      materialLines: [
        { name: 'Полотно', unit: 'м2', qtyPerUnit: '0.42', materialRole: 'MAIN_FABRIC', fabricType: 'кулирка', colorRule: 'ORDER_COLOR' },
      ],
    });
    const created = await http()
      .post('/api/orders')
      .set('Cookie', t.adminCookie)
      .send({
        orderDate: '2026-09-13T00:00:00.000Z',
        productId: seed.product.id,
        clientId: seed.client.id,
        patternItemId: spec.id,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 100 }],
        variants: [
          { color: 'Белый', sizes: [{ sizeId: seed.sizes.M, qtyPlan: 60 }] },
          { color: 'Чёрный', sizes: [{ sizeId: seed.sizes.M, qtyPlan: 40 }] },
        ],
      })
      .expect(201);
    const orderId = created.body.id as string;
    const before = await variantsOf(orderId);
    const whiteId = before.byColor.get('Белый')!.id;
    const blackId = before.byColor.get('Чёрный')!.id;

    // Чёрный вперёд + Синий вместо Белого: Чёрный узнан по цвету, Белый → Синий по порядку.
    await http()
      .patch(`/api/orders/${orderId}`)
      .set('Cookie', t.adminCookie)
      .send({
        variants: [
          { color: 'Чёрный', sizes: [{ sizeId: seed.sizes.M, qtyPlan: 45 }] },
          { color: 'Синий', sizes: [{ sizeId: seed.sizes.L, qtyPlan: 5 }] },
        ],
      })
      .expect(200);
    const after = await variantsOf(orderId);
    expect(after.vs.map((v) => [v.ordinal, v.color])).toEqual([
      [0, 'Чёрный'],
      [1, 'Синий'],
    ]);
    expect(after.byColor.get('Чёрный')!.id).toBe(blackId);
    expect(after.byColor.get('Синий')!.id).toBe(whiteId);
    expect(after.byColor.get('Чёрный')!.sizes.map((s) => [s.sizeId, s.qtyPlan])).toEqual([[seed.sizes.M, 45]]);
    expect(after.byColor.get('Синий')!.sizes.map((s) => [s.sizeId, s.qtyPlan])).toEqual([[seed.sizes.L, 5]]);
    const items = await t.prisma.orderItem.findMany({ where: { orderId } });
    expect(Object.fromEntries(items.map((i) => [i.sizeId, i.qtyPlan]))).toEqual({
      [seed.sizes.M]: 45,
      [seed.sizes.L]: 5,
    });
    // Ревью G9-1: переименование по порядку не молчит — в журнале пара
    // «Белый → Синий» (правки Белого остались на расцветке с id Белого).
    const renamedEvents = await t.prisma.auditLog.findMany({
      where: { entityId: orderId, event: 'ORDER_VARIANTS_RENAMED' },
    });
    expect(renamedEvents).toHaveLength(1);
    const renamedPayload = renamedEvents[0]!.payload as {
      renamed: Array<{ variantId: string; from: string; to: string }>;
      summary: string;
    };
    expect(renamedPayload.renamed).toEqual([{ variantId: whiteId, from: 'Белый', to: 'Синий' }]);
    expect(renamedPayload.summary).toContain('«Белый» → «Синий»');

    // Одна расцветка: лишняя удаляется, оставшаяся узнана по цвету.
    await http()
      .patch(`/api/orders/${orderId}`)
      .set('Cookie', t.adminCookie)
      .send({ variants: [{ color: 'Синий', sizes: [{ sizeId: seed.sizes.M, qtyPlan: 50 }] }] })
      .expect(200);
    const last = await variantsOf(orderId);
    expect(last.vs).toHaveLength(1);
    expect(last.vs[0].id).toBe(whiteId);
    expect(last.vs[0].ordinal).toBe(0);
    expect(last.vs[0].color).toBe('Синий');
    // Сопоставление по цвету — не переименование: нового события нет.
    expect(
      await t.prisma.auditLog.count({ where: { entityId: orderId, event: 'ORDER_VARIANTS_RENAMED' } }),
    ).toBe(1);
  });
});
