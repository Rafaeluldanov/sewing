/**
 * Smoke-тест unified shopfloor namespace
 * (`apps/web/components/shopfloor/index.ts`).
 *
 * Цель — зафиксировать контракт «единая точка входа для рабочих
 * мест сотрудников»: новые экраны должны импортировать UI-блоки
 * из `@/components/shopfloor`, а сам namespace переэкспортит
 * существующие канонические компоненты, не дублируя их.
 *
 * Vitest идёт в Node без jsdom (см. `seamstress-feedback.smoke.test.ts`),
 * поэтому проверяем контракт текстом исходников + smoke-runtime
 * импортом самого `index.ts` через alias resolver.
 *
 * Полный план — `docs/design-cleanup-recon.md §7 Этап 1` и `§5`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('shopfloor namespace (apps/web/components/shopfloor)', () => {
  const NAMESPACE_INDEX = 'apps/web/components/shopfloor/index.ts';

  test('файлы namespace существуют и читаются', () => {
    expect(() => readSrc(NAMESPACE_INDEX)).not.toThrow();
    expect(() =>
      readSrc('apps/web/components/shopfloor/shopfloor-shell.tsx'),
    ).not.toThrow();
    expect(() =>
      readSrc('apps/web/components/shopfloor/scan-panel.tsx'),
    ).not.toThrow();
    expect(() =>
      readSrc('apps/web/components/shopfloor/production-states.tsx'),
    ).not.toThrow();
  });

  test('index.ts экспортит ожидаемые имена (контракт ТЗ)', () => {
    const src = readSrc(NAMESPACE_INDEX);
    // Тонкие обёртки над существующими CSS-классами:
    expect(src).toMatch(/export\s+\{\s*ShopfloorShell\s*\}/);
    expect(src).toMatch(/export\s+\{\s*ScanPanel\s*\}/);
    expect(src).toMatch(/export\s+\{[\s\S]*ProductionEmptyState[\s\S]*\}/);
    expect(src).toMatch(/export\s+\{[\s\S]*ProductionErrorState[\s\S]*\}/);
    expect(src).toMatch(/export\s+\{[\s\S]*ProductionLoadingState[\s\S]*\}/);

    // Re-exports канонических компонентов (без дублирования логики):
    expect(src).toMatch(/RoleHeaderCard/);
    expect(src).toMatch(/RoleHeaderCard\s+as\s+WorkerStatusCard/);
    expect(src).toMatch(/RoleHeaderCard\s+as\s+ShopfloorPageTitle/);
    expect(src).toMatch(/StatusBadge/);
    expect(src).toMatch(/StatusBadge\s+as\s+ProductionStatusBadge/);
    expect(src).toMatch(/MobileActionCard/);
    expect(src).toMatch(/AppSectionCard/);
    expect(src).toMatch(/Icon/);
    expect(src).toMatch(/EmployeeQrButton/);
  });

  test('namespace не дублирует логику канонических компонентов', () => {
    // Тонкие обёртки лежат в собственных файлах и не пытаются
    // переопределить RoleHeaderCard / StatusBadge / MobileActionCard
    // и т.д. — мы только переэкспортим.
    const shellSrc = readSrc(
      'apps/web/components/shopfloor/shopfloor-shell.tsx',
    );
    expect(shellSrc).not.toMatch(/role-header__/); // не копируем JSX RoleHeaderCard
    expect(shellSrc).not.toMatch(/status-badge/); // не копируем JSX StatusBadge

    const scanSrc = readSrc('apps/web/components/shopfloor/scan-panel.tsx');
    expect(scanSrc).toMatch(/scan-card scan-card--simple/); // используем канонический CSS
    expect(scanSrc).not.toMatch(/'use client'/); // обёртка пассивная

    const statesSrc = readSrc(
      'apps/web/components/shopfloor/production-states.tsx',
    );
    expect(statesSrc).toMatch(/error-box/);
    expect(statesSrc).toMatch(/card empty/);
  });

  test('ShopfloorShell использует канонический класс seamstress-work', () => {
    // Это инвариант: переименовать класс нельзя — на нём построены
    // mobile-first отступы и safe-area, на него опираются терминалы
    // /work, /qc, /wto, /packing. См. `docs/design-cleanup-recon.md §5`.
    const shellSrc = readSrc(
      'apps/web/components/shopfloor/shopfloor-shell.tsx',
    );
    expect(shellSrc).toMatch(/seamstress-work/);
  });

  test('ScanPanel использует канонический класс scan-card.scan-card--simple', () => {
    const scanSrc = readSrc('apps/web/components/shopfloor/scan-panel.tsx');
    expect(scanSrc).toMatch(/scan-card scan-card--simple/);
    expect(scanSrc).toMatch(/scan-card__title/);
    expect(scanSrc).toMatch(/scan-card__hint/);
  });

  test('ProductionErrorState повторяет паттерн error-box из терминалов', () => {
    const src = readSrc(
      'apps/web/components/shopfloor/production-states.tsx',
    );
    expect(src).toMatch(/role="alert"/);
    expect(src).toMatch(/error-box__msg/);
    expect(src).toMatch(/error-box__rid/);
  });

  test('namespace ничего не экспортит из admin/orders/warehouses', () => {
    // Защита от случайного протекания admin-only компонентов в
    // employee-namespace (см. `docs/design-cleanup-recon.md §8`).
    const src = readSrc(NAMESPACE_INDEX);
    expect(src).not.toMatch(/from '\.\.\/admin\//);
    expect(src).not.toMatch(/from '\.\.\/orders\//);
    expect(src).not.toMatch(/from '\.\.\/warehouses\//);
  });
});
