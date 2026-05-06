/**
 * Smoke-тесты итерации «Частичный возврат проведённого
 * MaterialIssue» (см. ТЗ).
 *
 * Source-of-truth:
 *   - Backend service:  apps/api/src/modules/material-issues/material-issues.service.ts
 *   - Backend DTO:      apps/api/src/modules/material-issues/dto/return-material-issue.dto.ts
 *   - Backend errors:   apps/api/src/common/errors.ts
 *   - Shared:           packages/shared/src/material-issues.ts
 *   - UI:               apps/web/components/orders/material-issues/return-material-issue-button.tsx
 *   - Server action:    apps/web/app/admin/orders/[id]/material-issues-actions.ts
 *
 * Цели проверок (ТЗ §10 «Smoke/static tests»):
 *   1. ReturnMaterialIssueSchema поддерживает lines[].
 *   2. UI рендерит qty input по строке.
 *   3. UI имеет кнопку «Заполнить всё доступное».
 *   4. UI фильтрует строки с returnedQty <= 0.
 *   5. backend проверяет returnedQty <= remainingQty.
 *   6. backend проверяет, что materialIssueLineId принадлежит issue.
 *   7. returnStatus PARTIAL/FULL логика существует.
 *   8. MaterialIssueReturnLine — без изменений модели.
 *   9. Без новой страницы / роута / сайдбара.
 *  10. Без FIFO/LIFO/MaterialStockLot/master Material.
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
const SERVICE_PATH =
  'apps/api/src/modules/material-issues/material-issues.service.ts';
const RETURN_DTO_PATH =
  'apps/api/src/modules/material-issues/dto/return-material-issue.dto.ts';
const ERRORS_PATH = 'apps/api/src/common/errors.ts';
const SHARED_PATH = 'packages/shared/src/material-issues.ts';
const RETURN_BUTTON_PATH =
  'apps/web/components/orders/material-issues/return-material-issue-button.tsx';
const ACTIONS_PATH =
  'apps/web/app/admin/orders/[id]/material-issues-actions.ts';

describe('Material issue partial return — DTO / shared', () => {
  test('Backend DTO `ReturnMaterialIssueSchema` принимает массив `lines`', () => {
    const s = read(RETURN_DTO_PATH);
    expect(s).toContain('export const ReturnMaterialIssueLineSchema');
    expect(s).toContain('materialIssueLineId');
    expect(s).toContain('returnedQty');
    expect(s).toContain('lines: z');
    expect(s).toContain('.optional()');
  });

  test('Shared `ReturnMaterialIssueSchema` принимает `lines[]` с тем же контрактом', () => {
    const s = read(SHARED_PATH);
    expect(s).toContain('export const ReturnMaterialIssueLineSchema');
    expect(s).toContain('export type ReturnMaterialIssueLineDto');
    // lines optional на уровне shared-схемы (Zod-блок может
    // содержать min/.optional/multiline JSDoc — поэтому regex
    // ищет «lines: z» и `.optional()` в одном описании, без
    // жёсткого ограничения по длине между ними).
    expect(s).toMatch(/lines:\s*z[\s\S]{0,200}\.optional\(\)/);
  });
});

describe('Material issue partial return — backend service', () => {
  test('returnPostedIssue ветвится по `dto.lines`', () => {
    const s = read(SERVICE_PATH);
    expect(s).toMatch(/if \(dto\.lines && dto\.lines\.length > 0\)/);
    // ветка полного сторно сохранена для backward-compat.
    expect(s).toContain('Полное сторно — возвращаем весь оставшийся остаток');
  });

  test('Проверка returnedQty <= remainingQty', () => {
    const s = read(SERVICE_PATH);
    expect(s).toContain('MaterialIssueReturnQtyExceedsAvailableException');
    expect(s).toContain('greaterThan(remaining)');
  });

  test('Проверка принадлежности строки исходному MaterialIssue', () => {
    const s = read(SERVICE_PATH);
    expect(s).toContain('MaterialIssueReturnLineNotFoundException');
    expect(s).toContain('linesById');
  });

  test('Проверка дубликатов materialIssueLineId', () => {
    const s = read(SERVICE_PATH);
    expect(s).toContain('MaterialIssueReturnDuplicateLineException');
    expect(s).toMatch(/seen\.has\(/);
  });

  test('Pure-empty partial запрос → MATERIAL_ISSUE_NOTHING_TO_RETURN', () => {
    const s = read(SERVICE_PATH);
    expect(s).toContain('MaterialIssueNothingToReturnException');
  });
});

describe('Material issue partial return — errors', () => {
  test('Классы ошибок добавлены', () => {
    const s = read(ERRORS_PATH);
    expect(s).toContain('class MaterialIssueReturnLineNotFoundException');
    expect(s).toContain('class MaterialIssueReturnQtyExceedsAvailableException');
    expect(s).toContain('class MaterialIssueReturnDuplicateLineException');
    expect(s).toContain('class MaterialIssueNothingToReturnException');
    expect(s).toContain('MATERIAL_ISSUE_RETURN_LINE_NOT_FOUND');
    expect(s).toContain('MATERIAL_ISSUE_RETURN_QTY_EXCEEDS_AVAILABLE');
    expect(s).toContain('MATERIAL_ISSUE_RETURN_DUPLICATE_LINE');
    expect(s).toContain('MATERIAL_ISSUE_NOTHING_TO_RETURN');
  });

  test('Qty-exceeds exception несёт details для UI', () => {
    const s = read(ERRORS_PATH);
    // паттерн `extends HttpException` + поле `details`.
    expect(s).toMatch(
      /class MaterialIssueReturnQtyExceedsAvailableException extends HttpException[\s\S]{0,400}details:\s*\{/,
    );
  });
});

describe('Material issue partial return — UI', () => {
  test('Кнопка сторнирования имеет qty input по строке', () => {
    const s = read(RETURN_BUTTON_PATH);
    // Контролируемые input-ы.
    expect(s).toContain('material-issue-return-qty-input');
    expect(s).toContain('qtyByLine');
    // Один input на строку — рендерится в `tbody.map`.
    // Длина блока между `preparedLines.map(` и первым `<input` —
    // обоснованно большая (header + columns + invariant guards),
    // поэтому ограничение 0..2000 символов.
    expect(s).toMatch(/preparedLines\.map\([\s\S]{0,2000}<input/);
  });

  test('Кнопка «Заполнить всё доступное» присутствует', () => {
    const s = read(RETURN_BUTTON_PATH);
    expect(s).toContain('Заполнить всё доступное');
    expect(s).toContain('material-issue-return-fill-all');
    expect(s).toContain('fillAllAvailable');
  });

  test('UI фильтрует строки с returnedQty <= 0', () => {
    const s = read(RETURN_BUTTON_PATH);
    // Фильтр по prepared lines (`availableToReturn > 0`).
    expect(s).toMatch(/availableToReturn > 0/);
    // Submitted lines исключают `n <= 0`.
    expect(s).toMatch(/Number\.isFinite\(n\) \|\| n <= 0/);
  });

  test('UI шлёт `linesPayload` в form, server action парсит', () => {
    const button = read(RETURN_BUTTON_PATH);
    expect(button).toMatch(/name="linesPayload"/);
    const action = read(ACTIONS_PATH);
    expect(action).toContain('parseReturnLinesPayload');
    expect(action).toContain('linesPayload');
  });

  test('Submit отключён, пока не введено qty > 0', () => {
    const s = read(RETURN_BUTTON_PATH);
    expect(s).toContain('hasNonZeroLine');
    expect(s).toContain('submitDisabled');
  });

  test('FULL остаётся скрытым, PARTIAL получает «Сторнировать остаток»', () => {
    const s = read(RETURN_BUTTON_PATH);
    expect(s).toMatch(/returnStatus === ['"]FULL['"]/);
    expect(s).toContain('Сторнировать остаток');
    expect(s).toContain('Сторнировать');
  });
});

describe('Material issue partial return — границы MVP', () => {
  test('Никаких новых страниц / роутов', () => {
    expect(exists('apps/web/app/admin/material-issues')).toBe(false);
    expect(exists('apps/web/app/admin/material-issue-returns')).toBe(false);
  });

  test('Без новых моделей в Prisma (только старые MaterialIssueReturn / MaterialIssueReturnLine)', () => {
    const s = read(SCHEMA_PATH);
    expect(s).toContain('model MaterialIssueReturn ');
    expect(s).toContain('model MaterialIssueReturnLine ');
    expect(s).not.toContain('model MaterialStockLot ');
    expect(s).not.toMatch(/^model Material \{/m);
  });

  test('Без новых ролей / FIFO / LIFO в коде', () => {
    const errSrc = read(ERRORS_PATH);
    expect(errSrc).not.toContain('WAREHOUSE_MANAGER');
    expect(errSrc).not.toContain('PURCHASER');
    expect(errSrc).not.toContain('ACCOUNTANT');
    const svcSrc = read(SERVICE_PATH);
    // FIFO/LIFO упоминаются только в JSDoc как «не реализовано».
    expect(svcSrc).not.toMatch(/^[^/*\s].*\bFIFO\b/m);
    expect(svcSrc).not.toMatch(/^[^/*\s].*\bLIFO\b/m);
  });

  test('Удаление / отмена возврата не появилось', () => {
    const svc = read(SERVICE_PATH);
    expect(svc).not.toContain('cancelReturn');
    expect(svc).not.toContain('deleteReturn');
  });
});
