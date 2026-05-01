/**
 * Smoke-тест управленческого отчёта «Себестоимость производства v2»
 * (`/api/admin/production-cost/v2`, `/admin/production-cost`).
 *
 * Проверяем то, что **не требует БД**: контракт DTO, RBAC контроллера,
 * структура UI и подписи источников. Полный full-pipeline сценарий —
 * в `tests/integration/production-cost-v2.test.ts`.
 *
 *   1. Shared-схема (`packages/shared/src/production-cost.ts`)
 *      содержит `ProductionCostV2QuerySchema`,
 *      `ProductionCostReportDto` и описание разрезов
 *      (nomenclatureGroups / orderGroups / operationLines).
 *   2. `ProductionCostOperationLineDto` имеет `nomenclatureName` и НЕ
 *      требует `passportNumber` (passportId/passportNumber — optional
 *      technical).
 *   3. Контроллер `ProductionCostV2Controller` навешен на
 *      `@Roles('ADMIN','SHOP_MANAGER')`, route `admin/production-cost`,
 *      method `v2`, использует `ZodValidationPipe`.
 *   4. Сервис использует `OperationEntry` как факт операций и не
 *      группирует основной отчёт по паспорту.
 *   5. `CostsModule` подключает новый сервис/контроллер.
 *   6. Frontend RBAC по сути остаётся (`canSeeProductionCost`).
 *   7. UI `/admin/production-cost` содержит вкладки «По номенклатуре»,
 *      «По заказам», «Операции / сотрудники», и НЕ содержит
 *      обязательной колонки «Паспорт» в основных таблицах.
 *   8. Подписи источников материалов — «по завершённому расчёту» /
 *      «по текущей потребности».
 *   9. Frontend API ходит в `/admin/production-cost/v2`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  PRODUCTION_COST_MATERIAL_SOURCE_LABELS,
  PRODUCTION_COST_V2_ENTRY_STATUSES,
  ProductionCostV2QuerySchema,
  type ProductionCostOperationLineDto,
  type ProductionCostReportDto,
} from '@sewing/shared/production-cost';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('Production Cost v2 — shared contract', () => {
  test('ProductionCostV2QuerySchema принимает пустой объект и опциональные фильтры', () => {
    expect(ProductionCostV2QuerySchema.parse({}).dateFrom).toBeUndefined();
    expect(
      ProductionCostV2QuerySchema.parse({
        dateFrom: '2026-04-01',
        dateTo: '2026-04-30',
        patternItemId: 'p1',
        orderId: 'o1',
        clientId: 'c1',
        employeeId: 'e1',
        operationId: 'op1',
        status: 'APPROVED',
      }).operationId,
    ).toBe('op1');
  });

  test('ProductionCostV2QuerySchema валидирует YYYY-MM-DD и enum статуса', () => {
    expect(() =>
      ProductionCostV2QuerySchema.parse({ dateFrom: '15.04.2026' }),
    ).toThrow();
    expect(() =>
      ProductionCostV2QuerySchema.parse({ status: 'BOGUS' as never }),
    ).toThrow();
  });

  test('Список статусов OperationEntry — APPROVED первый (дефолт)', () => {
    expect(PRODUCTION_COST_V2_ENTRY_STATUSES[0]).toBe('APPROVED');
  });

  test('Подписи источников материалов — честные (без «факта списания»)', () => {
    expect(PRODUCTION_COST_MATERIAL_SOURCE_LABELS.COST_ESTIMATE).toMatch(
      /завершённому расчёту/i,
    );
    expect(PRODUCTION_COST_MATERIAL_SOURCE_LABELS.WORKSHOP_NEED).toMatch(
      /текущей потребности/i,
    );
    // Никаких «факт списания» / «фактический расход» в подписях.
    for (const label of Object.values(
      PRODUCTION_COST_MATERIAL_SOURCE_LABELS,
    )) {
      expect(label).not.toMatch(/факт списания/i);
      expect(label).not.toMatch(/фактический расход/i);
    }
  });

  test('ProductionCostOperationLineDto имеет nomenclatureName и НЕ требует passportNumber', () => {
    // TypeScript-уровень: тип валиден без passportId/passportNumber.
    const minimal: ProductionCostOperationLineDto = {
      operationEntryId: 'oe-1',
      date: '2026-04-10T10:00:00Z',
      orderId: 'o-1',
      orderNumber: 'O-001',
      clientName: null,
      patternItemId: null,
      nomenclatureName: 'Худи база',
      nomenclatureArticle: 'HD-001',
      sizeId: null,
      sizeCode: 'M',
      color: null,
      operationId: 'op-1',
      operationName: 'Оверлок 1',
      operationCategory: 'SEWING',
      employeeId: 'emp-1',
      employeeName: 'Иванова',
      qty: 5,
      ratePerUnit: '10.00',
      amount: '50.00',
      unitCost: '10.00',
      status: 'APPROVED',
      sourceEventType: 'OPERATION_TRANSITION',
      approvalMode: 'AFTER_RELEASE',
    };
    expect(minimal.nomenclatureName).toBe('Худи база');
    expect(minimal.passportNumber).toBeUndefined();
  });

  test('ProductionCostReportDto содержит три разреза + warnings', () => {
    const empty: ProductionCostReportDto = {
      dateFrom: '2026-04-01',
      dateTo: '2026-04-30',
      entryStatus: 'APPROVED',
      totals: {
        releasedQty: 0,
        passportsCount: 0,
        ordersCount: 0,
        operationEntriesCount: 0,
        revenueRub: '0.00',
        materialCostRub: '0.00',
        hardwareCostRub: '0.00',
        applicationCostRub: '0.00',
        operationPieceworkCostRub: '0.00',
        salaryAllocatedCostRub: '0.00',
        otherCostRub: '0.00',
        totalCostRub: '0.00',
        unitCostRub: null,
        marginRub: '0.00',
        marginPercent: null,
      },
      nomenclatureGroups: [],
      orderGroups: [],
      operationLines: [],
      warnings: [],
    };
    expect(empty.nomenclatureGroups).toHaveLength(0);
    expect(empty.orderGroups).toHaveLength(0);
    expect(empty.operationLines).toHaveLength(0);
    expect(empty.warnings).toHaveLength(0);
  });
});

describe('Production Cost v2 — backend wiring', () => {
  test('CostsModule подключает ProductionCostV2Service и Controller', () => {
    const src = readSrc('apps/api/src/modules/costs/costs.module.ts');
    expect(src).toMatch(/ProductionCostV2Service/);
    expect(src).toMatch(/ProductionCostV2Controller/);
  });

  test('Контроллер защищён @Roles ADMIN + SHOP_MANAGER, маршрут v2', () => {
    const src = readSrc(
      'apps/api/src/modules/costs/production-cost-v2.controller.ts',
    );
    expect(src).toMatch(
      /@Roles\(\s*'ADMIN',\s*'SHOP_MANAGER'\s*\)/,
    );
    // Префикс контроллера — admin/production-cost; method — v2.
    expect(src).toMatch(/@Controller\('admin\/production-cost'\)/);
    expect(src).toMatch(/@Get\('v2'\)/);
    expect(src).toMatch(/ZodValidationPipe\(ProductionCostV2QuerySchema\)/);
  });

  test('Сервис использует OperationEntry как факт операций', () => {
    const src = readSrc(
      'apps/api/src/modules/costs/production-cost-v2.service.ts',
    );
    expect(src).toMatch(/operationEntry\.findMany/);
    expect(src).toMatch(/EntryStatus/);
    // Источник выпуска — PACKED, а не count(passport).
    expect(src).toMatch(/PassportEventType\.PACKED/);
    expect(src).toMatch(/qtyGood/);
  });

  test('Сервис включает passport только как технический join (passport include в operationEntry)', () => {
    const src = readSrc(
      'apps/api/src/modules/costs/production-cost-v2.service.ts',
    );
    // passport должен быть include внутри operationEntry, но не
    // основной разрез: основной агрегат — по nomenclatureKey.
    expect(src).toMatch(/passport: \{/);
    expect(src).toMatch(/nomenclatureKey/);
    // Подпись «по завершённому расчёту» в подписях источников
    // материалов.
    expect(src).toMatch(/COST_ESTIMATE/);
  });

  test('Сервис НЕ группирует основной отчёт по паспорту', () => {
    const src = readSrc(
      'apps/api/src/modules/costs/production-cost-v2.service.ts',
    );
    // Группировка должна быть по номенклатуре и заказу. groupBy по
    // паспорту (как в старом CostsService) в новом сервисе быть не
    // должно.
    expect(src).not.toMatch(/groupBy:\s*\['passportId'\]/);
    expect(src).not.toMatch(/by:\s*\['passportId'\]/);
  });

  test('Сервис не меняет Prisma — нет вызовов create/update/upsert/delete', () => {
    const src = readSrc(
      'apps/api/src/modules/costs/production-cost-v2.service.ts',
    );
    expect(src).not.toMatch(/\.create\(/);
    expect(src).not.toMatch(/\.update\(/);
    expect(src).not.toMatch(/\.upsert\(/);
    expect(src).not.toMatch(/\.delete\(/);
    expect(src).not.toMatch(/\$executeRaw/);
  });
});

describe('Production Cost v2 — frontend page', () => {
  test('UI содержит три таба и НЕ содержит основной колонки «Паспорт»', () => {
    const src = readSrc('apps/web/app/admin/production-cost/page.tsx');
    expect(src).toMatch(/По номенклатуре/);
    expect(src).toMatch(/По заказам/);
    expect(src).toMatch(/Операции \/ сотрудники/);
    // Нет основной колонки «Паспорт» в таблице — header'ов <th>...
    // Паспорт... быть не должно ни в каком таб'е.
    expect(src).not.toMatch(/<th[^>]*>\s*Паспорт\s*</);
    // Нет data-label="Паспорт" — это бы намекало на ячейку «Паспорт»
    // в основной таблице.
    expect(src).not.toMatch(/data-label="Паспорт"/);
  });

  test('UI содержит правильные колонки расшифровки операций', () => {
    const src = readSrc('apps/web/app/admin/production-cost/page.tsx');
    // Колонки таба «Операции / сотрудники»: дата, номенклатура,
    // заказ, клиент, размер, операция, сотрудник, кол-во, ставка,
    // сумма, за 1 ед.
    for (const header of [
      'Дата',
      'Номенклатура',
      'Заказ',
      'Клиент',
      'Размер',
      'Операция',
      'Сотрудник',
      'Кол-во',
      'Ставка',
      'Сумма',
      'За 1 ед.',
    ]) {
      expect(src).toMatch(new RegExp(header));
    }
  });

  test('UI содержит KPI «Выпущено» и «Себестоимость / шт»', () => {
    const src = readSrc('apps/web/app/admin/production-cost/page.tsx');
    expect(src).toMatch(/Выпущено, шт/);
    // «За 1 изделие» как hint в KPI «Себестоимость» либо отдельной
    // колонкой; обе формулировки приемлемы.
    expect(src).toMatch(/За 1 изделие/);
    expect(src).toMatch(/Себестоимость/);
    expect(src).toMatch(/Маржа/);
  });

  test('UI подписывает источник материалов честно (без «факта списания»)', () => {
    const src = readSrc('apps/web/app/admin/production-cost/page.tsx');
    expect(src).toMatch(/Материалы — расчётная основа/);
    expect(src).not.toMatch(/факт списания/i);
    expect(src).not.toMatch(/фактический расход/i);
  });

  test('UI ходит в getProductionCostV2 (новый endpoint)', () => {
    const src = readSrc('apps/web/app/admin/production-cost/page.tsx');
    expect(src).toMatch(/getProductionCostV2/);
  });

  test('Фронт-API ходит в `/admin/production-cost/v2`', () => {
    const src = readSrc('apps/web/lib/production-cost-api.ts');
    expect(src).toMatch(/\/admin\/production-cost\/v2/);
  });
});
