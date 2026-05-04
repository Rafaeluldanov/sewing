/**
 * Smoke-тест: все рабочие места сотрудников используют новый дизайн.
 *
 * Что фиксируем (см. `docs/design-cleanup-recon.md §3` и
 * `docs/ui-mobile.md`):
 *
 *   1. SEAMSTRESS / CUTTER / CUTTER_ASSISTANT (`/work/page.tsx`),
 *      QC (`/qc/page.tsx`), IRONING (`/wto/page.tsx`),
 *      PACKING (`/packing/page.tsx`) рендерят `<RoleHeaderCard>` —
 *      фирменную синюю шапку-профиль Шага 13.
 *   2. SHOPFLOOR_MASTER (`/master/page.tsx` → `MasterPageClient`) —
 *      на класс `.master-page` (fullscreen-вариант, см.
 *      `docs/screens.md §«/master»`).
 *   3. Все 4 терминальных layout'а импортируют `<EmployeeQrButton>`
 *      и закрывают видимость `canSeeEmployeeQrButton(role)`.
 *      Это регресс-страховка к существующему
 *      `employee-qr-button.smoke.test.ts`.
 *   4. На рабочих экранах остаётся канонический контейнер
 *      `.seamstress-work` (см. `globals.css §"Терминал швеи"`).
 *
 * RBAC-доступы и редиректы покрываются `frontend-rbac.smoke.test.ts`,
 * `qc-start-shift.smoke.test.ts`, `wto-start-shift.smoke.test.ts`,
 * `master-layout.smoke.test.ts` — здесь только дизайн-инварианты.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

interface Workplace {
  /** Человекочитаемое имя для test.title. */
  label: string;
  /** Файл SSR-страницы, который должен рендерить `<RoleHeaderCard>`. */
  page: string;
  /** Файл client-терминала с контейнером `.seamstress-work`. */
  terminalContainer?: string;
}

const WORKPLACES: Workplace[] = [
  {
    label: 'SEAMSTRESS / CUTTER / CUTTER_ASSISTANT (/work)',
    page: 'apps/web/app/work/page.tsx',
    terminalContainer: 'apps/web/app/work/seamstress-active-panel.tsx',
  },
  {
    label: 'QC (/qc)',
    page: 'apps/web/app/qc/page.tsx',
    terminalContainer: 'apps/web/app/qc/qc-terminal.tsx',
  },
  {
    label: 'IRONING (/wto)',
    page: 'apps/web/app/wto/page.tsx',
    terminalContainer: 'apps/web/app/wto/wto-terminal.tsx',
  },
  {
    label: 'PACKING (/packing)',
    page: 'apps/web/app/packing/page.tsx',
    terminalContainer: 'apps/web/app/packing/packing-terminal.tsx',
  },
];

describe('employee workplaces — новый дизайн на месте', () => {
  for (const wp of WORKPLACES) {
    test(`${wp.label}: страница рендерит RoleHeaderCard`, () => {
      const src = readSrc(wp.page);
      expect(src).toMatch(/RoleHeaderCard/);
      // Не должны вернуться к голому <h1>... — только если рядом есть
      // canonical hero. У `/packing` SHOP_MANAGER-fork оставлен с
      // <h1>Упаковка</h1> внутри manager-вью; терминал PACKING выше
      // уже использует RoleHeaderCard. Для всех 4 файлов это так.
    });
    if (wp.terminalContainer) {
      test(`${wp.label}: терминал использует канонический .seamstress-work контейнер`, () => {
        const src = readSrc(wp.terminalContainer!);
        expect(src).toMatch(/seamstress-work/);
      });
    }
  }

  test('SHOPFLOOR_MASTER (/master): MasterPageClient использует .master-page', () => {
    const clientSrc = readSrc(
      'apps/web/app/master/master-page-client.tsx',
    );
    expect(clientSrc).toMatch(/className="master-page"/);
    // На странице master — крупная карточка вызова, не таблица.
    expect(clientSrc).toMatch(/master-call-card/);
  });

  test('все 4 layout-а employee-секций показывают «Мой QR-код» под RBAC', () => {
    // Дублирует ранее зафиксированное в `employee-qr-button.smoke.test.ts`,
    // но нам важно проверить именно «дизайн рабочих мест целостный»:
    // если в какой-то секции пропал импорт EmployeeQrButton — это
    // регресс UI рабочего места.
    const layouts = [
      'apps/web/app/work/layout.tsx',
      'apps/web/app/qc/layout.tsx',
      'apps/web/app/wto/layout.tsx',
      'apps/web/app/packing/layout.tsx',
    ];
    for (const f of layouts) {
      const src = readSrc(f);
      expect(src).toMatch(/canSeeEmployeeQrButton/);
      expect(src).toMatch(/<EmployeeQrButton\b/);
    }
  });

  test('никакой страницы рабочего места не использует устаревшие admin-классы', () => {
    // Регрессия: проверяем, что terminal-страницы не подцепили
    // старые admin-таблицы / admin-grid (это часть `/admin/*`,
    // но не employee-flow). См. `docs/design-cleanup-recon.md §4`.
    const clients = [
      'apps/web/app/work/seamstress-active-panel.tsx',
      'apps/web/app/qc/qc-terminal.tsx',
      'apps/web/app/wto/wto-terminal.tsx',
      'apps/web/app/packing/packing-terminal.tsx',
      'apps/web/app/master/master-page-client.tsx',
    ];
    for (const f of clients) {
      const src = readSrc(f);
      expect(src).not.toMatch(/className="admin-card"/);
      expect(src).not.toMatch(/className="admin-table"/);
      expect(src).not.toMatch(/className="admin-page-shell"/);
    }
  });

  test('DISPLAY (/shopfloor/display) — изолирован, не трогает .seamstress-work', () => {
    // DISPLAY использует свою CSS-семью (`.display-screen`,
    // `.display-screen__matrix` и т.д.). Это сознательное исключение
    // — TV-friendly витрина, см. `docs/design-cleanup-recon.md §6`.
    const boardSrc = readSrc(
      'apps/web/app/shopfloor/display/display-board.tsx',
    );
    expect(boardSrc).not.toMatch(/seamstress-work/);
    // И сама роль DISPLAY не получает кнопку «Мой QR-код» (см. RBAC).
    const layoutSrc = readSrc(
      'apps/web/app/shopfloor/display/layout.tsx',
    );
    expect(layoutSrc).not.toMatch(/EmployeeQrButton/);
  });
});
