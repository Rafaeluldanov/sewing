/**
 * Source-level smoke-тесты PHASE 1 payroll admin UI
 * (см. `apps/web/app/admin/payroll/*`,
 * `apps/web/components/admin-sidebar.tsx`,
 * `apps/web/lib/payroll-api.ts`).
 *
 * Зачем: рендера React в проекте нет (vitest + Node, без jsdom),
 * поэтому фиксируем структуру на уровне исходников. Этого достаточно,
 * чтобы поймать регресс «убрали страницу `/admin/payroll/daily`» или
 * «случайно вырезали пункт «Зарплата» из sidebar».
 *
 * Парный пример — `tests/smoke/admin-sidebar-navigation.smoke.test.ts`,
 * `tests/smoke/employees-admin.smoke.test.ts`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

// ---------------------------------------------------------------------------
// 1. Все четыре payroll-страницы существуют и используют AdminPageShell
// ---------------------------------------------------------------------------

const PAYROLL_ROUTE_FILES = [
  'apps/web/app/admin/payroll/page.tsx',
  'apps/web/app/admin/payroll/daily/page.tsx',
  'apps/web/app/admin/payroll/employees/[id]/page.tsx',
  'apps/web/app/admin/payroll/settings/page.tsx',
] as const;

describe('PHASE 1 payroll admin UI — страницы существуют', () => {
  test.each(PAYROLL_ROUTE_FILES)('%s существует', (file) => {
    expect(() => readSrc(file)).not.toThrow();
  });

  test.each(PAYROLL_ROUTE_FILES)(
    '%s использует AdminPageShell (унифицированный header)',
    (file) => {
      const src = readSrc(file);
      expect(src).toMatch(/AdminPageShell/);
    },
  );
});

// ---------------------------------------------------------------------------
// 2. Period page подгружает payroll API и рендерит ключевые элементы
// ---------------------------------------------------------------------------

describe('/admin/payroll — ведомость за период', () => {
  test('страница вызывает getPayrollPeriod из @/lib/payroll-api', () => {
    const src = readSrc('apps/web/app/admin/payroll/page.tsx');
    expect(src).toMatch(/from\s+['"]@\/lib\/payroll-api['"]/);
    expect(src).toMatch(/getPayrollPeriod/);
  });

  test('страница содержит фильтры dateFrom/dateTo/employeeId/role/divisionCode/status', () => {
    const src = readSrc('apps/web/app/admin/payroll/page.tsx');
    expect(src).toMatch(/name="dateFrom"/);
    expect(src).toMatch(/name="dateTo"/);
    expect(src).toMatch(/name="employeeId"/);
    expect(src).toMatch(/name="role"/);
    expect(src).toMatch(/name="divisionCode"/);
    expect(src).toMatch(/name="status"/);
  });

  test('страница рендерит KPI-карточки (kpi-grid)', () => {
    const src = readSrc('apps/web/app/admin/payroll/page.tsx');
    expect(src).toMatch(/kpi-grid/);
    expect(src).toMatch(/Утверждено/);
    expect(src).toMatch(/Ожидает/);
    expect(src).toMatch(/Оклад/);
    expect(src).toMatch(/Сдельно/);
  });

  test('строка таблицы ссылается на drill-down /admin/payroll/employees/:id', () => {
    const src = readSrc('apps/web/app/admin/payroll/page.tsx');
    expect(src).toMatch(/\/admin\/payroll\/employees\//);
  });
});

// ---------------------------------------------------------------------------
// 3. Daily page
// ---------------------------------------------------------------------------

describe('/admin/payroll/daily — снимок дня', () => {
  test('страница вызывает getPayrollDaily', () => {
    const src = readSrc('apps/web/app/admin/payroll/daily/page.tsx');
    expect(src).toMatch(/getPayrollDaily/);
    expect(src).toMatch(/name="date"/);
  });

  test('страница показывает «Открыта/Закрыта» как AdminStatusBadge', () => {
    const src = readSrc('apps/web/app/admin/payroll/daily/page.tsx');
    expect(src).toMatch(/AdminStatusBadge/);
    expect(src).toMatch(/Открыта/);
    expect(src).toMatch(/Закрыта/);
  });
});

// ---------------------------------------------------------------------------
// 4. Employee detail page
// ---------------------------------------------------------------------------

describe('/admin/payroll/employees/[id] — карточка сотрудника', () => {
  test('страница вызывает getPayrollEmployee и рендерит три таблицы', () => {
    const src = readSrc(
      'apps/web/app/admin/payroll/employees/[id]/page.tsx',
    );
    expect(src).toMatch(/getPayrollEmployee/);
    // Заголовки трёх таблиц
    expect(src).toMatch(/title="Смены"/);
    expect(src).toMatch(/title="Сдельные начисления"/);
    expect(src).toMatch(/title="Окладные начисления"/);
  });

  test('страница ведёт обратно на /admin/payroll и на карточку сотрудника', () => {
    const src = readSrc(
      'apps/web/app/admin/payroll/employees/[id]/page.tsx',
    );
    expect(src).toMatch(/href="\/admin\/payroll"/);
    expect(src).toMatch(/\/admin\/employees\//);
  });

  test('страница не делает мутаций (PHASE 1, read-only): нет POST/PATCH', () => {
    const src = readSrc(
      'apps/web/app/admin/payroll/employees/[id]/page.tsx',
    );
    // Не используем server actions / мутирующих fetch'ей с этой
    // страницы. Если в PHASE 2 добавим editor — тест надо обновить
    // вместе с обновлённым ADR.
    expect(src).not.toMatch(/method:\s*['"]POST['"]/);
    expect(src).not.toMatch(/method:\s*['"]PATCH['"]/);
  });
});

// ---------------------------------------------------------------------------
// 5. Settings hub
// ---------------------------------------------------------------------------

describe('/admin/payroll/settings — навигационный hub без новых настроек', () => {
  test('страница ссылается на /admin/operations, /admin/employees, /admin/company-settings', () => {
    const src = readSrc('apps/web/app/admin/payroll/settings/page.tsx');
    expect(src).toMatch(/href="\/admin\/operations"/);
    expect(src).toMatch(/href="\/admin\/employees"/);
    expect(src).toMatch(/href="\/admin\/company-settings"/);
  });

  test('страница не вводит form/PATCH (PHASE 1: только ссылки)', () => {
    const src = readSrc('apps/web/app/admin/payroll/settings/page.tsx');
    expect(src).not.toMatch(/<form\b/);
  });
});

// ---------------------------------------------------------------------------
// 6. Sidebar — пункт «Зарплата» с иконкой BadgeRussianRuble
// ---------------------------------------------------------------------------

describe('AdminSidebar — пункт «Зарплата»', () => {
  test('sidebar содержит href /admin/payroll, label «Зарплата», иконку BadgeRussianRuble', () => {
    const src = readSrc('apps/web/components/admin-sidebar.tsx');
    expect(src).toMatch(/href:\s*['"]\/admin\/payroll['"]/);
    expect(src).toMatch(/label:\s*['"]Зарплата['"]/);
    expect(src).toMatch(/Icon:\s*BadgeRussianRuble/);
  });

  test('BadgeRussianRuble импортирован из lucide-react', () => {
    const src = readSrc('apps/web/components/admin-sidebar.tsx');
    expect(src).toMatch(/BadgeRussianRuble/);
  });
});

// ---------------------------------------------------------------------------
// 7. payroll-api.ts — три read-only метода, никаких мутаций
// ---------------------------------------------------------------------------

describe('payroll-api.ts — клиент', () => {
  test('экспортирует три метода: getPayrollPeriod / getPayrollDaily / getPayrollEmployee', () => {
    const src = readSrc('apps/web/lib/payroll-api.ts');
    expect(src).toMatch(/export\s+function\s+getPayrollPeriod\b/);
    expect(src).toMatch(/export\s+function\s+getPayrollDaily\b/);
    expect(src).toMatch(/export\s+function\s+getPayrollEmployee\b/);
  });

  test('не содержит ни POST, ни PATCH (PHASE 1 read-only)', () => {
    const src = readSrc('apps/web/lib/payroll-api.ts');
    expect(src).not.toMatch(/method:\s*['"]POST['"]/);
    expect(src).not.toMatch(/method:\s*['"]PATCH['"]/);
    expect(src).not.toMatch(/method:\s*['"]DELETE['"]/);
  });
});

// ---------------------------------------------------------------------------
// 8. Backend payroll module — RBAC и read-only контракт
// ---------------------------------------------------------------------------

describe('backend payroll module', () => {
  test('PayrollController закрыт @Roles SHOP_MANAGER + ADMIN', () => {
    const src = readSrc(
      'apps/api/src/modules/payroll/payroll.controller.ts',
    );
    expect(src).toMatch(/@Controller\(['"]payroll['"]\)/);
    expect(src).toMatch(
      /@Roles\(\s*['"]SHOP_MANAGER['"]\s*,\s*['"]ADMIN['"]\s*\)/,
    );
    expect(src).toMatch(/@Get\(['"]period['"]\)/);
    expect(src).toMatch(/@Get\(['"]daily['"]\)/);
    expect(src).toMatch(/@Get\(['"]employees\/:id['"]\)/);
  });

  test('PayrollController не имеет ни одного @Post / @Patch / @Delete', () => {
    const src = readSrc(
      'apps/api/src/modules/payroll/payroll.controller.ts',
    );
    expect(src).not.toMatch(/@Post\(/);
    expect(src).not.toMatch(/@Patch\(/);
    expect(src).not.toMatch(/@Delete\(/);
    expect(src).not.toMatch(/@Put\(/);
  });

  test('PayrollService использует только Prisma read API (никаких create/update/delete)', () => {
    const src = readSrc(
      'apps/api/src/modules/payroll/payroll.service.ts',
    );
    expect(src).not.toMatch(/\bprisma\.[a-zA-Z]+\.create\(/);
    expect(src).not.toMatch(/\bprisma\.[a-zA-Z]+\.update\(/);
    expect(src).not.toMatch(/\bprisma\.[a-zA-Z]+\.delete\(/);
    expect(src).not.toMatch(/\bprisma\.[a-zA-Z]+\.upsert\(/);
    expect(src).not.toMatch(/\bprisma\.\$transaction\(/);
  });
});

// ---------------------------------------------------------------------------
// 9. Существующий /earnings экран не сломан и подсказывает менеджеру
// ---------------------------------------------------------------------------

describe('/earnings — manager hint про /admin/payroll', () => {
  test('страница оставляет личные начисления и добавляет ссылку для менеджеров', () => {
    const src = readSrc('apps/web/app/earnings/page.tsx');
    expect(src).toMatch(/href="\/admin\/payroll"/);
  });
});

// ---------------------------------------------------------------------------
// 10. Карточка сотрудника в админке имеет CTA на payroll
// ---------------------------------------------------------------------------

describe('/admin/employees/[id] — CTA «Открыть в Зарплате»', () => {
  test('карточка содержит блок «Зарплата за период» с ссылкой', () => {
    const src = readSrc('apps/web/app/admin/employees/[id]/page.tsx');
    expect(src).toMatch(/Зарплата за период/);
    expect(src).toMatch(/\/admin\/payroll\/employees\//);
  });
});
