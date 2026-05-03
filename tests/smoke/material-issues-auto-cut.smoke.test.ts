/**
 * Smoke-тесты backend-итерации «Автосписание материалов при выдаче
 * кроя» (см. ТЗ, `apps/api/src/modules/material-issues/*`,
 * `apps/api/src/modules/passports/passports.service.ts`,
 * `prisma/schema.prisma::MaterialIssue`,
 * `docs/current-state.md §«Auto cut issue»`).
 *
 * Эти тесты статические — анализируют исходники, не поднимают
 * Nest-приложение и не ходят в БД. Покрытие (см. ТЗ §13):
 *   - Prisma schema содержит `source` / `sourceKey` в модели
 *     `MaterialIssue` с UNIQUE на `sourceKey` и индексом на `source`;
 *   - миграция `20260606100000_material_issue_auto_cut_source` добавляет
 *     эти колонки + индексы;
 *   - `MaterialIssuesService` содержит метод
 *     `createAutoCutIssueForPassport`, source-константу `AUTO_CUT_ISSUE`,
 *     helper `buildAutoCutIssueSourceKey`;
 *   - `PassportsService.issueToEmployee` вызывает auto-helper в ОБЕИХ
 *     ветках (FROM_CELL и ROUTE_WIP);
 *   - `PassportsModule` импортирует `MaterialIssuesModule`;
 *   - Есть foundation `StockBalance` / `StockMovement`, но auto issue
 *     их не вызывает; нет `MaterialStockLot`;
 *   - Не создана новая master-модель `Material`;
 *   - Не изменён frontend UI (MaterialIssuesSection /
 *     OrderMaterialsUnifiedTable / OrderViewTabs / OrderNeedsTab);
 *   - Не создана страница `/admin/material-issues`;
 *   - CostsService не менялся на этой итерации (auto MaterialIssue
 *     попадает в production cost через уже существующую логику
 *     `passportId` + POSTED).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

function exists(rel: string): boolean {
  return existsSync(path.join(repoRoot, rel));
}

const SCHEMA_PATH = 'prisma/schema.prisma';
const MIGRATION_PATH =
  'prisma/migrations/20260606100000_material_issue_auto_cut_source/migration.sql';
const MATERIAL_ISSUES_SERVICE_PATH =
  'apps/api/src/modules/material-issues/material-issues.service.ts';
const MATERIAL_ISSUES_MODULE_PATH =
  'apps/api/src/modules/material-issues/material-issues.module.ts';
const PASSPORTS_SERVICE_PATH =
  'apps/api/src/modules/passports/passports.service.ts';
const PASSPORTS_MODULE_PATH =
  'apps/api/src/modules/passports/passports.module.ts';
const SHARED_MATERIAL_ISSUES_PATH = 'packages/shared/src/material-issues.ts';
const COSTS_SERVICE_PATH = 'apps/api/src/modules/costs/costs.service.ts';

// ---------------------------------------------------------------------------
// 1. Prisma schema: source / sourceKey / индексы
// ---------------------------------------------------------------------------

describe('material-issues auto cut — Prisma schema', () => {
  const schema = read(SCHEMA_PATH);

  test('модель MaterialIssue содержит поле source (String, default MANUAL)', () => {
    expect(schema).toMatch(/model MaterialIssue \{[\s\S]*?source\s+String\s+@default\("MANUAL"\)/);
  });

  test('модель MaterialIssue содержит поле sourceKey (String? @unique)', () => {
    expect(schema).toMatch(
      /model MaterialIssue \{[\s\S]*?sourceKey\s+String\?\s+@unique/,
    );
  });

  test('модель MaterialIssue содержит индекс по source', () => {
    const model = schema.match(/model MaterialIssue \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(model).toContain('@@index([source])');
  });
});

// ---------------------------------------------------------------------------
// 2. Миграция для source / sourceKey
// ---------------------------------------------------------------------------

describe('material-issues auto cut — migration', () => {
  test('миграция 20260606100000_material_issue_auto_cut_source существует', () => {
    expect(exists(MIGRATION_PATH)).toBe(true);
  });

  test('миграция добавляет колонки source и sourceKey', () => {
    const sql = read(MIGRATION_PATH);
    expect(sql).toMatch(/ADD COLUMN\s+"source"\s+TEXT\s+NOT NULL\s+DEFAULT\s+'MANUAL'/i);
    expect(sql).toMatch(/ADD COLUMN\s+"sourceKey"\s+TEXT/i);
  });

  test('миграция создаёт индекс по source и UNIQUE по sourceKey', () => {
    const sql = read(MIGRATION_PATH);
    expect(sql).toMatch(/CREATE INDEX\s+"MaterialIssue_source_idx"\s+ON\s+"MaterialIssue"\("source"\)/i);
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX\s+"MaterialIssue_sourceKey_key"\s+ON\s+"MaterialIssue"\("sourceKey"\)/i,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. MaterialIssuesService: константы, helper, auto-метод
// ---------------------------------------------------------------------------

describe('material-issues auto cut — MaterialIssuesService', () => {
  const svc = read(MATERIAL_ISSUES_SERVICE_PATH);

  test('экспортирует MATERIAL_ISSUE_SOURCE с AUTO_CUT_ISSUE', () => {
    expect(svc).toMatch(/export const MATERIAL_ISSUE_SOURCE[\s\S]*?AUTO_CUT_ISSUE:\s*'AUTO_CUT_ISSUE'/);
  });

  test('экспортирует buildAutoCutIssueSourceKey(passportId)', () => {
    expect(svc).toMatch(/export function buildAutoCutIssueSourceKey\s*\(\s*passportId:\s*string\s*\)/);
    // Формат ключа: AUTO_CUT_ISSUE:<passportId>.
    expect(svc).toContain('AUTO_CUT_ISSUE}:${passportId}');
  });

  test('реализован метод createAutoCutIssueForPassport(tx, passportId, employeeId)', () => {
    expect(svc).toMatch(
      /async createAutoCutIssueForPassport\(\s*tx:\s*Prisma\.TransactionClient,\s*passportId:\s*string,\s*employeeId:\s*string,?\s*\)/,
    );
  });

  test('createAutoCutIssueForPassport использует totalOrderQty = Σ OrderItem.qtyPlan', () => {
    expect(svc).toContain('orderItem.findMany');
    expect(svc).toMatch(/qtyPlan\s*:\s*true/);
  });

  test('ручной create оставляет source = MANUAL и sourceKey = null', () => {
    // Поиск узкой области вокруг create-блока MANUAL.
    expect(svc).toMatch(/source:\s*MATERIAL_ISSUE_SOURCE\.MANUAL/);
    expect(svc).toMatch(/sourceKey:\s*null/);
  });

  test('auto issue проверяет идемпотентность по sourceKey и по неотменённому issue по passportId', () => {
    expect(svc).toContain("reason: 'source_key_exists'");
    expect(svc).toContain("reason: 'passport_already_has_issue'");
  });

  test('auto issue пишет audit MATERIAL_ISSUE_CREATED и MATERIAL_ISSUE_POSTED', () => {
    const autoBlockMatch = svc.match(
      /async createAutoCutIssueForPassport[\s\S]*?\n  \}\n\}/,
    );
    expect(autoBlockMatch).toBeTruthy();
    const block = autoBlockMatch![0];
    expect(block).toContain("event: 'MATERIAL_ISSUE_CREATED'");
    expect(block).toContain("event: 'MATERIAL_ISSUE_POSTED'");
    // Формула в payload
    expect(block).toContain(
      'WorkshopNeed.calculatedQty * Passport.qtyCut / totalOrderQty',
    );
  });

  test('auto issue НЕ трогает StockBalance / StockMovement / MaterialStockLot (Prisma-клиенты)', () => {
    // Не вызывает соответствующих моделей Prisma. Комментарии
    // «НЕТ StockBalance / StockMovement» в шапке сервиса —
    // часть документации MVP-границ и сюда не попадают (мы
    // ищем именно `tx.stockBalance.` / `prisma.stockBalance.` и
    // т.п. patterns).
    expect(svc).not.toMatch(/\b(tx|prisma|this\.prisma)\.stockBalance\./);
    expect(svc).not.toMatch(/\b(tx|prisma|this\.prisma)\.stockMovement\./);
    expect(svc).not.toMatch(/\b(tx|prisma|this\.prisma)\.materialStockLot\./);
  });

  test('auto issue исключает ORDER_APPLICATION (нанесения — не материал)', () => {
    expect(svc).toContain("sourceType: { not: 'ORDER_APPLICATION' }");
  });

  test('auto issue исключает CANCELLED WorkshopNeed', () => {
    expect(svc).toMatch(/status:\s*\{\s*not:\s*'CANCELLED'\s*\}/);
  });
});

// ---------------------------------------------------------------------------
// 4. PassportsService.issueToEmployee — вызывает auto helper
// ---------------------------------------------------------------------------

describe('material-issues auto cut — PassportsService integration', () => {
  const svc = read(PASSPORTS_SERVICE_PATH);

  test('PassportsService инжектит MaterialIssuesService', () => {
    expect(svc).toContain(
      "import { MaterialIssuesService } from '../material-issues/material-issues.service.js'",
    );
    expect(svc).toMatch(
      /private readonly materialIssues:\s*MaterialIssuesService/,
    );
  });

  test('issueToEmployee вызывает createAutoCutIssueForPassport в FROM_CELL и ROUTE_WIP ветках', () => {
    const issueBlockMatch = svc.match(
      /async issueToEmployee\([\s\S]*?\n  \}\n/,
    );
    expect(issueBlockMatch).toBeTruthy();
    const block = issueBlockMatch![0];
    // Две ветки issue — значит минимум два вызова auto helper.
    const matches = block.match(/materialIssues\.createAutoCutIssueForPassport/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  test('PassportsModule импортирует MaterialIssuesModule', () => {
    const mod = read(PASSPORTS_MODULE_PATH);
    expect(mod).toContain(
      "import { MaterialIssuesModule } from '../material-issues/material-issues.module.js'",
    );
    expect(mod).toMatch(/imports:\s*\[[\s\S]*?MaterialIssuesModule[\s\S]*?\]/);
  });
});

// ---------------------------------------------------------------------------
// 5. Shared DTO: source типизирован в ответе
// ---------------------------------------------------------------------------

describe('material-issues auto cut — shared DTO', () => {
  const shared = read(SHARED_MATERIAL_ISSUES_PATH);

  test('shared экспортирует MATERIAL_ISSUE_SOURCES c MANUAL и AUTO_CUT_ISSUE', () => {
    expect(shared).toMatch(
      /export const MATERIAL_ISSUE_SOURCES\s*=\s*\[\s*'MANUAL'\s*,\s*'AUTO_CUT_ISSUE'\s*\]/,
    );
    expect(shared).toMatch(/export type MaterialIssueSource\s*=/);
  });

  test('MaterialIssueDetailDto и MaterialIssueListItemDto имеют поле source', () => {
    expect(shared).toMatch(/MaterialIssueDetailDto[\s\S]*?source:\s*MaterialIssueSource/);
    expect(shared).toMatch(/MaterialIssueListItemDto[\s\S]*?source:\s*MaterialIssueSource/);
  });

  test('shared DTO на входе (Create) НЕ принимает source / sourceKey', () => {
    // Create-схема должна оставаться со strict() и без поля source/sourceKey.
    const createSchema = shared
      .match(/export const CreateMaterialIssueSchema[\s\S]*?export type/)?.[0] ?? '';
    expect(createSchema).not.toContain('source:');
    expect(createSchema).not.toContain('sourceKey:');
  });
});

// ---------------------------------------------------------------------------
// 6. Сознательные границы MVP: нет новых сущностей/страниц/UI
// ---------------------------------------------------------------------------

describe('material-issues auto cut — MVP boundaries', () => {
  test('есть foundation StockBalance / StockMovement; нет MaterialStockLot', () => {
    const schema = read(SCHEMA_PATH);
    expect(schema).toMatch(/^model\s+StockBalance\b/m);
    expect(schema).toMatch(/^model\s+StockMovement\b/m);
    expect(schema).not.toMatch(/^model\s+MaterialStockLot\b/m);
  });

  test('нет master-модели Material (отдельной от существующих Pattern/Tech/Supplier)', () => {
    const schema = read(SCHEMA_PATH);
    // Проверяем точное совпадение на начале строки, не захватывая
    // `MaterialIssue` / `MaterialIssueLine` / `PatternMaterialArea` /
    // `TechCardMaterialLine` / `OrderMaterialRequirement` / …
    expect(schema).not.toMatch(/^model\s+Material\s*\{/m);
  });

  test('не создана страница /admin/material-issues', () => {
    expect(exists('apps/web/app/admin/material-issues')).toBe(false);
    expect(exists('apps/web/app/admin/material-issues/page.tsx')).toBe(false);
  });

  test('MaterialIssuesSection не изменился в рамках этой итерации (файл присутствует)', () => {
    // Сам файл остался, UI на backend-итерации не трогаем.
    expect(
      exists(
        'apps/web/components/orders/material-issues/material-issues-section.tsx',
      ),
    ).toBe(true);
  });

  test('CostsService не менялся на этой итерации (уже учитывает POSTED MaterialIssue с passportId)', () => {
    const costs = read(COSTS_SERVICE_PATH);
    // Должно остаться как было в предыдущем коммите: POSTED + passportId.
    expect(costs).toContain('MATERIAL_ISSUE_STATUS_POSTED');
    expect(costs).toMatch(/status:\s*MATERIAL_ISSUE_STATUS_POSTED/);
    expect(costs).toMatch(/passportId:\s*\{\s*in:\s*passportIds\s*\}/);
  });

  test('auto helper не предполагает FIFO/LIFO в области createAutoCutIssueForPassport', () => {
    const svc = read(MATERIAL_ISSUES_SERVICE_PATH);
    // Ищем конкретно в теле метода — в шапке сервиса слова
    // `FIFO/LIFO` встречаются в списке «Сознательная граница MVP».
    const autoMethodMatch = svc.match(
      /async createAutoCutIssueForPassport[\s\S]*?\n  \}\n/,
    );
    expect(autoMethodMatch).toBeTruthy();
    expect(autoMethodMatch![0]).not.toMatch(/FIFO|LIFO/i);
    // И нигде в сервисе не зовём `materialStockLot`-клиент.
    expect(svc).not.toMatch(/\b(tx|prisma|this\.prisma)\.materialStockLot\./);
  });
});
