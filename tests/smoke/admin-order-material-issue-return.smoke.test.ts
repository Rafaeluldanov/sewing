/**
 * Smoke-тесты итерации «Возврат / сторно проведённого списания
 * материалов» (см. ТЗ «Material issue return»).
 *
 * Source-of-truth:
 *   - Backend:   apps/api/src/modules/material-issues/material-issues.service.ts
 *                apps/api/src/modules/material-issues/material-issues.controller.ts
 *                apps/api/src/modules/material-issues/dto/return-material-issue.dto.ts
 *                apps/api/src/modules/stock/stock.service.ts
 *                apps/api/src/modules/audit/audit.service.ts
 *                apps/api/src/common/errors.ts
 *                apps/api/src/modules/costs/costs.service.ts
 *   - Prisma:    prisma/schema.prisma::MaterialIssueReturn /
 *                MaterialIssueReturnLine
 *   - Migration: prisma/migrations/20260612100000_add_material_issue_returns/migration.sql
 *   - Shared:    packages/shared/src/material-issues.ts
 *   - UI:        apps/web/components/orders/material-issues/return-material-issue-button.tsx
 *                apps/web/components/orders/material-issues/material-issues-table.tsx
 *   - API:       apps/web/lib/material-issues-api.ts
 *   - Actions:   apps/web/app/admin/orders/[id]/material-issues-actions.ts
 *
 * Цели (см. ТЗ §15):
 *   - Prisma schema содержит модели возврата.
 *   - Controller имеет POST /:id/return с RBAC ADMIN / SHOP_MANAGER.
 *   - Service имеет returnPostedIssue + idempotency helper.
 *   - StockService имеет buildMaterialIssueReturnLineStockSourceKey
 *     и пишет REVERSAL IN.
 *   - DTO `MaterialIssueListItemDto` / `MaterialIssueLineDto` /
 *     `MaterialIssueDetailDto` содержат returned/net поля.
 *   - OrderMaterials build-rows использует netIssuedQty / netTotalCost.
 *   - OrderSummary использует netTotalCost.
 *   - CostsService вычитает MaterialIssueReturn.
 *   - UI имеет кнопку «Сторнировать» для POSTED.
 *   - UI скрывает кнопку для FULL и для DRAFT/CANCELLED.
 *   - Не создаётся новая страница / роут / меню.
 *   - Нет FIFO/LIFO/MaterialStockLot/master Material.
 *   - Нет новых ролей.
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
const MIGRATION_DIR =
  'prisma/migrations/20260612100000_add_material_issue_returns';
const MIGRATION_SQL = `${MIGRATION_DIR}/migration.sql`;
const SERVICE_PATH =
  'apps/api/src/modules/material-issues/material-issues.service.ts';
const CONTROLLER_PATH =
  'apps/api/src/modules/material-issues/material-issues.controller.ts';
const RETURN_DTO_PATH =
  'apps/api/src/modules/material-issues/dto/return-material-issue.dto.ts';
const STOCK_SERVICE_PATH = 'apps/api/src/modules/stock/stock.service.ts';
const AUDIT_PATH = 'apps/api/src/modules/audit/audit.service.ts';
const ERRORS_PATH = 'apps/api/src/common/errors.ts';
const COSTS_PATH = 'apps/api/src/modules/costs/costs.service.ts';
const SHARED_PATH = 'packages/shared/src/material-issues.ts';
const BUILD_MATERIAL_ROWS_PATH =
  'apps/web/components/orders/materials/build-order-material-rows.ts';
const BUILD_SUMMARY_ROWS_PATH =
  'apps/web/components/orders/summary/build-order-summary-rows.ts';
const RETURN_BUTTON_PATH =
  'apps/web/components/orders/material-issues/return-material-issue-button.tsx';
const TABLE_PATH =
  'apps/web/components/orders/material-issues/material-issues-table.tsx';
const API_PATH = 'apps/web/lib/material-issues-api.ts';
const ACTIONS_PATH =
  'apps/web/app/admin/orders/[id]/material-issues-actions.ts';

describe('Material issue return — backend skeleton', () => {
  test('Prisma schema содержит MaterialIssueReturn / MaterialIssueReturnLine', () => {
    const s = read(SCHEMA_PATH);
    expect(s).toContain('model MaterialIssueReturn ');
    expect(s).toContain('model MaterialIssueReturnLine ');
    expect(s).toContain('materialIssueReturns MaterialIssueReturn[]'); // Order / Passport relation
    expect(s).toContain(
      'returns        MaterialIssueReturn[]', // MaterialIssue back-relation
    );
    expect(s).toContain('returnLines    MaterialIssueReturnLine[]');
    // sourceKey UNIQUE — защита от двойного полного сторно.
    expect(s).toMatch(/sourceKey\s+String\?\s+@unique/);
  });

  test('Migration файл создан и содержит UNIQUE/FK', () => {
    expect(exists(MIGRATION_DIR)).toBe(true);
    expect(exists(MIGRATION_SQL)).toBe(true);
    const sql = read(MIGRATION_SQL);
    expect(sql).toContain('CREATE TABLE "MaterialIssueReturn"');
    expect(sql).toContain('CREATE TABLE "MaterialIssueReturnLine"');
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "MaterialIssueReturn_sourceKey_key"',
    );
    // Cascade на materialIssueId — без исходного расхода возврат
    // теряет смысл (см. JSDoc модели).
    expect(sql).toMatch(
      /MaterialIssueReturn_materialIssueId_fkey.*ON DELETE CASCADE/s,
    );
    // Cascade на materialIssueLineId.
    expect(sql).toMatch(
      /MaterialIssueReturnLine_materialIssueLineId_fkey.*ON DELETE CASCADE/s,
    );
  });

  test('Controller имеет POST /:id/return и RBAC', () => {
    const s = read(CONTROLLER_PATH);
    expect(s).toContain("@Post(':id/return')");
    expect(s).toContain("@Roles('ADMIN', 'SHOP_MANAGER')");
    expect(s).toContain('returnPostedIssue');
  });

  test('Service имеет returnPostedIssue и идемпотентный source-key helper', () => {
    const s = read(SERVICE_PATH);
    expect(s).toContain('async returnPostedIssue(');
    expect(s).toContain('export function buildMaterialIssueReturnSourceKey(');
    expect(s).toContain('MATERIAL_ISSUE_RETURN_FULL:');
    expect(s).toContain('MaterialIssueReturnOnlyPostedException');
    expect(s).toContain('MaterialIssueAlreadyReturnedException');
    // Возврат пишет audit `MATERIAL_ISSUE_RETURNED` под entityType
    // `MATERIAL_ISSUE_RETURN`.
    expect(s).toContain("event: 'MATERIAL_ISSUE_RETURNED'");
    expect(s).toContain("entityType: 'MATERIAL_ISSUE_RETURN'");
    // sourceKey не отдаётся в response (toReturnDetail его не
    // включает в shape `MaterialIssueReturnDetail`).
    expect(s).toMatch(/interface MaterialIssueReturnDetail \{[^}]*\}/s);
    expect(s.match(/interface MaterialIssueReturnDetail \{[^}]*\}/s)?.[0]).not.toContain(
      'sourceKey',
    );
  });

  test('DTO отдельный файл и Zod schema', () => {
    expect(exists(RETURN_DTO_PATH)).toBe(true);
    const s = read(RETURN_DTO_PATH);
    expect(s).toContain('ReturnMaterialIssueSchema');
    expect(s).toContain('reason');
    expect(s).toContain('clientRequestId');
  });

  test('Errors содержат return-only-posted и already-returned', () => {
    const s = read(ERRORS_PATH);
    expect(s).toContain('class MaterialIssueReturnOnlyPostedException');
    expect(s).toContain('class MaterialIssueAlreadyReturnedException');
    expect(s).toContain('MATERIAL_ISSUE_RETURN_ONLY_POSTED');
    expect(s).toContain('MATERIAL_ISSUE_ALREADY_RETURNED');
  });

  test('Audit entity type MATERIAL_ISSUE_RETURN добавлен', () => {
    const s = read(AUDIT_PATH);
    expect(s).toMatch(/'MATERIAL_ISSUE_RETURN'/);
  });
});

describe('Material issue return — stock movements', () => {
  test('StockService имеет buildMaterialIssueReturnLineStockSourceKey', () => {
    const s = read(STOCK_SERVICE_PATH);
    expect(s).toContain('export function buildMaterialIssueReturnLineStockSourceKey(');
    expect(s).toContain('MATERIAL_ISSUE_RETURN_LINE');
  });

  test('StockService.recordMaterialIssueReturnInTx создаёт REVERSAL IN', () => {
    const s = read(STOCK_SERVICE_PATH);
    expect(s).toContain('async recordMaterialIssueReturnInTx(');
    // direction IN, type REVERSAL.
    expect(s).toMatch(
      /type:\s*STOCK_MOVEMENT_TYPE\.REVERSAL[\s\S]*direction:\s*STOCK_MOVEMENT_DIRECTION\.IN/,
    );
    // sourceKey/префикс используется.
    expect(s).toContain('MATERIAL_ISSUE_RETURN_LINE');
    // Возврат ищет исходный OUT через
    // `buildMaterialIssueLineStockSourceKey` для warehouseId/cellId.
    expect(s).toContain('buildMaterialIssueLineStockSourceKey');
  });
});

describe('Material issue return — DTOs / shared', () => {
  test('Shared MaterialIssueLineDto имеет returned/net поля', () => {
    const s = read(SHARED_PATH);
    expect(s).toContain('returnedQty: string');
    expect(s).toContain('returnedTotalCost: string');
    expect(s).toContain('netIssuedQty: string');
    expect(s).toContain('netTotalCost: string');
  });

  test('Shared MaterialIssueListItemDto имеет returned/net/returnsCount/returnStatus', () => {
    const s = read(SHARED_PATH);
    expect(s).toContain('returnsCount: number');
    expect(s).toContain('returnStatus: MaterialIssueAggregateReturnStatus');
  });

  test('Shared MaterialIssueDetailDto имеет returns массив', () => {
    const s = read(SHARED_PATH);
    expect(s).toContain('returns: MaterialIssueReturnDto[]');
    expect(s).toContain('export interface MaterialIssueReturnDto');
    expect(s).toContain('export interface MaterialIssueReturnLineDto');
  });

  test('Shared ReturnMaterialIssueSchema экспортирован', () => {
    const s = read(SHARED_PATH);
    expect(s).toContain('export const ReturnMaterialIssueSchema');
    expect(s).toContain('MATERIAL_ISSUE_RETURN_REASON_MIN_LENGTH');
  });
});

describe('Material issue return — agregations / costs', () => {
  test('OrderMaterials build-rows использует netIssuedQty/netTotalCost', () => {
    const s = read(BUILD_MATERIAL_ROWS_PATH);
    expect(s).toContain('netIssuedQty');
    expect(s).toContain('netTotalCost');
  });

  test('OrderSummary build-rows использует netTotalCost', () => {
    const s = read(BUILD_SUMMARY_ROWS_PATH);
    expect(s).toContain('netTotalCost');
  });

  test('CostsService вычитает MaterialIssueReturn', () => {
    const s = read(COSTS_PATH);
    expect(s).toContain('materialIssueReturn');
    // Минус по passportId — символический, но достаточный для smoke.
    expect(s).toMatch(/prev\s*-\s*decimalToNumber\(ret\.totalCost\)/);
  });
});

describe('Material issue return — UI', () => {
  test('ReturnMaterialIssueButton существует и имеет required reason', () => {
    expect(exists(RETURN_BUTTON_PATH)).toBe(true);
    const s = read(RETURN_BUTTON_PATH);
    expect(s).toContain("name=\"reason\"");
    expect(s).toContain('required');
    expect(s).toContain('clientRequestId');
    expect(s).toContain('Сторнировать');
    expect(s).toContain('returnMaterialIssueAction');
    // FULL — кнопка не рендерится.
    expect(s).toMatch(/returnStatus === ['"]FULL['"]/);
    // PARTIAL — лейбл «Сторнировать остаток».
    expect(s).toContain('Сторнировать остаток');
  });

  test('Table показывает «Сторнировать» для POSTED и «Сторнирован» для FULL', () => {
    const s = read(TABLE_PATH);
    expect(s).toContain('ReturnMaterialIssueButton');
    expect(s).toContain('Сторнирован');
    expect(s).toContain('material-issue-return-full');
    // DRAFT по-прежнему имеет post/cancel, не return.
    expect(s).toMatch(/row\.status === 'DRAFT'/);
    expect(s).toMatch(/row\.status === 'POSTED'/);
  });

  test('API client и server-action имеют returnMaterialIssue', () => {
    const apiSrc = read(API_PATH);
    expect(apiSrc).toContain('export function returnMaterialIssue(');
    expect(apiSrc).toContain('/return');

    const actSrc = read(ACTIONS_PATH);
    expect(actSrc).toContain('returnMaterialIssueAction');
    expect(actSrc).toContain('ReturnMaterialIssueSchema');
  });
});

describe('Material issue return — границы MVP сохранены', () => {
  test('Никаких новых страниц / роутов / меню', () => {
    expect(exists('apps/web/app/admin/material-issues')).toBe(false);
    expect(exists('apps/web/app/admin/material-issue-returns')).toBe(false);
    // OrderViewTabs не должен иметь упоминаний нового таба.
    const tabsSrc = exists('apps/web/components/orders/order-detail-tabs.tsx')
      ? read('apps/web/components/orders/order-detail-tabs.tsx')
      : '';
    expect(tabsSrc).not.toContain('material-issue-return');
  });

  test('Нет FIFO/LIFO/MaterialStockLot/master Material', () => {
    const s = read(SCHEMA_PATH);
    // Никакой `model MaterialStockLot` / `model Material` не
    // появилось в этой итерации (комментарии-упоминания «нет FIFO»
    // в JSDoc допустимы — это документация о сознательной границе
    // MVP).
    expect(s).not.toContain('model MaterialStockLot ');
    expect(s).not.toMatch(/model Material \{/);
    // Должны остаться только упоминания в комментариях формата
    // «без FIFO» / «нет FIFO/LIFO» — ни одной модели/поля с этим
    // именем.
    expect(s).not.toMatch(/^[^/]*\bFIFO\b/m);
    expect(s).not.toMatch(/^[^/]*\bLIFO\b/m);
  });

  test('Нет новых ролей', () => {
    const errSrc = read(ERRORS_PATH);
    expect(errSrc).not.toContain('WAREHOUSE_MANAGER');
    expect(errSrc).not.toContain('PURCHASER');
    expect(errSrc).not.toContain('ACCOUNTANT');
  });

  test('Удаление / отмена возврата не реализованы', () => {
    const ctrl = read(CONTROLLER_PATH);
    expect(ctrl).not.toMatch(/material-issue-returns?\/:id\/cancel/);
    expect(ctrl).not.toMatch(/Delete.*material-issue-return/);
    const svc = read(SERVICE_PATH);
    expect(svc).not.toContain('cancelReturn');
    expect(svc).not.toContain('deleteReturn');
  });
});
