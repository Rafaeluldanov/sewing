/**
 * Integration-тесты «снимок номенклатуры на расчёте» (см.
 * `apps/api/src/modules/orders/orders.service.ts`,
 * `apps/web/lib/order-nomenclature.ts`).
 *
 * Проблема, которую закрывает этот функционал: ранее
 * `Order.patternNameSnapshot` фиксировался ТОЛЬКО при запуске заказа
 * в производство (`OrdersService.start`). Если менеджер перевёл
 * заказ в «Расчёт» и кто-то параллельно переименовал карточку лекала
 * (`PatternItem.name`), API карточки заказа отдавал live-имя
 * `patternName`, а блок «Изделие» в UI вообще брал `productName`
 * (legacy `Product.name`, который тоже не переименовывается). В одной
 * карточке появлялись два разных названия одного и того же изделия.
 *
 * Что должны проверить тесты:
 *   1. DRAFT (без snapshot) — API отдаёт live `patternName`.
 *   2. DRAFT → CALCULATION фиксирует snapshot из текущего PatternItem.
 *   3. После переименования PatternItem snapshot НЕ меняется.
 *   4. CALCULATION → IN_PRODUCTION НЕ перезаписывает snapshot.
 *   5. Legacy-заказ без `patternItemId`: API отдаёт `productName`,
 *      snapshot полей пустой, но resolver на UI этим займётся.
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

describeWithDb('integration — order × pattern snapshot', () => {
  let t: TestApp;
  let seed: SeedResult;
  let cookie: string;

  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await stopTestApp(t);
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    seed = await seedMinimal(t.prisma);
    cookie = loginAs(t, seed.employees['shop-chief']);
  });

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  async function makePattern(opts: {
    name: string;
    article: string;
    previewImageUrl?: string | null;
  }): Promise<{ id: string; name: string; article: string }> {
    const p = await t.prisma.patternItem.create({
      data: {
        name: opts.name,
        article: opts.article,
        previewImageUrl: opts.previewImageUrl ?? null,
        status: 'ACTIVE',
      },
    });
    return { id: p.id, name: p.name, article: p.article };
  }

  async function makeTechCard(code: string): Promise<{ id: string }> {
    const r = await request(t.app.getHttpServer())
      .post('/api/tech-cards')
      .set('Cookie', cookie)
      .send({
        code,
        name: `TC ${code}`,
        materialLines: [
          { name: 'Нитки', unit: 'м', qtyPerUnit: '1.5' },
        ],
      })
      .expect(201);
    return { id: r.body.id };
  }

  async function createDraftOrder(opts: {
    patternItemId?: string | null;
    techCardId?: string | null;
    productId?: string;
  }): Promise<string> {
    const r = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookie)
      .send({
        orderDate: new Date().toISOString(),
        patternItemId: opts.patternItemId ?? undefined,
        productId: opts.productId,
        techCardId: opts.techCardId ?? undefined,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 4 }],
      })
      .expect(201);
    return r.body.id as string;
  }

  // ---------------------------------------------------------------------------
  // 1. DRAFT без snapshot отдаёт live patternName
  // ---------------------------------------------------------------------------

  test('DRAFT-заказ без snapshot отдаёт live patternName в API', async () => {
    const pattern = await makePattern({
      name: 'Худи',
      article: 'P-HOODIE-1',
    });
    const orderId = await createDraftOrder({ patternItemId: pattern.id });

    // Переименовываем PatternItem ПОСЛЕ создания заказа.
    await t.prisma.patternItem.update({
      where: { id: pattern.id },
      data: { name: 'Худи база (кенгуру)' },
    });

    const r = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(r.body.patternName).toBe('Худи база (кенгуру)');
    expect(r.body.patternNameSnapshot).toBeNull();
    // Resolver на UI выберет live-имя — здесь это ровно тот случай,
    // когда DRAFT-заказ ещё не «застыл».
  });

  // ---------------------------------------------------------------------------
  // 2. DRAFT → CALCULATION фиксирует snapshot
  // ---------------------------------------------------------------------------

  test('DRAFT → CALCULATION фиксирует snapshot номенклатуры', async () => {
    const pattern = await makePattern({
      name: 'Худи',
      article: 'P-HOODIE-2',
      previewImageUrl: '/uploads/patterns/p2/preview.png',
    });
    const tc = await makeTechCard('TC-SC-2');
    const orderId = await createDraftOrder({
      patternItemId: pattern.id,
      techCardId: tc.id,
    });

    // До start-calculation snapshot пуст.
    const before = await t.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        patternNameSnapshot: true,
        patternArticleSnapshot: true,
        patternPreviewSnapshotUrl: true,
        status: true,
      },
    });
    expect(before?.patternNameSnapshot).toBeNull();
    expect(before?.status).toBe('DRAFT');

    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start-calculation`)
      .set('Cookie', cookie)
      .expect(201);

    const after = await t.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        patternNameSnapshot: true,
        patternArticleSnapshot: true,
        patternPreviewSnapshotUrl: true,
        status: true,
      },
    });
    expect(after?.status).toBe('CALCULATION');
    expect(after?.patternNameSnapshot).toBe('Худи');
    expect(after?.patternArticleSnapshot).toBe('P-HOODIE-2');
    expect(after?.patternPreviewSnapshotUrl).toBe(
      '/uploads/patterns/p2/preview.png',
    );

    // Аудит: ORDER_PATTERN_SNAPSHOT_CREATED с capturedAt = 'CALCULATION'.
    const audit = await t.prisma.auditLog.findFirst({
      where: { event: 'ORDER_PATTERN_SNAPSHOT_CREATED', entityId: orderId },
    });
    expect(audit).not.toBeNull();
    const payload = (audit?.payload ?? {}) as Record<string, unknown>;
    expect(payload.capturedAt).toBe('CALCULATION');
    expect(payload.patternNameSnapshot).toBe('Худи');
  });

  // ---------------------------------------------------------------------------
  // 3. После CALCULATION переименование PatternItem не двигает snapshot
  // ---------------------------------------------------------------------------

  test('после CALCULATION переименование PatternItem не двигает snapshot, API отдаёт snapshot', async () => {
    const pattern = await makePattern({
      name: 'Худи',
      article: 'P-HOODIE-3',
    });
    const tc = await makeTechCard('TC-SC-3');
    const orderId = await createDraftOrder({
      patternItemId: pattern.id,
      techCardId: tc.id,
    });

    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start-calculation`)
      .set('Cookie', cookie)
      .expect(201);

    // Переименовываем лекало после фиксации snapshot-а.
    await t.prisma.patternItem.update({
      where: { id: pattern.id },
      data: { name: 'Худи база (кенгуру)', article: 'P-HOODIE-NEW' },
    });

    const r = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}`)
      .set('Cookie', cookie)
      .expect(200);
    // Live live-поля в DTO отражают актуальное состояние карточки
    // лекала (для UI редактирования / превью snapshot ⊃ live).
    expect(r.body.patternName).toBe('Худи база (кенгуру)');
    expect(r.body.patternArticle).toBe('P-HOODIE-NEW');
    // Snapshot держит исходные значения.
    expect(r.body.patternNameSnapshot).toBe('Худи');
    expect(r.body.patternArticleSnapshot).toBe('P-HOODIE-3');
    // Запрос напрямую в БД — для убедительности (snapshot физически
    // не переписался).
    const db = await t.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        patternNameSnapshot: true,
        patternArticleSnapshot: true,
      },
    });
    expect(db?.patternNameSnapshot).toBe('Худи');
    expect(db?.patternArticleSnapshot).toBe('P-HOODIE-3');
  });

  // ---------------------------------------------------------------------------
  // 4. CALCULATION → IN_PRODUCTION НЕ перезаписывает snapshot
  // ---------------------------------------------------------------------------

  test('CALCULATION → IN_PRODUCTION не перезаписывает уже зафиксированный snapshot', async () => {
    const pattern = await makePattern({
      name: 'Худи',
      article: 'P-HOODIE-4',
      previewImageUrl: '/uploads/patterns/p4/preview.png',
    });
    const tc = await makeTechCard('TC-SC-4');
    const orderId = await createDraftOrder({
      patternItemId: pattern.id,
      techCardId: tc.id,
    });

    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start-calculation`)
      .set('Cookie', cookie)
      .expect(201);

    // Изменяем live-имя карточки лекала.
    await t.prisma.patternItem.update({
      where: { id: pattern.id },
      data: {
        name: 'Худи база (кенгуру)',
        article: 'P-HOODIE-NEW',
        previewImageUrl: '/uploads/patterns/p4/preview-new.png',
      },
    });

    // Запускаем заказ в производство.
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start`)
      .set('Cookie', cookie)
      .expect(201);

    const after = await t.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        status: true,
        patternNameSnapshot: true,
        patternArticleSnapshot: true,
        patternPreviewSnapshotUrl: true,
      },
    });
    expect(after?.status).toBe('IN_PRODUCTION');
    // Snapshot должен остаться от этапа расчёта.
    expect(after?.patternNameSnapshot).toBe('Худи');
    expect(after?.patternArticleSnapshot).toBe('P-HOODIE-4');
    expect(after?.patternPreviewSnapshotUrl).toBe(
      '/uploads/patterns/p4/preview.png',
    );

    // ORDER_PATTERN_SNAPSHOT_CREATED ровно ОДИН — от CALCULATION.
    // (capturedAt='IN_PRODUCTION' не должно быть, потому что snapshot
    // не перезаписывался).
    const snapAudits = await t.prisma.auditLog.findMany({
      where: {
        event: 'ORDER_PATTERN_SNAPSHOT_CREATED',
        entityId: orderId,
      },
    });
    expect(snapAudits).toHaveLength(1);
    expect(
      (snapAudits[0]?.payload as Record<string, unknown>)?.capturedAt,
    ).toBe('CALCULATION');

    // ORDER_STARTED.payload.patternSnapshotPreserved = true (флаг,
    // который backend пишет в журнал, чтобы было видно: snapshot уже
    // был и мы его не трогали).
    const started = await t.prisma.auditLog.findFirst({
      where: { event: 'ORDER_STARTED', entityId: orderId },
      orderBy: { createdAt: 'desc' },
    });
    expect(
      (started?.payload as Record<string, unknown>)?.patternSnapshotPreserved,
    ).toBe(true);
    expect(
      (started?.payload as Record<string, unknown>)?.patternSnapshotCaptured,
    ).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // 5. Legacy-заказ без patternItemId: snapshot пустой, productName заполнен
  // ---------------------------------------------------------------------------

  test('legacy-заказ без patternItemId не получает snapshot, productName приходит как fallback', async () => {
    // Старый flow: заказ создаётся по legacy `productId` без
    // `patternItemId`. Это путь CUTTER_ASSISTANT-а или прямого POST.
    const orderId = await createDraftOrder({ productId: seed.product.id });

    const r = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(r.body.patternItemId).toBeNull();
    expect(r.body.patternName).toBeNull();
    expect(r.body.patternNameSnapshot).toBeNull();
    // Backward-compat: productName есть, и UI-resolver возьмёт его
    // как последний fallback с бейджем «legacy».
    expect(r.body.productName).toBe(seed.product.name);
  });

  // ---------------------------------------------------------------------------
  // 6. GET /api/orders (список) — отдаёт live + snapshot pattern-поля,
  //    после переименования PatternItem не теряет snapshot. UI-resolver
  //    в /admin/orders должен видеть ровно тот же контракт, что и UI
  //    карточки заказа /admin/orders/[id].
  // ---------------------------------------------------------------------------

  test('GET /api/orders отдаёт live + snapshot pattern-поля и productName-fallback', async () => {
    // Кейс A: заказ в CALCULATION с зафиксированным snapshot-ом.
    // После переименования карточки лекала список должен показать
    // snapshot («Худи»), а не live-имя («Худи база (кенгуру)»).
    const patternA = await makePattern({
      name: 'Худи',
      article: 'P-LIST-A',
    });
    const tcA = await makeTechCard('TC-LIST-A');
    const orderA = await createDraftOrder({
      patternItemId: patternA.id,
      techCardId: tcA.id,
    });
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderA}/start-calculation`)
      .set('Cookie', cookie)
      .expect(201);
    await t.prisma.patternItem.update({
      where: { id: patternA.id },
      data: { name: 'Худи база (кенгуру)', article: 'P-LIST-A-NEW' },
    });

    // Кейс B: DRAFT-заказ без snapshot, после переименования
    // PatternItem список должен отдать актуальный live-name.
    const patternB = await makePattern({
      name: 'Свитшот',
      article: 'P-LIST-B',
    });
    const orderB = await createDraftOrder({ patternItemId: patternB.id });
    await t.prisma.patternItem.update({
      where: { id: patternB.id },
      data: { name: 'Свитшот база', article: 'P-LIST-B-NEW' },
    });

    // Кейс C: legacy-заказ без patternItemId — fallback на productName.
    const orderC = await createDraftOrder({ productId: seed.product.id });

    const r = await request(t.app.getHttpServer())
      .get('/api/orders')
      .set('Cookie', cookie)
      .expect(200);
    const items = r.body.items as Array<Record<string, unknown>>;
    const byId = new Map(items.map((it) => [it.id as string, it]));
    expect(byId.size).toBeGreaterThanOrEqual(3);

    const a = byId.get(orderA);
    expect(a, 'order A is in list response').toBeDefined();
    // Live-поля отражают актуальную карточку лекала; snapshot держит
    // имя на момент перевода в «Расчёт».
    expect(a?.patternName).toBe('Худи база (кенгуру)');
    expect(a?.patternArticle).toBe('P-LIST-A-NEW');
    expect(a?.patternNameSnapshot).toBe('Худи');
    expect(a?.patternArticleSnapshot).toBe('P-LIST-A');

    const b = byId.get(orderB);
    expect(b, 'order B is in list response').toBeDefined();
    // DRAFT без snapshot: list отдаёт live-имя, snapshot пуст.
    expect(b?.patternName).toBe('Свитшот база');
    expect(b?.patternArticle).toBe('P-LIST-B-NEW');
    expect(b?.patternNameSnapshot).toBeNull();
    expect(b?.patternArticleSnapshot).toBeNull();

    const c = byId.get(orderC);
    expect(c, 'order C is in list response').toBeDefined();
    expect(c?.patternItemId).toBeNull();
    expect(c?.patternName).toBeNull();
    expect(c?.patternNameSnapshot).toBeNull();
    // Backward-compat: legacy productName есть → UI-resolver возьмёт
    // его как последний fallback и нарисует бейдж «legacy».
    expect(c?.productName).toBe(seed.product.name);
  });
});
