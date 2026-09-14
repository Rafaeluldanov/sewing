/**
 * Очередь сдачи в ERP и свежесть документа выпуска — ревью починок аудита движка расчёта
 * 13.09.2026 (группа FX2_documents_queue).
 *
 *   G7-1 (сторона цеха) — ключ курсора = ключ сортировки: у документа есть `queue_at` =
 *        max(ready_at, recalculated_at), страница отобрана по `queue_at >= ready_from` и
 *        отсортирована по нему; ERP двигает курсор по max(queue_at) страницы и дочитывает ВСЁ.
 *        Раньше 20 пересобранных документов со старым `readyAt` занимали страницу навсегда.
 *   D1-3 — писатели поздних фактов будят СФОРМИРОВАННЫЙ документ сами (фоном): выдача и возврат
 *        материала, прочий расход, строка логистики — и документ возвращается в очередь ERP по
 *        `queue_at`, даже если курсор ERP давно ушёл за его `ready_at`.
 *   D1-2 — ответ ERP по списанию не пересобирает документ в ответе `ack` (фон, дедуп по заказу).
 *   D1-10 — логистика заказа входит в отпечаток фактов.
 *   D1-12 — изменение одних предупреждений (ответ ERP FAILED) — тоже пересборка с
 *        `recalculatedAt`; `lastFactKind` при этом не переписывается.
 */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';

import { loginAs, startTestApp, stopTestApp, type TestApp } from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import {
  buildErpConsumptionService,
  buildErpProductionService,
  buildProductionDocumentsService,
} from '../utils/erp-services';
import { seedMinimal, type SeedResult } from '../utils/seed';
import { createSpecPattern } from '../utils/spec';
import { ProductionDocumentsService } from '../../apps/api/src/modules/production-documents/production-documents.service.js';

type Item = Record<string, any>;

describeWithDb('integration — очередь сдачи в ERP: курсор по queue_at и поздние факты', () => {
  let t: TestApp;
  let seed: SeedResult;
  let cookies: Record<string, string>;
  let specId: string;

  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await stopTestApp(t);
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    seed = await seedMinimal(t.prisma);
    cookies = { manager: loginAs(t, seed.employees['shop-chief']) };
    specId = (
      await createSpecPattern(t, cookies.manager, {
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
    ).id;
    // `resetDatabase` не трогает CompanySettings: отсечку и оси материала фиксируем явно, чтобы
    // выдача без паспорта считалась расходом независимо от соседних тестов.
    await t.prisma.companySettings.upsert({
      where: { id: 'default' },
      create: {
        id: 'default', singleton: true,
        erpFinishedGoodsSince: new Date('2026-08-01T00:00:00.000Z'),
        materialQtySource: 'ISSUED_OR_CALCULATED', materialPriceSource: 'PURCHASE',
      },
      update: {
        erpFinishedGoodsSince: new Date('2026-08-01T00:00:00.000Z'),
        materialQtySource: 'ISSUED_OR_CALCULATED', materialPriceSource: 'PURCHASE',
      },
    });
  });

  /**
   * Закрытый заказ ERP с одним упакованным паспортом на 10 шт → документ выпуска READY.
   * `withNeeds` — посчитать потребность цеха (строке «под ERP» для сигналов D1-12; выдаче по
   * потребности для D1-3); `needPrice` — котировка закупщика по ткани, ₽.
   */
  async function closedErpOrder(
    n: number,
    opts: { withNeeds?: boolean; needPrice?: number } = {},
  ): Promise<string> {
    const order = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', cookies.manager)
      .send({
        orderDate: '2026-09-01T00:00:00.000Z',
        productId: seed.product.id,
        color: 'Чёрный',
        items: [{ sizeId: seed.sizes.M, qtyPlan: 10 }],
        patternItemId: specId,
        erpCustomerOrderId: `erp-order-${n}`,
        erpCustomerOrderNumber: `ФС-${String(n).padStart(6, '0')}`,
      })
      .expect(201);
    const orderId: string = order.body.id;
    if (opts.withNeeds) {
      await request(t.app.getHttpServer())
        .post(`/api/orders/${orderId}/workshop-needs/calculate`)
        .set('Cookie', cookies.manager)
        .send({})
        .expect(201);
      if (opts.needPrice != null) {
        await t.prisma.workshopNeed.updateMany({
          where: { orderId, materialRole: 'MAIN_FABRIC' },
          data: { quotedPrice: String(opts.needPrice), quotedCurrency: 'RUB' },
        });
      }
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
        rollNumber: `R-Q-${n}`,
        cutDate: '2026-09-01T00:00:00.000Z',
        qtyCut: 10,
        cutterId: seed.employees.cutter.id,
      })
      .expect(201);
    await t.prisma.passport.update({
      where: { id: passport.body.id },
      data: { status: 'PACKED', qtyGood: 10 },
    });
    // Закрываем настоящей ручкой: документ рождается в транзакции закрытия.
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/complete`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(201);
    return orderId;
  }

  async function docOf(orderId: string): Promise<Item> {
    const res = await request(t.app.getHttpServer())
      .get(`/api/admin/orders/${orderId}/production-document`)
      .set('Cookie', cookies.manager)
      .expect(200);
    return res.body as Item;
  }

  /** DI-экземпляр сервиса документов — чтобы дождаться фоновых пересборок HTTP-писателей. */
  function appDocuments(): ProductionDocumentsService {
    return t.app.get(ProductionDocumentsService);
  }

  /**
   * Эмуляция тика ERP по контракту G7-1: страница за страницей от курсора, курсор =
   * max(queue_at) страницы, стоп — когда страница не принесла ничего нового.
   */
  async function pullAll(
    since: string,
    limit: number,
  ): Promise<{ numbers: string[]; pages: Item[][]; cursor: string }> {
    const svc = buildErpProductionService(t);
    const seen = new Set<string>();
    const numbers: string[] = [];
    const pages: Item[][] = [];
    let cursor = since;
    for (let i = 0; i < 10; i++) {
      const page = (await svc.listPending(limit, cursor)).items as Item[];
      pages.push(page);
      const fresh = page.filter((d) => !seen.has(String(d.document_number)));
      if (fresh.length === 0) break;
      for (const d of fresh) {
        seen.add(String(d.document_number));
        numbers.push(String(d.document_number));
      }
      cursor = page.map((d) => String(d.queue_at)).sort().at(-1) ?? cursor;
    }
    return { numbers, pages, cursor };
  }

  // ---------------------------------------------------------------------------
  // G7-1 — ключ курсора = ключ сортировки
  // ---------------------------------------------------------------------------

  test('G7-1: 25 документов, 20 старейших пересобраны — страница по queue_at, курсор двигается, ERP дочитывает все', async () => {
    const orderIds: string[] = [];
    for (let n = 0; n < 25; n++) orderIds.push(await closedErpOrder(n));

    // Бэкдейт: readyAt по часу с 01.09; у 20 СТАРЕЙШИХ — пересборка 12.09 (новее любого readyAt).
    const base = new Date('2026-09-01T00:00:00.000Z').getTime();
    const recalcBase = new Date('2026-09-12T00:00:00.000Z').getTime();
    for (const [n, orderId] of orderIds.entries()) {
      await t.prisma.productionDocument.update({
        where: { orderId },
        data: {
          readyAt: new Date(base + n * 3_600_000),
          recalculatedAt: n < 20 ? new Date(recalcBase + n * 60_000) : null,
          recalcReason: n < 20 ? 'Факт расхода или начислений пришёл после фиксации' : null,
        },
      });
    }
    const numberOf = async (n: number) =>
      (await t.prisma.productionDocument.findUniqueOrThrow({ where: { orderId: orderIds[n] } }))
        .number;

    const { numbers, pages } = await pullAll('2026-08-01T00:00:00.000Z', 20);

    // Раньше здесь было 20: пересобранные занимали страницу, курсор по ready_at уезжал назад.
    expect(numbers).toHaveLength(25);
    expect(new Set(numbers).size).toBe(25);
    expect(pages.length).toBeLessThanOrEqual(3);

    // Страница 1: сначала пять НЕпересобранных (queue_at = readyAt 01.09), затем пересобранные
    // по recalculatedAt — порядок строго по queue_at, а не по readyAt.
    const first = pages[0];
    expect(first).toHaveLength(20);
    for (const item of first) {
      expect(typeof item.queue_at).toBe('string');
      const expected = [item.ready_at, item.recalculated_at]
        .filter((v): v is string => typeof v === 'string')
        .sort()
        .at(-1);
      expect(item.queue_at).toBe(expected);
    }
    const queueAts = first.map((d) => String(d.queue_at));
    expect([...queueAts].sort()).toEqual(queueAts);
    expect(first.slice(0, 5).map((d) => d.document_number)).toEqual([
      await numberOf(20), await numberOf(21), await numberOf(22), await numberOf(23), await numberOf(24),
    ]);
    expect(first[5].document_number).toBe(await numberOf(0));

    // Страница 2 начинается с курсора = max(queue_at) страницы 1 (`>=`: сосед по границе
    // приходит повторно, ERP гасит его по номеру) и приносит оставшихся.
    const second = pages[1];
    expect(second[0].document_number).toBe(await numberOf(14));
    expect(second.map((d) => d.document_number)).toContain(await numberOf(19));
  }, 180_000);

  test('G7-1: без параметра отсечка из настроек, closed_from — синоним ready_from', async () => {
    const orderId = await closedErpOrder(1);
    const svc = buildErpProductionService(t);
    const byDefault = await svc.listPending(10);
    expect(byDefault.count).toBe(1);
    expect((byDefault.items[0] as Item).order_id).toBe(orderId);
    // Курсор впереди документа — он не приходит; за ним — приходит.
    const doc = await t.prisma.productionDocument.findUniqueOrThrow({ where: { orderId } });
    const after = new Date(doc.readyAt!.getTime() + 1000).toISOString();
    expect((await svc.listPending(10, after)).count).toBe(0);
    expect((await svc.listPending(10, doc.readyAt!.toISOString())).count).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // D1-3 — писатели поздних фактов будят документ сами
  // ---------------------------------------------------------------------------

  test('D1-3: поздняя выдача по READY-заказу (настоящий POST/post) пересобирает документ фоном и возвращает его в очередь ERP', async () => {
    // Потребность «Кулирка» 0,5 кг/шт × 10 по 500 ₽: без выдачи документ считает по норме — 2 500.
    const orderId = await closedErpOrder(1, { withNeeds: true, needPrice: 500 });
    const need = await t.prisma.workshopNeed.findFirstOrThrow({
      where: { orderId, materialRole: 'MAIN_FABRIC' },
    });
    const ready = await docOf(orderId);
    expect(ready.status).toBe('READY');
    expect(ready.cost.totalRub).toBe(2500);

    // Документ готов 05.09, ERP прочитала его тогда же: её курсор давно ушёл за ready_at.
    await t.prisma.productionDocument.update({
      where: { orderId },
      data: { readyAt: new Date('2026-09-05T10:00:00.000Z') },
    });
    const before = await t.prisma.productionDocument.findUniqueOrThrow({ where: { orderId } });
    const cursor = '2026-09-06T00:00:00.000Z';
    const svc = buildErpProductionService(t);
    expect((await svc.listPending(10, cursor)).count).toBe(0);

    // Через день менеджер проводит выдачу ткани на заказ (10 кг по потребности), без паспорта.
    // Карточку никто не открывает, очередь окно за курсором не сверяет.
    const created = await request(t.app.getHttpServer())
      .post('/api/material-issues')
      .set('Cookie', cookies.manager)
      .send({
        orderId,
        lines: [{ workshopNeedId: need.id, issuedQty: '10', unitCost: '500' }],
      })
      .expect(201);
    await request(t.app.getHttpServer())
      .post(`/api/material-issues/${created.body.id}/post`)
      .set('Cookie', cookies.manager)
      .send({})
      .expect(200);
    await appDocuments().settleDeferredRefreshes();

    // Снимок пересобран без чтения в UI: выдано 10 кг × 500 вместо нормы 5 кг.
    const row = await t.prisma.productionDocument.findUniqueOrThrow({ where: { orderId } });
    expect(Number(row.totalRub)).toBe(5000);
    expect(Number(row.materialsOwnRub)).toBe(5000);
    expect(row.status).toBe('READY');
    expect(row.recalculatedAt).toBeTruthy();
    expect(row.recalculatedAt!.getTime()).toBeGreaterThan(new Date(cursor).getTime());

    // И очередь ERP с тем же курсором отдаёт документ заново — по queue_at = recalculated_at.
    const queue = await svc.listPending(10, cursor);
    expect(queue.count).toBe(1);
    const item = queue.items[0] as Item;
    expect(item.document_number).toBe(before.number);
    expect(item.cost.total_rub).toBe(5000);
    expect(item.queue_at).toBe(item.recalculated_at);

    // Частичный возврат 4 кг — тоже поздний факт: 6 × 500, снова в очередь.
    const issueLineId = String(created.body.lines[0].id);
    await request(t.app.getHttpServer())
      .post(`/api/material-issues/${created.body.id}/return`)
      .set('Cookie', cookies.manager)
      .send({
        reason: 'остаток рулона',
        clientRequestId: 'ret-1',
        lines: [{ materialIssueLineId: issueLineId, returnedQty: '4' }],
      })
      .expect(200);
    await appDocuments().settleDeferredRefreshes();
    const returned = await t.prisma.productionDocument.findUniqueOrThrow({ where: { orderId } });
    expect(Number(returned.totalRub)).toBe(3000);
    expect(returned.recalculatedAt!.getTime()).toBeGreaterThan(row.recalculatedAt!.getTime());
    expect((await svc.listPending(10, cursor)).items[0]).toMatchObject({
      document_number: before.number,
      cost: expect.objectContaining({ total_rub: 3000 }),
    });
  });

  test('D1-3/D1-10: прочий расход и строка логистики по READY-заказу пересобирают документ фоном', async () => {
    const orderId = await closedErpOrder(1);
    expect((await docOf(orderId)).cost.otherRub).toBe(0);

    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/extra-costs`)
      .set('Cookie', cookies.manager)
      .send({ description: 'Упаковка', amount: '200', currency: 'RUB', includeInCostPrice: true })
      .expect(201);
    await appDocuments().settleDeferredRefreshes();
    let row = await t.prisma.productionDocument.findUniqueOrThrow({ where: { orderId } });
    expect(Number(row.otherRub)).toBe(200);
    expect(row.recalculatedAt).toBeTruthy();

    // Расход НЕ в себестоимости факт не меняет — и документ не будит.
    const untouchedAt = row.recalculatedAt!.getTime();
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/extra-costs`)
      .set('Cookie', cookies.manager)
      .send({ description: 'Не в с/с', amount: '900', currency: 'RUB', includeInCostPrice: false })
      .expect(201);
    await appDocuments().settleDeferredRefreshes();
    row = await t.prisma.productionDocument.findUniqueOrThrow({ where: { orderId } });
    expect(Number(row.otherRub)).toBe(200);
    expect(row.recalculatedAt!.getTime()).toBe(untouchedAt);

    // Логистика — через настоящую ручку (D1-3) …
    const added = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/logistics-lines`)
      .set('Cookie', cookies.manager)
      .send({ name: 'Доставка ткани', costRub: '5000' })
      .expect(201);
    await appDocuments().settleDeferredRefreshes();
    row = await t.prisma.productionDocument.findUniqueOrThrow({ where: { orderId } });
    expect(Number(row.otherRub)).toBe(5200);
    expect(row.recalculatedAt!.getTime()).toBeGreaterThan(untouchedAt);

    // … и мимо ручки (ремонтный скрипт): её ловит ОТПЕЧАТОК при чтении (D1-10) — раньше
    // логистики в нём не было, и карточка показывала старое «прочее».
    const lines = (added.body.logisticsLines ?? []) as Array<{ id: string }>;
    expect(lines).toHaveLength(1);
    await t.prisma.orderLogisticsLine.update({
      where: { id: lines[0].id },
      data: { costRub: '7000' },
    });
    const doc = await docOf(orderId);
    expect(doc.cost.otherRub).toBe(7200);
    expect(doc.cost.totalRub).toBe(7200);
  });

  test('D1-3: отложенная сверка по отпечатку (путь утверждения начислений) — дедуп и пропуск, когда факты те же', async () => {
    const orderId = await closedErpOrder(1);
    expect((await docOf(orderId)).status).toBe('READY');
    const documents = buildProductionDocumentsService(t);

    // Факты не менялись — сверка по отпечатку молчит, recalculatedAt не появляется.
    documents.refreshLater(orderId, { source: 'test', whenStale: true, delayMs: 10 });
    documents.refreshLater(orderId, { source: 'test', whenStale: true, delayMs: 10 });
    await documents.settleDeferredRefreshes();
    let row = await t.prisma.productionDocument.findUniqueOrThrow({ where: { orderId } });
    expect(row.recalculatedAt).toBeNull();

    // Начисление утверждено задним числом по упакованному паспорту — отпечаток разошёлся.
    const passport = await t.prisma.passport.findFirstOrThrow({ where: { orderId } });
    await t.prisma.operationEntry.create({
      data: {
        passportId: passport.id, operationId: Object.values(seed.operations)[0].id,
        employeeId: seed.employees.cutter.id, qty: 10, ratePerUnit: '10', amount: '100',
        status: 'APPROVED', approvedAt: new Date(),
      },
    });
    documents.refreshLater(orderId, { source: 'test', whenStale: true, delayMs: 10 });
    await documents.settleDeferredRefreshes();
    row = await t.prisma.productionDocument.findUniqueOrThrow({ where: { orderId } });
    expect(Number(row.pieceworkRub)).toBe(100);
    expect(Number(row.totalRub)).toBe(100);
    expect(row.recalculatedAt).toBeTruthy();
    // «Последний факт» — чем документ закрылся; поздняя пересборка его не переписывает.
    expect(row.lastFactKind).toBe('ORDER_CLOSED');
  });

  // ---------------------------------------------------------------------------
  // D1-2 / D1-12 — ответ ERP: фон в ack, предупреждения = пересборка
  // ---------------------------------------------------------------------------

  test('D1-2/D1-12: ack не пересобирает в ответе; ответ FAILED без денег меняет предупреждения и ставит recalculatedAt', async () => {
    const orderId = await closedErpOrder(1, { withNeeds: true });
    // Потребность под ERP: документ READY получает ERP_CONSUMPTION_PENDING — ответа ещё нет.
    const needs = await t.prisma.workshopNeed.updateMany({
      where: { orderId, materialRole: 'MAIN_FABRIC' },
      data: { erpManagedAt: new Date('2026-08-31T00:00:00.000Z'), erpNomenclatureId: 'nom-1' },
    });
    expect(needs.count).toBeGreaterThan(0);
    const documents = buildProductionDocumentsService(t);
    await documents.refresh(orderId);
    // Готов 05.09, ERP прочитала тогда же (курсор ушёл вперёд) — только это и ждёт ответа.
    await t.prisma.productionDocument.update({
      where: { orderId },
      data: { readyAt: new Date('2026-09-05T10:00:00.000Z'), recalculatedAt: null },
    });
    const pendingDoc = await t.prisma.productionDocument.findUniqueOrThrow({ where: { orderId } });
    expect(pendingDoc.status).toBe('READY');
    expect(pendingDoc.costWarnings).toContain('ERP_CONSUMPTION_PENDING');
    expect(pendingDoc.recalculatedAt).toBeNull();
    const passport = await t.prisma.passport.findFirstOrThrow({ where: { orderId } });

    // ERP не смогла списать (закрыт период): денег нет, меняются только предупреждения.
    const consumption = buildErpConsumptionService(t, documents);
    const ack = await consumption.ack([
      { passport_id: passport.id, state: 'FAILED', amount_rub: '0', uncovered_qty: '0', lines: [] },
    ]);
    expect(ack.accepted).toBe(1);
    // Ревью D1-2: ответ ушёл ДО пересборки — снимок в этот момент ещё старый.
    const inFlight = await t.prisma.productionDocument.findUniqueOrThrow({ where: { orderId } });
    expect(inFlight.costWarnings).toContain('ERP_CONSUMPTION_PENDING');
    await documents.settleDeferredRefreshes();

    const row = await t.prisma.productionDocument.findUniqueOrThrow({ where: { orderId } });
    expect(row.costWarnings).toContain('ERP_CONSUMPTION_FAILED');
    expect(row.costWarnings).not.toContain('ERP_CONSUMPTION_PENDING');
    expect(Number(row.totalRub)).toBe(Number(pendingDoc.totalRub));
    // Раньше здесь было `null`: сумма не изменилась → ERP никогда не перечитывала документ и
    // навсегда показывала «ERP ещё не ответила».
    expect(row.recalculatedAt).toBeTruthy();
    expect(row.recalcReason).toBe('Изменились предупреждения себестоимости');
    expect(row.lastFactKind).toBe('ORDER_CLOSED');

    // И очередь ERP с курсором за ready_at отдаёт документ повторно, с новыми предупреждениями.
    const queue = await buildErpProductionService(t, documents).listPending(
      10,
      '2026-09-06T00:00:00.000Z',
    );
    expect(queue.count).toBe(1);
    expect((queue.items[0] as Item).cost.warnings).toContain('ERP_CONSUMPTION_FAILED');
    expect((queue.items[0] as Item).queue_at).toBe(row.recalculatedAt!.toISOString());
  });
});
