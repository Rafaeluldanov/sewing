/**
 * Smoke-тесты frontend-итерации «Фактический расход материалов» во
 * вкладке «Потребности» карточки заказа (`/admin/orders/[id]?tab=needs`).
 *
 * Source-of-truth:
 *   - Section:   `apps/web/components/orders/material-issues/material-issues-section.tsx`
 *   - Table:     `apps/web/components/orders/material-issues/material-issues-table.tsx`
 *   - Dialog:    `apps/web/components/orders/material-issues/create-material-issue-dialog.tsx`
 *   - Button:    `apps/web/components/orders/material-issues/create-material-issue-button.tsx`
 *   - Actions:   `apps/web/components/orders/material-issues/post-material-issue-button.tsx`,
 *                `apps/web/components/orders/material-issues/cancel-material-issue-button.tsx`
 *   - Status:    `apps/web/components/orders/material-issues/material-issue-status-badge.tsx`
 *   - API:       `apps/web/lib/material-issues-api.ts`
 *   - Actions:   `apps/web/app/admin/orders/[id]/material-issues-actions.ts`
 *   - Shared:    `packages/shared/src/material-issues.ts`
 *   - Tab wiring: `apps/web/components/orders/view/tabs/order-needs-tab.tsx`
 *
 * Цели проверок (см. ТЗ §11 «Tests»):
 *   1. OrderNeedsTab рендерит блок «Фактический расход материалов».
 *   2. Empty state показывается, если документов нет.
 *   3. DRAFT-документ показывает кнопки «Провести» и «Отменить».
 *   4. POSTED-документ не показывает кнопки редактирования.
 *   5. CANCELLED-документ не показывает кнопки редактирования.
 *   6. Кнопка «Создать расход» видна ADMIN / SHOP_MANAGER (canManage=true).
 *   7. Кнопка «Создать расход» не видна рабочим ролям (canManage=false).
 *
 * Тесты статические — анализируют исходники, не запускают Next/React
 * runtime. Это согласовано с остальным смок-набором
 * (`admin-order-materials-unified.smoke.test.ts`,
 * `admin-order-needs-no-duplication.smoke.test.ts`).
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

const SECTION_PATH =
  'apps/web/components/orders/material-issues/material-issues-section.tsx';
const TABLE_PATH =
  'apps/web/components/orders/material-issues/material-issues-table.tsx';
const DIALOG_PATH =
  'apps/web/components/orders/material-issues/create-material-issue-dialog.tsx';
const BUTTON_PATH =
  'apps/web/components/orders/material-issues/create-material-issue-button.tsx';
const POST_BUTTON_PATH =
  'apps/web/components/orders/material-issues/post-material-issue-button.tsx';
const CANCEL_BUTTON_PATH =
  'apps/web/components/orders/material-issues/cancel-material-issue-button.tsx';
const STATUS_BADGE_PATH =
  'apps/web/components/orders/material-issues/material-issue-status-badge.tsx';
const LINES_PREVIEW_PATH =
  'apps/web/components/orders/material-issues/material-issue-lines-preview.tsx';
const SHARED_PATH = 'packages/shared/src/material-issues.ts';
const API_PATH = 'apps/web/lib/material-issues-api.ts';
const ACTIONS_PATH =
  'apps/web/app/admin/orders/[id]/material-issues-actions.ts';
const NEEDS_TAB_PATH =
  'apps/web/components/orders/view/tabs/order-needs-tab.tsx';

// ---------------------------------------------------------------------------
// 1. Файлы на месте
// ---------------------------------------------------------------------------

describe('Material issues UI — файлы существуют', () => {
  test('все компоненты и обёртки созданы', () => {
    expect(exists(SECTION_PATH)).toBe(true);
    expect(exists(TABLE_PATH)).toBe(true);
    expect(exists(DIALOG_PATH)).toBe(true);
    expect(exists(BUTTON_PATH)).toBe(true);
    expect(exists(POST_BUTTON_PATH)).toBe(true);
    expect(exists(CANCEL_BUTTON_PATH)).toBe(true);
    expect(exists(STATUS_BADGE_PATH)).toBe(true);
    expect(exists(LINES_PREVIEW_PATH)).toBe(true);
    expect(exists(SHARED_PATH)).toBe(true);
    expect(exists(API_PATH)).toBe(true);
    expect(exists(ACTIONS_PATH)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Shared types: Zod-схемы и DTO-интерфейсы
// ---------------------------------------------------------------------------

describe('@sewing/shared/material-issues — контракты', () => {
  const src = read(SHARED_PATH);

  test('экспортирует `MATERIAL_ISSUE_STATUSES` (DRAFT / POSTED / CANCELLED)', () => {
    expect(src).toMatch(
      /MATERIAL_ISSUE_STATUSES\s*=\s*\[['"]DRAFT['"],\s*['"]POSTED['"],\s*['"]CANCELLED['"]\]/,
    );
  });

  test('экспортирует CreateMaterialIssueSchema / CancelMaterialIssueSchema / ListMaterialIssuesQuerySchema', () => {
    expect(src).toMatch(/export\s+const\s+CreateMaterialIssueSchema\b/);
    expect(src).toMatch(/export\s+const\s+CancelMaterialIssueSchema\b/);
    expect(src).toMatch(/export\s+const\s+ListMaterialIssuesQuerySchema\b/);
  });

  test('экспортирует DTO-интерфейсы Detail / ListItem / Line', () => {
    expect(src).toMatch(/export\s+interface\s+MaterialIssueDetailDto\b/);
    expect(src).toMatch(/export\s+interface\s+MaterialIssueListItemDto\b/);
    expect(src).toMatch(/export\s+interface\s+MaterialIssueLineDto\b/);
  });
});

// ---------------------------------------------------------------------------
// 3. Frontend API client
// ---------------------------------------------------------------------------

describe('apps/web/lib/material-issues-api.ts — серверные обёртки', () => {
  const src = read(API_PATH);

  test('экспортирует основные функции (list / listByOrder / get / create / post / cancel)', () => {
    expect(src).toMatch(/export\s+function\s+listMaterialIssues\b/);
    expect(src).toMatch(/export\s+function\s+listOrderMaterialIssues\b/);
    expect(src).toMatch(/export\s+function\s+getMaterialIssue\b/);
    expect(src).toMatch(/export\s+function\s+createMaterialIssue\b/);
    expect(src).toMatch(/export\s+function\s+postMaterialIssue\b/);
    expect(src).toMatch(/export\s+function\s+cancelMaterialIssue\b/);
  });

  test('пути соответствуют backend-контроллерам (/material-issues + /orders/:id/material-issues)', () => {
    expect(src).toMatch(/\/material-issues\b/);
    expect(src).toMatch(/\/orders\/\$\{encodeURIComponent\(orderId\)\}\/material-issues/);
    expect(src).toMatch(/\/material-issues\/\$\{encodeURIComponent\(id\)\}\/post/);
    expect(src).toMatch(/\/material-issues\/\$\{encodeURIComponent\(id\)\}\/cancel/);
  });
});

// ---------------------------------------------------------------------------
// 4. Server actions
// ---------------------------------------------------------------------------

describe('material-issues-actions.ts — server actions', () => {
  const src = read(ACTIONS_PATH);

  test('`use server` и именованные экспорты action-функций', () => {
    expect(src).toMatch(/['"]use server['"]/);
    expect(src).toMatch(/export\s+async\s+function\s+createMaterialIssueAction\b/);
    expect(src).toMatch(/export\s+async\s+function\s+postMaterialIssueAction\b/);
    expect(src).toMatch(/export\s+async\s+function\s+cancelMaterialIssueAction\b/);
  });

  test('create-action валидирует payload через CreateMaterialIssueSchema', () => {
    expect(src).toMatch(/CreateMaterialIssueSchema\.safeParse/);
  });

  test('cancel-action валидирует body через CancelMaterialIssueSchema', () => {
    expect(src).toMatch(/CancelMaterialIssueSchema\.safeParse/);
  });

  test('после мутации делает revalidatePath для карточки заказа', () => {
    expect(src).toMatch(/revalidatePath\(\s*`?\/admin\/orders\/\$\{orderId\}`?/);
  });
});

// ---------------------------------------------------------------------------
// 5. OrderNeedsTab подключает блок «Фактический расход материалов»
// ---------------------------------------------------------------------------

describe('OrderNeedsTab — подключает MaterialIssuesSection после OrderMaterialsUnifiedTable', () => {
  const src = read(NEEDS_TAB_PATH);

  test('импортирует и рендерит MaterialIssuesSection', () => {
    expect(src).toMatch(
      /from '@\/components\/orders\/material-issues\/material-issues-section'/,
    );
    expect(src).toMatch(/<MaterialIssuesSection\b/);
  });

  test('MaterialIssuesSection идёт ПОСЛЕ OrderMaterialsUnifiedTable', () => {
    const idxMaterials = src.indexOf('<OrderMaterialsUnifiedTable');
    const idxIssues = src.indexOf('<MaterialIssuesSection');
    expect(idxMaterials).toBeGreaterThan(-1);
    expect(idxIssues).toBeGreaterThan(-1);
    expect(idxIssues).toBeGreaterThan(idxMaterials);
  });

  test('прокидывает orderId / canManage / passports в MaterialIssuesSection', () => {
    expect(src).toMatch(
      /<MaterialIssuesSection[\s\S]*?orderId=\{order\.id\}/,
    );
    expect(src).toMatch(/<MaterialIssuesSection[\s\S]*?canManage=\{canManage\}/);
    expect(src).toMatch(/<MaterialIssuesSection[\s\S]*?passports=\{passports\}/);
  });

  test('MaterialIssuesSection НЕ создаёт отдельную вкладку / роут', () => {
    // Section должен быть встроен в JSX-дерево — никаких ссылок на
    // отдельную страницу `/admin/material-issues`. Комментарии с
    // упоминанием этой несуществующей страницы допустимы
    // (explainers «почему мы её НЕ делаем»), поэтому проверяем
    // только живой код.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    expect(code).not.toMatch(/['"`]\/admin\/material-issues/);
    expect(code).not.toMatch(/<Link\s+href=["']\/admin\/material-issues/);
  });
});

// ---------------------------------------------------------------------------
// 6. MaterialIssuesSection: заголовок, empty state, summary, RBAC-actions
// ---------------------------------------------------------------------------

describe('MaterialIssuesSection — title / empty state / summary', () => {
  const src = read(SECTION_PATH);

  test('показывает заголовок «Фактический расход материалов»', () => {
    expect(src).toMatch(/Фактический расход материалов/);
  });

  test('показывает empty-state текстом из ТЗ', () => {
    expect(src).toMatch(
      /Фактический расход материалов по заказу пока не зафиксирован/,
    );
  });

  test('показывает краткую сводку (Всего / DRAFT / POSTED / CANCELLED / Σ POSTED)', () => {
    expect(src).toMatch(/Всего:/);
    expect(src).toMatch(/Черновик:/);
    expect(src).toMatch(/Проведено:/);
    expect(src).toMatch(/Отменено:/);
    expect(src).toMatch(/Сумма проведённых:/);
  });

  test('кнопка «Создать расход» рендерится только при canManage=true', () => {
    // Action-проп `AdminSectionHeader` завязан на условие canManage ? … : undefined.
    expect(src).toMatch(/canManage\s*\?[\s\S]*?<CreateMaterialIssueButton/);
  });

  test('использует endpoint /api/orders/:id/material-issues и /api/material-issues/:id', () => {
    expect(src).toMatch(/listOrderMaterialIssues/);
    expect(src).toMatch(/getMaterialIssue/);
  });
});

// ---------------------------------------------------------------------------
// 7. MaterialIssuesTable: DRAFT → actions; POSTED / CANCELLED — read-only
// ---------------------------------------------------------------------------

describe('MaterialIssuesTable — действия по статусам', () => {
  const src = read(TABLE_PATH);

  test('DRAFT рендерит обе кнопки действий (Провести / Отменить)', () => {
    // Кнопки рендерятся только для row.status === 'DRAFT' при canManage=true.
    expect(src).toMatch(/row\.status\s*===\s*['"]DRAFT['"]/);
    expect(src).toMatch(/<PostMaterialIssueButton\b/);
    expect(src).toMatch(/<CancelMaterialIssueButton\b/);
  });

  test('POSTED / CANCELLED не получают action-кнопки (read-only)', () => {
    // Если status !== DRAFT и (или) canManage=false — возвращаем `—`.
    // Мы проверяем, что PostMaterialIssueButton / CancelMaterialIssueButton
    // вызываются внутри блока, ограниченного проверкой DRAFT.
    const lines = src.split('\n');
    const draftGuardLine = lines.findIndex((l) =>
      /row\.status\s*===\s*['"]DRAFT['"]/.test(l),
    );
    const postButtonLine = lines.findIndex((l) =>
      /<PostMaterialIssueButton\b/.test(l),
    );
    const cancelButtonLine = lines.findIndex((l) =>
      /<CancelMaterialIssueButton\b/.test(l),
    );
    expect(draftGuardLine).toBeGreaterThan(-1);
    expect(postButtonLine).toBeGreaterThan(draftGuardLine);
    expect(cancelButtonLine).toBeGreaterThan(draftGuardLine);
  });

  test('если canManage=false — таблица рендерит «—» вместо actions', () => {
    expect(src).toMatch(/if \(!canManage\) return/);
  });
});

// ---------------------------------------------------------------------------
// 8. CreateMaterialIssueDialog: валидация + payload для server action
// ---------------------------------------------------------------------------

describe('CreateMaterialIssueDialog — форма создания DRAFT', () => {
  const src = read(DIALOG_PATH);

  test("помечена как 'use client' (client component)", () => {
    expect(src.startsWith("'use client'")).toBe(true);
  });

  test('умеет добавлять и удалять строки', () => {
    expect(src).toMatch(/addLine|makeEmptyLine/);
    expect(src).toMatch(/removeLine/);
  });

  test('сабмит идёт в createMaterialIssueAction через useFormState', () => {
    expect(src).toMatch(/useFormState/);
    expect(src).toMatch(/createMaterialIssueAction/);
  });

  test('payload сериализуется в hidden-поле для server action', () => {
    expect(src).toMatch(/name="payload"/);
  });

  test('preview totalCost подсчитывается на клиенте, но исходник истины — backend', () => {
    // Наличие preview (toNumber + reduce) и пометки про backend.
    expect(src).toMatch(/toNumber\(/);
    expect(src).toMatch(/Предварительный итог/);
    expect(src).toMatch(/рассчитает backend/);
  });

  test('при выборе workshopNeedId подтягиваются description / unit / materialRole', () => {
    expect(src).toMatch(/handleNeedChange/);
    expect(src).toMatch(/need\.description/);
    expect(src).toMatch(/need\.unit/);
    expect(src).toMatch(/need\.materialRole/);
  });
});

// ---------------------------------------------------------------------------
// 9. CreateMaterialIssueButton: RBAC видимости (через canManage в section)
// ---------------------------------------------------------------------------

describe('CreateMaterialIssueButton — видимость через canManage', () => {
  const sectionSrc = read(SECTION_PATH);
  const buttonSrc = read(BUTTON_PATH);

  test("button помечен 'use client'", () => {
    expect(buttonSrc.startsWith("'use client'")).toBe(true);
  });

  test('section рендерит кнопку только если canManage=true', () => {
    // `actions={ canManage ? <CreateMaterialIssueButton … /> : undefined }`
    expect(sectionSrc).toMatch(
      /canManage\s*\?[\s\S]*?<CreateMaterialIssueButton\b[\s\S]*?:\s*undefined/,
    );
  });

  test('текст кнопки — «Создать расход»', () => {
    expect(buttonSrc).toMatch(/Создать расход/);
  });
});

// ---------------------------------------------------------------------------
// 10. MaterialIssueStatusBadge: лейблы всех трёх статусов
// ---------------------------------------------------------------------------

describe('MaterialIssueStatusBadge — лейблы и тоны', () => {
  const src = read(STATUS_BADGE_PATH);

  test('использует общий AdminStatusBadge + shared-словарь лейблов', () => {
    expect(src).toMatch(/AdminStatusBadge/);
    expect(src).toMatch(/MATERIAL_ISSUE_STATUS_LABELS/);
  });

  test('маппинг тонов: DRAFT → muted / POSTED → success / CANCELLED → danger', () => {
    expect(src).toMatch(/case ['"]DRAFT['"]:[\s\S]*?return ['"]muted['"]/);
    expect(src).toMatch(/case ['"]POSTED['"]:[\s\S]*?return ['"]success['"]/);
    expect(src).toMatch(/case ['"]CANCELLED['"]:[\s\S]*?return ['"]danger['"]/);
  });
});

// ---------------------------------------------------------------------------
// 11. Sanity: backend endpoints и RBAC пути не меняли
// ---------------------------------------------------------------------------

describe('Backend НЕ меняли (frontend-only итерация)', () => {
  test('MaterialIssuesController существует и RBAC — ADMIN / SHOP_MANAGER', () => {
    const src = read(
      'apps/api/src/modules/material-issues/material-issues.controller.ts',
    );
    expect(src).toMatch(/@Controller\(['"]material-issues['"]\)/);
    expect(src).toMatch(/@Roles\(\s*['"]ADMIN['"],\s*['"]SHOP_MANAGER['"]\s*\)/);
  });

  test('MaterialIssuesOrderController отдаёт /orders/:id/material-issues', () => {
    const src = read(
      'apps/api/src/modules/material-issues/material-issues.order-controller.ts',
    );
    expect(src).toMatch(/@Get\(['"]\:orderId\/material-issues['"]\)/);
  });

  test('отдельная страница /admin/material-issues НЕ создавалась', () => {
    expect(exists('apps/web/app/admin/material-issues/page.tsx')).toBe(false);
    expect(exists('apps/web/app/admin/material-issues')).toBe(false);
  });
});
