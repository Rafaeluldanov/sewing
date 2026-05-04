/**
 * Integration-тесты итерации «Division overrides для флагов блока
 * „Материалы и склад“»
 * (см. ТЗ,
 * `prisma/schema.prisma::CompanyDivision.{autoIssueMaterialsOnCutReleaseOverride, allowNegativeMaterialStockOverride}`,
 * `apps/api/src/modules/company-settings/company-settings.service.ts::getEffectiveMaterialStockSettingsForOrder`,
 * `apps/api/src/modules/material-issues/material-issues.service.ts`,
 * `apps/api/src/modules/stock/stock.service.ts::createAdjustment`,
 * `apps/api/src/modules/passports/passports.service.ts::issueToEmployee`,
 * `docs/current-state.md §«Материалы и склад — division overrides»`).
 *
 * Покрытие (ТЗ §11):
 *
 *   1. division override autoIssue=true при global=false: issueToEmployee
 *      создаёт AUTO_CUT_ISSUE.
 *   2. division override autoIssue=false при global=true: issueToEmployee
 *      НЕ создаёт AUTO_CUT_ISSUE.
 *   3. division override autoIssue=null: используется global
 *      autoIssueMaterialsOnCutRelease.
 *   4. division override allowNegative=false при global=true:
 *      MaterialIssue.post блокируется при недостатке.
 *   5. division override allowNegative=true при global=false:
 *      MaterialIssue.post может увести остаток в минус.
 *   6. order без division: используются глобальные настройки.
 *   7. StockAdjustment OUT использует division allowNegativeMaterialStock.
 *   8. PurchaseReceipt cancel не зависит от division settings
 *      (остаётся permissive).
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
  'integration — CompanyDivision material stock overrides',
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

    async function setCompanySettings(values: {
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

    async function setDivisionOverride(
      divisionId: string,
      values: {
        autoIssueMaterialsOnCutReleaseOverride?: boolean | null;
        allowNegativeMaterialStockOverride?: boolean | null;
      },
    ): Promise<void> {
      await t.prisma.companyDivision.update({
        where: { id: divisionId },
        data: values,
      });
    }

    async function prepareConfirmedPo(opts?: {
      qtyPlan?: number;
      price?: string;
      companyDivisionId?: string | null;
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

      const tcCode = `TC-DIV-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
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

      const orderPayload: Record<string, unknown> = {
        orderDate: '2026-04-15T00:00:00.000Z',
        productId: seed.product.id,
        color: 'Чёрный',
        items: [{ sizeId: seed.sizes.M, qtyPlan }],
        techCardId: tc.body.id,
      };
      if (opts?.companyDivisionId !== undefined) {
        orderPayload.companyDivisionId = opts.companyDivisionId;
      }

      const order = await request(t.app.getHttpServer())
        .post('/api/orders')
        .set('Cookie', cookies.manager)
        .send(orderPayload)
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

    async function preparePassportForAutoCut(opts: {
      qtyPlan: number;
      qtyCut: number;
      companyDivisionId?: string | null;
      receivedQty?: string | null;
      receivedToCellId?: string | null;
    }): Promise<{
      orderId: string;
      passportId: string;
      workshopNeedId: string;
    }> {
      const fx = await prepareConfirmedPo({
        qtyPlan: opts.qtyPlan,
        companyDivisionId: opts.companyDivisionId,
      });
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
          rollNumber: `R-DIV-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
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
    // 1. autoIssue override=true при global=false → AUTO_CUT_ISSUE создаётся
    // =========================================================================

    test('division.autoIssueMaterialsOnCutReleaseOverride=true при global=false → issueToEmployee создаёт AUTO_CUT_ISSUE', async () => {
      await setCompanySettings({ autoIssueMaterialsOnCutRelease: false });
      await setDivisionOverride(seed.companyDivisions.OTHER.id, {
        autoIssueMaterialsOnCutReleaseOverride: true,
      });
      const setup = await preparePassportForAutoCut({
        qtyPlan: 10,
        qtyCut: 4,
        companyDivisionId: seed.companyDivisions.OTHER.id,
        receivedQty: '10',
        receivedToCellId: seed.cells.A1.id,
      });

      await request(t.app.getHttpServer())
        .post(`/api/passports/${setup.passportId}/issue`)
        .set('Cookie', cookies.seamstress)
        .send({})
        .expect(201);

      const auto = await t.prisma.materialIssue.findFirst({
        where: { passportId: setup.passportId, source: 'AUTO_CUT_ISSUE' },
      });
      expect(auto).not.toBeNull();
      expect(auto?.status).toBe('POSTED');
    });

    // =========================================================================
    // 2. autoIssue override=false при global=true → AUTO_CUT_ISSUE НЕ создаётся
    // =========================================================================

    test('division.autoIssueMaterialsOnCutReleaseOverride=false при global=true → AUTO_CUT_ISSUE не создаётся', async () => {
      await setCompanySettings({ autoIssueMaterialsOnCutRelease: true });
      await setDivisionOverride(seed.companyDivisions.OTHER.id, {
        autoIssueMaterialsOnCutReleaseOverride: false,
      });
      const setup = await preparePassportForAutoCut({
        qtyPlan: 10,
        qtyCut: 4,
        companyDivisionId: seed.companyDivisions.OTHER.id,
        receivedQty: '10',
        receivedToCellId: seed.cells.A1.id,
      });

      await request(t.app.getHttpServer())
        .post(`/api/passports/${setup.passportId}/issue`)
        .set('Cookie', cookies.seamstress)
        .send({})
        .expect(201);

      const auto = await t.prisma.materialIssue.findFirst({
        where: { passportId: setup.passportId, source: 'AUTO_CUT_ISSUE' },
      });
      expect(auto).toBeNull();

      // Сама выдача кроя успешна — статус паспорта IN_PROGRESS.
      const passport = await t.prisma.passport.findUniqueOrThrow({
        where: { id: setup.passportId },
      });
      expect(passport.status).toBe('IN_PROGRESS');
    });

    // =========================================================================
    // 3. autoIssue override=null → используется global autoIssue
    // =========================================================================

    test('division.autoIssueMaterialsOnCutReleaseOverride=null → используется global autoIssueMaterialsOnCutRelease', async () => {
      await setCompanySettings({ autoIssueMaterialsOnCutRelease: true });
      // Явно null — «наследовать».
      await setDivisionOverride(seed.companyDivisions.OTHER.id, {
        autoIssueMaterialsOnCutReleaseOverride: null,
      });
      const setup = await preparePassportForAutoCut({
        qtyPlan: 10,
        qtyCut: 4,
        companyDivisionId: seed.companyDivisions.OTHER.id,
        receivedQty: '10',
        receivedToCellId: seed.cells.A1.id,
      });

      await request(t.app.getHttpServer())
        .post(`/api/passports/${setup.passportId}/issue`)
        .set('Cookie', cookies.seamstress)
        .send({})
        .expect(201);

      const auto = await t.prisma.materialIssue.findFirst({
        where: { passportId: setup.passportId, source: 'AUTO_CUT_ISSUE' },
      });
      expect(auto).not.toBeNull();
    });

    // =========================================================================
    // 4. allowNegative override=false при global=true → post блокируется
    // =========================================================================

    test('division.allowNegativeMaterialStockOverride=false при global=true → MaterialIssue.post блокируется при недостатке', async () => {
      await setCompanySettings({ allowNegativeMaterialStock: true });
      await setDivisionOverride(seed.companyDivisions.OTHER.id, {
        allowNegativeMaterialStockOverride: false,
      });
      const fx = await prepareConfirmedPo({
        companyDivisionId: seed.companyDivisions.OTHER.id,
      });
      // Кладём всего 1 м, запрашиваем 5 — нехватка.
      await postReceipt({
        purchaseOrderId: fx.purchaseOrderId,
        purchaseOrderLineId: fx.purchaseOrderLineId,
        receivedQty: '1',
        cellId: seed.cells.A1.id,
      });
      const { issueId } = await createDraftIssue({
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

      const issue = await t.prisma.materialIssue.findUniqueOrThrow({
        where: { id: issueId },
      });
      expect(issue.status).toBe('DRAFT');
    });

    // =========================================================================
    // 5. allowNegative override=true при global=false → минус допустим
    // =========================================================================

    test('division.allowNegativeMaterialStockOverride=true при global=false → MaterialIssue.post может увести остаток в минус', async () => {
      await setCompanySettings({ allowNegativeMaterialStock: false });
      await setDivisionOverride(seed.companyDivisions.OTHER.id, {
        allowNegativeMaterialStockOverride: true,
      });
      const fx = await prepareConfirmedPo({
        companyDivisionId: seed.companyDivisions.OTHER.id,
      });
      await postReceipt({
        purchaseOrderId: fx.purchaseOrderId,
        purchaseOrderLineId: fx.purchaseOrderLineId,
        receivedQty: '1',
        cellId: seed.cells.A1.id,
      });
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
      expect(new Prisma.Decimal(balance.qty).toString()).toBe('-4');
    });

    // =========================================================================
    // 6. order без division → используются глобальные настройки
    // =========================================================================

    test('order.companyDivisionId=null → effective = global CompanySettings (division override не применяется)', async () => {
      await setCompanySettings({ allowNegativeMaterialStock: false });
      // Оба division override-ы стоят на разрешение минуса — это не
      // должно влиять, потому что у заказа нет division.
      await setDivisionOverride(seed.companyDivisions.OTHER.id, {
        allowNegativeMaterialStockOverride: true,
      });
      await setDivisionOverride(seed.companyDivisions.MARKETPLACE.id, {
        allowNegativeMaterialStockOverride: true,
      });
      const fx = await prepareConfirmedPo({ companyDivisionId: null });
      await postReceipt({
        purchaseOrderId: fx.purchaseOrderId,
        purchaseOrderLineId: fx.purchaseOrderLineId,
        receivedQty: '1',
        cellId: seed.cells.A1.id,
      });
      const { issueId } = await createDraftIssue({
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
    });

    // =========================================================================
    // 7. StockAdjustment OUT использует division allowNegativeMaterialStock
    // =========================================================================

    test('StockAdjustment OUT уважает division.allowNegativeMaterialStockOverride (blocked at division level)', async () => {
      await setCompanySettings({ allowNegativeMaterialStock: true });
      await setDivisionOverride(seed.companyDivisions.OTHER.id, {
        allowNegativeMaterialStockOverride: false,
      });
      const fx = await prepareConfirmedPo({
        companyDivisionId: seed.companyDivisions.OTHER.id,
      });
      await postReceipt({
        purchaseOrderId: fx.purchaseOrderId,
        purchaseOrderLineId: fx.purchaseOrderLineId,
        receivedQty: '2',
        cellId: seed.cells.A1.id,
      });

      const balance = await t.prisma.stockBalance.findFirstOrThrow({
        where: {
          workshopNeedId: fx.workshopNeedId,
          cellId: seed.cells.A1.id,
        },
      });

      // Пробуем списать больше, чем есть — через manual adjustment.
      const res = await request(t.app.getHttpServer())
        .post('/api/stock/adjustments')
        .set('Cookie', cookies.manager)
        .send({
          stockBalanceId: balance.id,
          direction: 'OUT',
          qty: '5',
          comment: 'Тест division override',
        })
        .expect(409);
      expect(res.body.code).toBe('MATERIAL_STOCK_INSUFFICIENT');
    });

    // =========================================================================
    // 8. PurchaseReceipt cancel не зависит от division settings
    // =========================================================================

    test('PurchaseReceipt cancel остаётся permissive даже если division.allowNegativeMaterialStockOverride=false', async () => {
      await setCompanySettings({ allowNegativeMaterialStock: true });
      await setDivisionOverride(seed.companyDivisions.OTHER.id, {
        allowNegativeMaterialStockOverride: false,
      });
      const fx = await prepareConfirmedPo({
        companyDivisionId: seed.companyDivisions.OTHER.id,
      });
      const receipt = await postReceipt({
        purchaseOrderId: fx.purchaseOrderId,
        purchaseOrderLineId: fx.purchaseOrderLineId,
        receivedQty: '5',
        cellId: seed.cells.A1.id,
      });

      // Списали весь положительный остаток manual adjustment-ом (для
      // этого allowNegative=false; 5→5 допустимо).
      const balance = await t.prisma.stockBalance.findFirstOrThrow({
        where: {
          workshopNeedId: fx.workshopNeedId,
          cellId: seed.cells.A1.id,
        },
      });
      await request(t.app.getHttpServer())
        .post('/api/stock/adjustments')
        .set('Cookie', cookies.manager)
        .send({
          stockBalanceId: balance.id,
          direction: 'OUT',
          qty: '5',
          comment: 'Списали всё',
        })
        .expect(201);

      // Теперь cancel приёмки должен пройти, даже несмотря на то, что
      // это уведёт StockBalance.qty в минус (0 - 5 = -5), и даже
      // несмотря на division.allowNegativeMaterialStockOverride=false.
      await request(t.app.getHttpServer())
        .post(`/api/purchase-receipts/${receipt.receiptId}/cancel`)
        .set('Cookie', cookies.manager)
        .send({ reason: 'Тест cancel permissive' })
        .expect(201);

      const updated = await t.prisma.stockBalance.findFirstOrThrow({
        where: {
          workshopNeedId: fx.workshopNeedId,
          cellId: seed.cells.A1.id,
        },
      });
      // 0 (после adjustment OUT) - 5 (reversal OUT от cancel) = -5.
      expect(new Prisma.Decimal(updated.qty).toString()).toBe('-5');
    });
  },
);
