/**
 * Integration-тесты hardening-итерации «Запрет отрицательных остатков
 * материалов при списании» (см. ТЗ,
 * `prisma/schema.prisma::CompanySettings.allowNegativeMaterialStock`,
 * `apps/api/src/modules/company-settings/company-settings.service.ts::getAllowNegativeMaterialStock`,
 * `apps/api/src/modules/stock/stock.service.ts::applyMovementInTx`,
 * `apps/api/src/modules/material-issues/material-issues.service.ts`,
 * `apps/api/src/common/errors.ts::MaterialStockInsufficientException`,
 * `docs/current-state.md §«Подключение расхода материалов к складу»`).
 *
 * Покрытие (номера совпадают с ТЗ §8 «Tests»):
 *
 *   1. allowNegativeMaterialStock missing settings row — считается
 *      true; MaterialIssue.post может увести остаток в минус.
 *   2. allowNegativeMaterialStock = true — post успешен, OUT создан,
 *      StockBalance.qty < 0.
 *   3. allowNegativeMaterialStock = false + достаточный остаток —
 *      post успешен, OUT создан, StockBalance.qty уменьшился.
 *   4. allowNegativeMaterialStock = false + недостаточный остаток —
 *      409 MATERIAL_STOCK_INSUFFICIENT; MaterialIssue остался DRAFT;
 *      StockMovement OUT не создан; StockBalance.qty не изменился.
 *   5. allowNegativeMaterialStock = false + explicit cellId — если в
 *      этой ячейке недостаточно, ошибка; другой баланс не используется.
 *   6. allowNegativeMaterialStock = false + no cellId — выбирается
 *      самый большой положительный balance с qty >= issuedQty; если
 *      такого нет, ошибка; no-location negative balance НЕ создаётся.
 *   7. allowNegativeMaterialStock = true + no positive balance —
 *      создаётся no-location negative balance, как раньше (regression).
 *   8. AUTO_CUT_ISSUE + false + достаточно остатка — issueToEmployee
 *      успешен, AUTO_CUT_ISSUE создан, StockMovement OUT создан.
 *   9. AUTO_CUT_ISSUE + false + недостаточно остатка — issueToEmployee
 *      ошибка; Passport не выдан; PassportEvent ISSUED_TO_EMPLOYEE
 *      не создан; AUTO_CUT_ISSUE не создан; StockMovement OUT не создан.
 *  10. autoIssueMaterialsOnCutRelease = false — флаг
 *      allowNegativeMaterialStock = false НЕ влияет на issueToEmployee;
 *      паспорт выдаётся; AUTO_CUT_ISSUE не создаётся.
 *  11. PurchaseReceipt cancellation остаётся permissive — при
 *      `false`-флаге cancel не блокируется, REVERSAL OUT уводит
 *      `StockBalance.qty` в минус (как раньше).
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

const COMPANY_SETTINGS_ID = 'default';

describeWithDb(
  'integration — material issues hardening «allowNegativeMaterialStock»',
  () => {
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
    });

    // -------------------------------------------------------------------------
    // helpers
    // -------------------------------------------------------------------------

    /**
     * Включить / отключить флаги hardening через прямую запись в БД.
     * PATCH `/api/company-settings` теперь принимает эти поля (см.
     * `docs/api.md §42` и блок «Материалы и склад» в
     * `/admin/company-settings`), но писать напрямую проще: тест
     * проверяет поведение `MaterialIssuesService` / `StockService`
     * и не должен зависеть от HTTP-слоя настроек.
     */
    async function setSettings(values: {
      allowNegativeMaterialStock?: boolean;
      autoIssueMaterialsOnCutRelease?: boolean;
    }): Promise<void> {
      await t.prisma.companySettings.upsert({
        where: { id: COMPANY_SETTINGS_ID },
        create: {
          id: COMPANY_SETTINGS_ID,
          singleton: true,
          allowNegativeMaterialStock:
            values.allowNegativeMaterialStock ?? true,
          autoIssueMaterialsOnCutRelease:
            values.autoIssueMaterialsOnCutRelease ?? false,
        },
        update: values,
      });
    }

    /**
     * Создаёт CONFIRMED `PurchaseOrder` с одной строкой
     * (RUB / 500.00 / qtyPlan), готов к POSTED-приёмкам.
     * См. идентичный helper в `tests/integration/material-issues-stock.test.ts`.
     */
    async function prepareConfirmedPo(opts?: {
      qtyPlan?: number;
      price?: string;
    }): Promise<{
      orderId: string;
      workshopNeedId: string;
      purchaseOrderId: string;
      purchaseOrderLineId: string;
    }> {
      const qtyPlan = opts?.qtyPlan ?? 10;
      const price = opts?.price ?? '500.00';

      const supplier = await request(t.app.getHttpServer())
        .post('/api/suppliers')
        .set('Cookie', cookies.manager)
        .send({ name: `Supplier-${Date.now()}-${Math.random()}` })
        .expect(201);

      const catalog = await request(t.app.getHttpServer())
        .post(`/api/suppliers/${supplier.body.id}/catalog`)
        .set('Cookie', cookies.manager)
        .send({
          name: 'Кулирка 180 г/м² чёрная',
          unit: 'м',
          lastPrice: price,
          currency: 'RUB',
        })
        .expect(201);

      const tcCode = `TC-HRD-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
      const tc = await request(t.app.getHttpServer())
        .post('/api/tech-cards')
        .set('Cookie', cookies.manager)
        .send({
          code: tcCode,
          name: tcCode,
          materialLines: [
            {
              name: 'Кулирка',
              unit: 'м',
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
          items: [{ sizeId: seed.sizes.M, qtyPlan }],
          techCardId: tc.body.id,
        })
        .expect(201);
      const orderId = order.body.id as string;

      const calc = await request(t.app.getHttpServer())
        .post(`/api/orders/${orderId}/workshop-needs/calculate`)
        .set('Cookie', cookies.manager)
        .send({})
        .expect(201);
      const workshopNeedId = calc.body.needs[0].id as string;

      await request(t.app.getHttpServer())
        .patch(`/api/workshop-needs/${workshopNeedId}`)
        .set('Cookie', cookies.manager)
        .send({
          selectedSupplierId: supplier.body.id,
          selectedSupplierCatalogItemId: catalog.body.id,
          purchaseQty: String(qtyPlan * 2),
          quotedPrice: price,
          quotedCurrency: 'RUB',
        })
        .expect(200);

      const po = await request(t.app.getHttpServer())
        .post('/api/purchase-orders/from-needs')
        .set('Cookie', cookies.manager)
        .send({ workshopNeedIds: [workshopNeedId] })
        .expect(201);
      const purchaseOrderId = po.body.id as string;
      const purchaseOrderLineId = po.body.lines[0].id as string;

      await request(t.app.getHttpServer())
        .post(`/api/purchase-orders/${purchaseOrderId}/send`)
        .set('Cookie', cookies.manager)
        .expect(201);
      await request(t.app.getHttpServer())
        .post(`/api/purchase-orders/${purchaseOrderId}/confirm`)
        .set('Cookie', cookies.manager)
        .send({})
        .expect(201);

      return { orderId, workshopNeedId, purchaseOrderId, purchaseOrderLineId };
    }

    async function postReceipt(opts: {
      purchaseOrderId: string;
      purchaseOrderLineId: string;
      receivedQty: string;
      cellId?: string | null;
    }): Promise<{ receiptId: string; receiptLineId: string }> {
      const r = await request(t.app.getHttpServer())
        .post('/api/purchase-receipts/from-purchase-order')
        .set('Cookie', cookies.manager)
        .send({
          purchaseOrderId: opts.purchaseOrderId,
          lines: [
            {
              purchaseOrderLineId: opts.purchaseOrderLineId,
              receivedQty: opts.receivedQty,
              ...(opts.cellId ? { cellId: opts.cellId } : {}),
            },
          ],
        })
        .expect(201);
      return {
        receiptId: r.body.id as string,
        receiptLineId: r.body.lines[0].id as string,
      };
    }

    async function createDraftIssue(opts: {
      orderId: string;
      workshopNeedId: string;
      issuedQty: string;
      unitCost?: string;
      cellId?: string | null;
    }): Promise<{ issueId: string; lineId: string }> {
      const res = await request(t.app.getHttpServer())
        .post('/api/material-issues')
        .set('Cookie', cookies.manager)
        .send({
          orderId: opts.orderId,
          lines: [
            {
              workshopNeedId: opts.workshopNeedId,
              issuedQty: opts.issuedQty,
              unitCost: opts.unitCost ?? '0',
              ...(opts.cellId ? { cellId: opts.cellId } : {}),
            },
          ],
        })
        .expect(201);
      return {
        issueId: res.body.id as string,
        lineId: res.body.lines[0].id as string,
      };
    }

    // =========================================================================
    // 1. Свежая БД без CompanySettings — флаг считается true.
    // =========================================================================

    test('настроек ещё нет → backend трактует allowNegativeMaterialStock как true (минус допустим)', async () => {
      // НЕ вызываем setSettings — singleton-row нет.
      const fx = await prepareConfirmedPo();
      // Никаких приёмок — баланса нет вообще.

      const { issueId, lineId } = await createDraftIssue({
        orderId: fx.orderId,
        workshopNeedId: fx.workshopNeedId,
        issuedQty: '3',
        unitCost: '100',
      });

      await request(t.app.getHttpServer())
        .post(`/api/material-issues/${issueId}/post`)
        .set('Cookie', cookies.manager)
        .expect(201);

      const movement = await t.prisma.stockMovement.findFirstOrThrow({
        where: { materialIssueLineId: lineId },
      });
      expect(movement.direction).toBe('OUT');
      // No-location negative balance.
      expect(movement.warehouseId).toBeNull();
      expect(movement.cellId).toBeNull();

      const balance = await t.prisma.stockBalance.findFirstOrThrow({
        where: { workshopNeedId: fx.workshopNeedId },
      });
      expect(new Prisma.Decimal(balance.qty).toString()).toBe('-3');

      // Singleton-row остаётся не созданной — backend.SELECT не пишет.
      const settings = await t.prisma.companySettings.findUnique({
        where: { id: COMPANY_SETTINGS_ID },
      });
      expect(settings).toBeNull();
    });

    // =========================================================================
    // 2. allowNegativeMaterialStock = true — текущее поведение сохраняется.
    // =========================================================================

    test('allowNegativeMaterialStock = true → MaterialIssue.post может увести StockBalance.qty в минус', async () => {
      await setSettings({ allowNegativeMaterialStock: true });
      const fx = await prepareConfirmedPo();
      await postReceipt({
        purchaseOrderId: fx.purchaseOrderId,
        purchaseOrderLineId: fx.purchaseOrderLineId,
        receivedQty: '2',
        cellId: seed.cells.A1.id,
      });

      // Списываем больше, чем есть — должно пройти.
      const { issueId, lineId } = await createDraftIssue({
        orderId: fx.orderId,
        workshopNeedId: fx.workshopNeedId,
        issuedQty: '5',
        unitCost: '100',
        cellId: seed.cells.A1.id,
      });
      await request(t.app.getHttpServer())
        .post(`/api/material-issues/${issueId}/post`)
        .set('Cookie', cookies.manager)
        .expect(201);

      const movement = await t.prisma.stockMovement.findFirstOrThrow({
        where: { materialIssueLineId: lineId },
      });
      expect(movement.direction).toBe('OUT');
      const balance = await t.prisma.stockBalance.findFirstOrThrow({
        where: { workshopNeedId: fx.workshopNeedId, cellId: seed.cells.A1.id },
      });
      expect(new Prisma.Decimal(balance.qty).toString()).toBe('-3');
    });

    // =========================================================================
    // 3. false + достаточный остаток — happy path.
    // =========================================================================

    test('false + достаточный остаток → MaterialIssue.post успешен, StockBalance.qty уменьшился', async () => {
      await setSettings({ allowNegativeMaterialStock: false });
      const fx = await prepareConfirmedPo();
      await postReceipt({
        purchaseOrderId: fx.purchaseOrderId,
        purchaseOrderLineId: fx.purchaseOrderLineId,
        receivedQty: '10',
        cellId: seed.cells.A1.id,
      });

      const { issueId, lineId } = await createDraftIssue({
        orderId: fx.orderId,
        workshopNeedId: fx.workshopNeedId,
        issuedQty: '4',
        unitCost: '100',
        cellId: seed.cells.A1.id,
      });
      await request(t.app.getHttpServer())
        .post(`/api/material-issues/${issueId}/post`)
        .set('Cookie', cookies.manager)
        .expect(201);

      const issue = await t.prisma.materialIssue.findUniqueOrThrow({
        where: { id: issueId },
      });
      expect(issue.status).toBe('POSTED');
      const movement = await t.prisma.stockMovement.findFirstOrThrow({
        where: { materialIssueLineId: lineId },
      });
      expect(movement.direction).toBe('OUT');
      const balance = await t.prisma.stockBalance.findFirstOrThrow({
        where: { workshopNeedId: fx.workshopNeedId, cellId: seed.cells.A1.id },
      });
      expect(new Prisma.Decimal(balance.qty).toString()).toBe('6');
    });

    // =========================================================================
    // 4. false + недостаточный остаток — 409, всё откатывается.
    // =========================================================================

    test('false + недостаточный остаток → 409 MATERIAL_STOCK_INSUFFICIENT, MaterialIssue остаётся DRAFT, склад не меняется', async () => {
      await setSettings({ allowNegativeMaterialStock: false });
      const fx = await prepareConfirmedPo();
      await postReceipt({
        purchaseOrderId: fx.purchaseOrderId,
        purchaseOrderLineId: fx.purchaseOrderLineId,
        receivedQty: '2',
        cellId: seed.cells.A1.id,
      });

      const { issueId, lineId } = await createDraftIssue({
        orderId: fx.orderId,
        workshopNeedId: fx.workshopNeedId,
        issuedQty: '5',
        unitCost: '100',
        cellId: seed.cells.A1.id,
      });

      const res = await request(t.app.getHttpServer())
        .post(`/api/material-issues/${issueId}/post`)
        .set('Cookie', cookies.manager)
        .expect(409);
      expect(res.body.code).toBe('MATERIAL_STOCK_INSUFFICIENT');
      expect(res.body.details).toMatchObject({
        workshopNeedId: fx.workshopNeedId,
        cellId: seed.cells.A1.id,
        unit: 'м',
      });
      expect(res.body.details.requestedQty).toBe('5');
      expect(res.body.details.availableQty).toBe('2');

      // Документ остался DRAFT.
      const issue = await t.prisma.materialIssue.findUniqueOrThrow({
        where: { id: issueId },
      });
      expect(issue.status).toBe('DRAFT');
      // OUT не создался.
      const movements = await t.prisma.stockMovement.findMany({
        where: { materialIssueLineId: lineId },
      });
      expect(movements).toHaveLength(0);
      // Баланс не изменился.
      const balance = await t.prisma.stockBalance.findFirstOrThrow({
        where: { workshopNeedId: fx.workshopNeedId, cellId: seed.cells.A1.id },
      });
      expect(new Prisma.Decimal(balance.qty).toString()).toBe('2');
    });

    // =========================================================================
    // 5. false + explicit cellId — другой баланс не используется.
    // =========================================================================

    test('false + explicit cellId → проверяется именно эта ячейка, другой баланс не используется', async () => {
      await setSettings({ allowNegativeMaterialStock: false });
      const fx = await prepareConfirmedPo();
      // В A1 пусто (никаких приёмок), в A2 есть 10.
      await postReceipt({
        purchaseOrderId: fx.purchaseOrderId,
        purchaseOrderLineId: fx.purchaseOrderLineId,
        receivedQty: '10',
        cellId: seed.cells.A2.id,
      });

      const { issueId, lineId } = await createDraftIssue({
        orderId: fx.orderId,
        workshopNeedId: fx.workshopNeedId,
        issuedQty: '3',
        unitCost: '100',
        cellId: seed.cells.A1.id,
      });
      const res = await request(t.app.getHttpServer())
        .post(`/api/material-issues/${issueId}/post`)
        .set('Cookie', cookies.manager)
        .expect(409);
      expect(res.body.code).toBe('MATERIAL_STOCK_INSUFFICIENT');
      expect(res.body.details.cellId).toBe(seed.cells.A1.id);
      // availableQty в A1 = 0 (баланса там нет вообще).
      expect(res.body.details.availableQty).toBe('0');

      // OUT по строке не создан.
      const movements = await t.prisma.stockMovement.findMany({
        where: { materialIssueLineId: lineId },
      });
      expect(movements).toHaveLength(0);
      // Баланс A2 не тронут.
      const balanceA2 = await t.prisma.stockBalance.findFirstOrThrow({
        where: { workshopNeedId: fx.workshopNeedId, cellId: seed.cells.A2.id },
      });
      expect(new Prisma.Decimal(balanceA2.qty).toString()).toBe('10');
    });

    // =========================================================================
    // 6. false + no cellId — strict largest-positive поиск.
    // =========================================================================

    test('false + no cellId + largest positive >= issuedQty → списывается с него', async () => {
      await setSettings({ allowNegativeMaterialStock: false });
      const fx = await prepareConfirmedPo();
      await postReceipt({
        purchaseOrderId: fx.purchaseOrderId,
        purchaseOrderLineId: fx.purchaseOrderLineId,
        receivedQty: '4',
        cellId: seed.cells.A1.id,
      });
      await postReceipt({
        purchaseOrderId: fx.purchaseOrderId,
        purchaseOrderLineId: fx.purchaseOrderLineId,
        receivedQty: '7',
        cellId: seed.cells.A2.id,
      });

      const { issueId, lineId } = await createDraftIssue({
        orderId: fx.orderId,
        workshopNeedId: fx.workshopNeedId,
        issuedQty: '5',
        unitCost: '100',
      });
      await request(t.app.getHttpServer())
        .post(`/api/material-issues/${issueId}/post`)
        .set('Cookie', cookies.manager)
        .expect(201);

      const movement = await t.prisma.stockMovement.findFirstOrThrow({
        where: { materialIssueLineId: lineId },
      });
      // Самый большой положительный — A2 (7 >= 5).
      expect(movement.cellId).toBe(seed.cells.A2.id);
      const balanceA2 = await t.prisma.stockBalance.findFirstOrThrow({
        where: { workshopNeedId: fx.workshopNeedId, cellId: seed.cells.A2.id },
      });
      expect(new Prisma.Decimal(balanceA2.qty).toString()).toBe('2');
    });

    test('false + no cellId + ни один балас не покрывает issuedQty → 409, no-location negative balance НЕ создаётся', async () => {
      await setSettings({ allowNegativeMaterialStock: false });
      const fx = await prepareConfirmedPo();
      await postReceipt({
        purchaseOrderId: fx.purchaseOrderId,
        purchaseOrderLineId: fx.purchaseOrderLineId,
        receivedQty: '4',
        cellId: seed.cells.A1.id,
      });
      await postReceipt({
        purchaseOrderId: fx.purchaseOrderId,
        purchaseOrderLineId: fx.purchaseOrderLineId,
        receivedQty: '3',
        cellId: seed.cells.A2.id,
      });

      const { issueId, lineId } = await createDraftIssue({
        orderId: fx.orderId,
        workshopNeedId: fx.workshopNeedId,
        // 5 > max(4, 3) — НИ один балас не покрывает целиком.
        // Дробление между балансами на MVP сознательно НЕ делаем.
        issuedQty: '5',
        unitCost: '100',
      });
      const res = await request(t.app.getHttpServer())
        .post(`/api/material-issues/${issueId}/post`)
        .set('Cookie', cookies.manager)
        .expect(409);
      expect(res.body.code).toBe('MATERIAL_STOCK_INSUFFICIENT');
      // availableQty = max(4,3) = 4 (диагностика для UI / клиента).
      expect(res.body.details.availableQty).toBe('4');

      // Старые балансы не тронуты.
      const balanceA1 = await t.prisma.stockBalance.findFirstOrThrow({
        where: { workshopNeedId: fx.workshopNeedId, cellId: seed.cells.A1.id },
      });
      const balanceA2 = await t.prisma.stockBalance.findFirstOrThrow({
        where: { workshopNeedId: fx.workshopNeedId, cellId: seed.cells.A2.id },
      });
      expect(new Prisma.Decimal(balanceA1.qty).toString()).toBe('4');
      expect(new Prisma.Decimal(balanceA2.qty).toString()).toBe('3');
      // No-location negative balance НЕ создан.
      const noLocation = await t.prisma.stockBalance.findFirst({
        where: {
          workshopNeedId: fx.workshopNeedId,
          warehouseId: null,
          cellId: null,
        },
      });
      expect(noLocation).toBeNull();
      // OUT-движение не создалось.
      expect(
        await t.prisma.stockMovement.count({
          where: { materialIssueLineId: lineId },
        }),
      ).toBe(0);
    });

    // =========================================================================
    // 7. true + нет положительного баланса → no-location negative (regression).
    // =========================================================================

    test('true + нет положительного баланса → создаётся no-location negative balance (как раньше)', async () => {
      await setSettings({ allowNegativeMaterialStock: true });
      const fx = await prepareConfirmedPo();
      // Никаких приёмок — баланса нет.

      const { issueId, lineId } = await createDraftIssue({
        orderId: fx.orderId,
        workshopNeedId: fx.workshopNeedId,
        issuedQty: '4',
        unitCost: '100',
      });
      await request(t.app.getHttpServer())
        .post(`/api/material-issues/${issueId}/post`)
        .set('Cookie', cookies.manager)
        .expect(201);

      const balance = await t.prisma.stockBalance.findFirstOrThrow({
        where: {
          workshopNeedId: fx.workshopNeedId,
          warehouseId: null,
          cellId: null,
        },
      });
      expect(new Prisma.Decimal(balance.qty).toString()).toBe('-4');
      const movement = await t.prisma.stockMovement.findFirstOrThrow({
        where: { materialIssueLineId: lineId },
      });
      expect(movement.warehouseId).toBeNull();
      expect(movement.cellId).toBeNull();
    });

    // =========================================================================
    // AUTO_CUT_ISSUE сценарии (8, 9, 10) — общий setup паспорта.
    // =========================================================================

    /**
     * Подготавливает заказ + паспорт для теста AUTO_CUT_ISSUE.
     * Возвращает orderId / passportId / workshopNeedId — обязателен
     * предварительный `setSettings({autoIssueMaterialsOnCutRelease: true})`,
     * если хочется получить авто-документ.
     */
    async function preparePassportForAutoCut(opts: {
      qtyPlan: number;
      qtyCut: number;
      receivedQty?: string | null;
      receivedToCellId?: string | null;
    }): Promise<{
      orderId: string;
      passportId: string;
      workshopNeedId: string;
    }> {
      const fx = await prepareConfirmedPo({ qtyPlan: opts.qtyPlan });
      if (opts.receivedQty) {
        await postReceipt({
          purchaseOrderId: fx.purchaseOrderId,
          purchaseOrderLineId: fx.purchaseOrderLineId,
          receivedQty: opts.receivedQty,
          cellId: opts.receivedToCellId ?? seed.cells.A1.id,
        });
      }

      await request(t.app.getHttpServer())
        .post(`/api/orders/${fx.orderId}/start`)
        .set('Cookie', cookies.manager)
        .send({})
        .expect(201);

      const passport = await request(t.app.getHttpServer())
        .post('/api/passports')
        .set('Cookie', cookies.manager)
        .send({
          orderId: fx.orderId,
          sizeId: seed.sizes.M,
          rollNumber: `R-HRD-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
          cutDate: '2026-04-15T00:00:00.000Z',
          qtyCut: opts.qtyCut,
          cutterId: seed.employees.cutter.id,
        })
        .expect(201);
      const passportId = passport.body.id as string;

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

      return {
        orderId: fx.orderId,
        passportId,
        workshopNeedId: fx.workshopNeedId,
      };
    }

    // =========================================================================
    // 8. AUTO_CUT_ISSUE + false + достаточно остатка — happy path.
    // =========================================================================

    test('AUTO_CUT_ISSUE + false + достаточно остатка → issueToEmployee успешен, AUTO_CUT_ISSUE создан, OUT записан', async () => {
      await setSettings({
        allowNegativeMaterialStock: false,
        autoIssueMaterialsOnCutRelease: true,
      });
      // qtyPlan=10, qtyCut=4, calculatedQty=0.5*10=5; issuedQty = 5*4/10 = 2.
      // Положим в A1 ровно 5 м — больше, чем requested.
      const setup = await preparePassportForAutoCut({
        qtyPlan: 10,
        qtyCut: 4,
        receivedQty: '5',
        receivedToCellId: seed.cells.A1.id,
      });

      await request(t.app.getHttpServer())
        .post(`/api/passports/${setup.passportId}/issue`)
        .set('Cookie', cookies.seamstress)
        .send({})
        .expect(201);

      const auto = await t.prisma.materialIssue.findFirstOrThrow({
        where: { passportId: setup.passportId, source: 'AUTO_CUT_ISSUE' },
        include: { lines: true },
      });
      expect(auto.status).toBe('POSTED');
      expect(auto.lines).toHaveLength(1);

      const movements = await t.prisma.stockMovement.findMany({
        where: { materialIssueId: auto.id },
      });
      expect(movements).toHaveLength(1);
      expect(movements[0]!.direction).toBe('OUT');
      // Списано из самого большого положительного баланса (A1 — единственный).
      expect(movements[0]!.cellId).toBe(seed.cells.A1.id);

      const balance = await t.prisma.stockBalance.findFirstOrThrow({
        where: { workshopNeedId: setup.workshopNeedId, cellId: seed.cells.A1.id },
      });
      // Было 5, списали 2 → осталось 3.
      expect(new Prisma.Decimal(balance.qty).toString()).toBe('3');
    });

    // =========================================================================
    // 9. AUTO_CUT_ISSUE + false + недостаточно — issueToEmployee откатывается.
    // =========================================================================

    test('AUTO_CUT_ISSUE + false + недостаточно остатка → issueToEmployee 409, паспорт не выдан, AUTO_CUT_ISSUE и OUT не созданы', async () => {
      await setSettings({
        allowNegativeMaterialStock: false,
        autoIssueMaterialsOnCutRelease: true,
      });
      // qtyPlan=10, qtyCut=4 → issuedQty = 2. Дадим всего 1 м — не хватит.
      const setup = await preparePassportForAutoCut({
        qtyPlan: 10,
        qtyCut: 4,
        receivedQty: '1',
        receivedToCellId: seed.cells.A1.id,
      });

      const beforePassport = await t.prisma.passport.findUniqueOrThrow({
        where: { id: setup.passportId },
        select: { status: true, currentEmployeeId: true },
      });

      const res = await request(t.app.getHttpServer())
        .post(`/api/passports/${setup.passportId}/issue`)
        .set('Cookie', cookies.seamstress)
        .send({})
        .expect(409);
      expect(res.body.code).toBe('MATERIAL_STOCK_INSUFFICIENT');

      // Паспорт не сменил статус и не уехал к швее.
      const afterPassport = await t.prisma.passport.findUniqueOrThrow({
        where: { id: setup.passportId },
        select: { status: true, currentEmployeeId: true },
      });
      expect(afterPassport.status).toBe(beforePassport.status);
      expect(afterPassport.currentEmployeeId).toBe(
        beforePassport.currentEmployeeId,
      );

      // PassportEvent ISSUED_TO_EMPLOYEE НЕ создан.
      const issuedEvents = await t.prisma.passportEvent.count({
        where: { passportId: setup.passportId, type: 'ISSUED_TO_EMPLOYEE' },
      });
      expect(issuedEvents).toBe(0);

      // AUTO_CUT_ISSUE НЕ создан.
      const auto = await t.prisma.materialIssue.findFirst({
        where: { passportId: setup.passportId, source: 'AUTO_CUT_ISSUE' },
      });
      expect(auto).toBeNull();

      // StockMovement OUT по этому workshopNeed не пишется.
      const outCount = await t.prisma.stockMovement.count({
        where: {
          workshopNeedId: setup.workshopNeedId,
          direction: 'OUT',
        },
      });
      expect(outCount).toBe(0);

      // Баланс не тронут.
      const balance = await t.prisma.stockBalance.findFirstOrThrow({
        where: {
          workshopNeedId: setup.workshopNeedId,
          cellId: seed.cells.A1.id,
        },
      });
      expect(new Prisma.Decimal(balance.qty).toString()).toBe('1');
    });

    // =========================================================================
    // 10. autoIssueMaterialsOnCutRelease = false → флаг не влияет.
    // =========================================================================

    test('autoIssueMaterialsOnCutRelease = false → allowNegativeMaterialStock = false НЕ влияет на issueToEmployee', async () => {
      await setSettings({
        allowNegativeMaterialStock: false,
        autoIssueMaterialsOnCutRelease: false,
      });
      // Баланса намеренно нет — но автосписание выключено, флаг
      // отрицательных остатков не должен трогать выдачу кроя.
      const setup = await preparePassportForAutoCut({
        qtyPlan: 10,
        qtyCut: 4,
        receivedQty: null,
      });

      await request(t.app.getHttpServer())
        .post(`/api/passports/${setup.passportId}/issue`)
        .set('Cookie', cookies.seamstress)
        .send({})
        .expect(201);

      // AUTO_CUT_ISSUE НЕ создаётся (автосписание выключено).
      const auto = await t.prisma.materialIssue.findFirst({
        where: { passportId: setup.passportId, source: 'AUTO_CUT_ISSUE' },
      });
      expect(auto).toBeNull();

      // OUT-движений нет (склад не трогали).
      const outCount = await t.prisma.stockMovement.count({
        where: {
          workshopNeedId: setup.workshopNeedId,
          direction: 'OUT',
        },
      });
      expect(outCount).toBe(0);
    });

    // =========================================================================
    // 11. PurchaseReceipt cancellation остаётся permissive при false.
    // =========================================================================

    test('PurchaseReceipt cancel permissive при false: REVERSAL OUT уводит StockBalance.qty в минус', async () => {
      // 1) Кладём материал на склад.
      await setSettings({ allowNegativeMaterialStock: true });
      const fx = await prepareConfirmedPo();
      const { receiptId } = await postReceipt({
        purchaseOrderId: fx.purchaseOrderId,
        purchaseOrderLineId: fx.purchaseOrderLineId,
        receivedQty: '5',
        cellId: seed.cells.A1.id,
      });

      // 2) Списываем 4 м (минус 4 от прихода — баланс становится 1).
      const { issueId } = await createDraftIssue({
        orderId: fx.orderId,
        workshopNeedId: fx.workshopNeedId,
        issuedQty: '4',
        unitCost: '100',
        cellId: seed.cells.A1.id,
      });
      await request(t.app.getHttpServer())
        .post(`/api/material-issues/${issueId}/post`)
        .set('Cookie', cookies.manager)
        .expect(201);

      // 3) Включаем strict-режим и отменяем приёмку. REVERSAL OUT
      //    должен пройти и увести баланс в минус (cancel остаётся
      //    permissive — флаг применяется только к MaterialIssue OUT,
      //    не к PurchaseReceipt reversal).
      await setSettings({ allowNegativeMaterialStock: false });
      await request(t.app.getHttpServer())
        .post(`/api/purchase-receipts/${receiptId}/cancel`)
        .set('Cookie', cookies.manager)
        .send({ reason: 'тест permissive cancel' })
        .expect(201);

      const balance = await t.prisma.stockBalance.findFirstOrThrow({
        where: { workshopNeedId: fx.workshopNeedId, cellId: seed.cells.A1.id },
      });
      // Было 1 (после issue), reversal -5 → -4.
      expect(new Prisma.Decimal(balance.qty).toString()).toBe('-4');
      const reversal = await t.prisma.stockMovement.findFirstOrThrow({
        where: {
          purchaseReceiptId: receiptId,
          direction: 'OUT',
          type: 'REVERSAL',
        },
      });
      expect(reversal.cellId).toBe(seed.cells.A1.id);
    });
  },
);
