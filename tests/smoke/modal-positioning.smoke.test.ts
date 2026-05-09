/**
 * Smoke-тесты viewport-центрирования модальных окон.
 *
 * Контекст: до фикса (см. `docs/modal-positioning-recon.md`)
 * на длинных admin-страницах (`/admin/printers/[id]`, `/admin/warehouses/[id]`)
 * модалка «Печать» открывалась так, что footer-кнопки (`Печать`,
 * `Отмена`) оказывались ниже видимой области viewport — пользователь
 * не мог дотянуться до submit без скролла всей страницы.
 *
 * Регресс ловим текстовыми ассертами по `apps/web/app/globals.css`,
 * чтобы при любой будущей перестройке стилей модалок невозможно
 * было случайно вернуть `position: absolute` для overlay,
 * `align-items: stretch` без `margin: auto` или `100vh` без
 * fallback'ов. React-рендер в проекте отсутствует (vitest в Node),
 * поэтому идём тем же путём, что и `employee-qr-button.smoke.test.ts`,
 * `route-hint-modal.smoke.test.ts`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

/**
 * Извлекает тело CSS-правила (от `{` до соответствующей `}`) для
 * заданного селектора. Не парсер, а простая регулярка с балансом
 * скобок — нам хватит для проверки одиночных deklaration-блоков.
 */
function readRuleBody(css: string, selector: string): string {
  const idx = css.indexOf(selector + ' {');
  if (idx === -1) {
    throw new Error(`CSS rule not found: ${selector}`);
  }
  const start = css.indexOf('{', idx);
  let depth = 0;
  for (let i = start; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) return css.slice(start + 1, i);
    }
  }
  throw new Error(`Unbalanced braces in CSS for: ${selector}`);
}

describe('modal positioning — overlay всегда фиксирован относительно viewport', () => {
  const css = readSrc('apps/web/app/globals.css');

  test('.qr-modal — fixed inset overlay с overlay-scroll и без stretch', () => {
    const body = readRuleBody(css, '.qr-modal');
    expect(body).toMatch(/position:\s*fixed/);
    expect(body).toMatch(/inset:\s*0/);
    expect(body).toMatch(/overflow-y:\s*auto/);
    expect(body).toMatch(/overscroll-behavior:\s*contain/);
    expect(body).toMatch(/justify-content:\s*center/);
    // align-items: stretch ломал центрирование на длинных карточках.
    expect(body).not.toMatch(/align-items:\s*stretch/);
  });

  test('.qr-modal__card — viewport-bounded width, без max-height: 100dvh без overlay-fallback', () => {
    const body = readRuleBody(css, '.qr-modal__card');
    expect(body).toMatch(/width:\s*min\(/);
    expect(body).toMatch(/margin:\s*auto/);
    expect(body).toMatch(/display:\s*flex/);
    expect(body).toMatch(/flex-direction:\s*column/);
  });

  test('.modal-backdrop — fixed inset overlay с overlay-scroll', () => {
    const body = readRuleBody(css, '.modal-backdrop');
    expect(body).toMatch(/position:\s*fixed/);
    expect(body).toMatch(/inset:\s*0/);
    expect(body).toMatch(/overflow-y:\s*auto/);
    expect(body).toMatch(/overscroll-behavior:\s*contain/);
    expect(body).toMatch(/justify-content:\s*center/);
  });

  test('.modal — viewport-bounded width, центр через margin: auto', () => {
    const body = readRuleBody(css, '.modal');
    expect(body).toMatch(/width:\s*min\(/);
    expect(body).toMatch(/margin:\s*auto/);
    expect(body).toMatch(/display:\s*flex/);
    expect(body).toMatch(/flex-direction:\s*column/);
  });

  test('.master-actions-sheet — fixed inset bottom-sheet с dvh-aware max-height', () => {
    const overlay = readRuleBody(css, '.master-actions-sheet');
    expect(overlay).toMatch(/position:\s*fixed/);
    expect(overlay).toMatch(/inset:\s*0/);
    expect(overlay).toMatch(/align-items:\s*flex-end/);

    const card = readRuleBody(css, '.master-actions-sheet__card');
    expect(card).toMatch(/max-height:\s*92dvh/);
    expect(card).toMatch(/overflow-y:\s*auto/);
  });

  test('.admin-size-plan-modal__backdrop — fixed inset overlay с overlay-scroll', () => {
    const body = readRuleBody(css, '.admin-size-plan-modal__backdrop');
    expect(body).toMatch(/position:\s*fixed/);
    expect(body).toMatch(/inset:\s*0/);
    expect(body).toMatch(/overflow-y:\s*auto/);
    expect(body).toMatch(/overscroll-behavior:\s*contain/);
    expect(body).toMatch(/justify-content:\s*center/);
  });

  test('.admin-size-plan-modal — dvh-aware max-height, body-scroll', () => {
    const card = readRuleBody(css, '.admin-size-plan-modal');
    expect(card).toMatch(/max-height:\s*calc\(100dvh\s*-\s*2rem\)/);
    expect(card).toMatch(/display:\s*flex/);
    expect(card).toMatch(/flex-direction:\s*column/);
    expect(card).toMatch(/overflow:\s*hidden/);

    const cardBody = readRuleBody(css, '.admin-size-plan-modal__body');
    expect(cardBody).toMatch(/overflow-y:\s*auto/);
  });
});

describe('modal positioning — footer/actions остаются доступны', () => {
  const css = readSrc('apps/web/app/globals.css');

  test('.modal__actions — flex-shrink: 0, footer не сжимается', () => {
    const body = readRuleBody(css, '.modal__actions');
    expect(body).toMatch(/flex:\s*0\s+0\s+auto/);
  });

  test('.qr-modal__cancel — flex-shrink: 0, кнопка «Закрыть» закреплена', () => {
    const body = readRuleBody(css, '.qr-modal__cancel');
    expect(body).toMatch(/flex:\s*0\s+0\s+auto/);
  });

  test('.passport-confirm__actions — flex-shrink: 0, кнопки в карточке закреплены', () => {
    const body = readRuleBody(css, '.passport-confirm__actions');
    expect(body).toMatch(/flex:\s*0\s+0\s+auto/);
  });

  test('.bulk-print-modal__card — bounded по dvh, flex-column, overflow:hidden', () => {
    const body = readRuleBody(css, '.bulk-print-modal__card');
    // Главная защита от регресса: карточка не имеет права снова
    // расти выше viewport. Иначе footer уезжает ниже экрана
    // (`docs/warehouse-bulk-print-modal-runtime-recon.md` §9).
    expect(body).toMatch(/max-height:\s*calc\(100dvh\s*-\s*2rem\)/);
    expect(body).toMatch(/overflow:\s*hidden/);
    // Карточка — flex-column контейнер для header / form / footer.
    expect(body).toMatch(/display:\s*flex/);
    expect(body).toMatch(/flex-direction:\s*column/);
  });

  test('.bulk-print-modal__form — flex-grow внутри карточки, без overflow за пределы', () => {
    // Сама форма не скроллится — она просто оборачивает body как
    // flex-column. Скролл живёт на `.bulk-print-modal__body` (см.
    // ниже), что даёт UX «один scroll-context на модалку».
    const body = readRuleBody(css, '.bulk-print-modal__form');
    expect(body).toMatch(/display:\s*flex/);
    expect(body).toMatch(/flex-direction:\s*column/);
    expect(body).toMatch(/flex:\s*1\s+1\s+auto/);
    expect(body).toMatch(/min-height:\s*0/);
    expect(body).toMatch(/overflow:\s*hidden/);
  });

  test('.bulk-print-modal__body — единственный scrollable child карточки', () => {
    // Single-scroll-context: body — единственное место, где живёт
    // вертикальный скролл. Footer (.bulk-print-modal__footer) лежит
    // снаружи body и снаружи формы — поэтому всегда виден.
    const body = readRuleBody(css, '.bulk-print-modal__body');
    expect(body).toMatch(/flex:\s*1\s+1\s+auto/);
    expect(body).toMatch(/min-height:\s*0/);
    expect(body).toMatch(/overflow-y:\s*auto/);
    expect(body).toMatch(/display:\s*flex/);
    expect(body).toMatch(/flex-direction:\s*column/);
  });

  test('.bulk-print-modal__footer — фикс-высота, прижат к низу карточки, виден без скролла', () => {
    // Footer лежит **вне формы** (submit-кнопка использует form={id}),
    // поэтому он гарантированно вне scroll-зоны body — не зависит от
    // длины preview и доступен сразу после открытия модалки.
    const body = readRuleBody(css, '.bulk-print-modal__footer');
    expect(body).toMatch(/flex:\s*0\s+0\s+auto/);
    expect(body).toMatch(/border-top:/);
    expect(body).toMatch(/justify-content:\s*flex-end/);
  });
});

/**
 * Regression guard: bulk-print modal раньше использовал на форме два
 * класса (`bulk-print-modal__form admin-form`) с разной layout-моделью
 * (flex-column ↔ grid). Они конкурировали с равной специфичностью, и
 * `.admin-form { display: grid }` выигрывал по source-order — это
 * валило весь footer-anchor layout. Решение (Option A из
 * `docs/warehouse-bulk-print-modal-runtime-recon.md` §10): убрать
 * `.admin-form` с формы и вынести actions в `<footer>` СНАРУЖИ формы.
 * Тесты ниже стерегут от возврата конфликта.
 */
describe('modal positioning — bulk-print form layout без класс-конфликтов', () => {
  test('JSX-форма не использует .admin-form вместе с .bulk-print-modal__form (cascade-trap)', () => {
    const src = readSrc(
      'apps/web/app/admin/warehouses/[id]/bulk-print-panel.tsx',
    );
    // Если кто-то добавит `admin-form` обратно — снова получим
    // grid vs flex конфликт. Не пускаем.
    expect(src).not.toMatch(/className=["']bulk-print-modal__form\s+admin-form/);
    expect(src).not.toMatch(/className=["']admin-form\s+bulk-print-modal__form/);
  });

  test('JSX-footer лежит СНАРУЖИ формы как <footer> с .bulk-print-modal__footer', () => {
    const src = readSrc(
      'apps/web/app/admin/warehouses/[id]/bulk-print-panel.tsx',
    );
    // Footer-теги вне <form>: иначе footer попадает в form-grid/flex
    // и поведение footer-anchor ломается.
    expect(src).toMatch(/<\/form>\s*\n\s*<footer\s+className=["']bulk-print-modal__footer/);
  });

  test('JSX-submit использует form={formId} — кнопка «Печать» вне <form>, но логически принадлежит ей', () => {
    const src = readSrc(
      'apps/web/app/admin/warehouses/[id]/bulk-print-panel.tsx',
    );
    // HTML5: `form={id}` — нативный способ держать submit снаружи
    // <form> без потери семантики.
    expect(src).toMatch(/<form\s+id=\{formId\}/);
    expect(src).toMatch(/type=["']submit["'][\s\S]{0,80}form=\{formId\}/);
  });

  test('CSS не содержит мёртвых правил .bulk-print-modal__settings / .bulk-print-modal__actions', () => {
    const css = readSrc('apps/web/app/globals.css');
    // В JSX используются `admin-form-grid` и `bulk-print-modal__footer`.
    // `.bulk-print-modal__settings` и `.bulk-print-modal__actions`
    // никогда не матчили DOM — их удалили вместе со структурным фиксом.
    expect(css).not.toMatch(/\.bulk-print-modal__settings\b/);
    expect(css).not.toMatch(/\.bulk-print-modal__actions\b/);
  });

  test('@keyframes admin-page-appear не использует transform (containing-block ловушка для position: fixed)', () => {
    const css = readSrc('apps/web/app/globals.css');
    // `.admin-page-shell` имеет `animation: admin-page-appear ... both`.
    // С `animation-fill-mode: both` финальный кадр приклеивается навсегда,
    // и любой `transform` (даже translateY(0)) делает page-shell
    // containing block'ом для `position: fixed` потомков. Это ломало
    // overlay-модалки внутри admin-страниц (см. recon).
    const idx = css.indexOf('@keyframes admin-page-appear');
    expect(idx, '@keyframes admin-page-appear должен существовать').toBeGreaterThan(-1);
    const start = css.indexOf('{', idx);
    let depth = 0;
    let end = start;
    for (let i = start; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    const body = css.slice(start + 1, end);
    expect(body).not.toMatch(/transform:/);
  });

  test('ModalPortal helper существует и использует createPortal в document.body', () => {
    const src = readSrc('apps/web/components/modal-portal.tsx');
    // Единая точка реализации Portal-паттерна. Если кто-то её удалит
    // или поменяет цель, все consumer-модалки могут начать
    // позиционироваться неправильно — ловим тестом.
    expect(src).toMatch(/import\s*\{\s*createPortal\s*\}\s*from\s*['"]react-dom['"]/);
    expect(src).toMatch(/createPortal\(children,\s*document\.body\)/);
    expect(src).toMatch(/export\s+function\s+ModalPortal/);
  });

  test('все overlay-модалки рендерятся через <ModalPortal>', () => {
    // Контракт: каждая модалка с `position: fixed` overlay'ем
    // оборачивается в `<ModalPortal>`, чтобы обойти
    // transformed-ancestor'ов (см. recon про `.admin-page-shell`).
    const modals = [
      'apps/web/app/admin/warehouses/[id]/bulk-print-panel.tsx',
      'apps/web/app/admin/patterns/[id]/add-pattern-size-modal.tsx',
      'apps/web/app/admin/patterns/[id]/create-size-modal.tsx',
      'apps/web/app/admin/orders/new/size-plan-selector.tsx',
      'apps/web/app/master/passport-actions-sheet.tsx',
      'apps/web/app/master/cut-release-policy-card.tsx',
      'apps/web/app/work/seamstress-active-panel.tsx',
      'apps/web/app/work/passport-confirm-modal.tsx',
      'apps/web/app/work/qr-scanner-modal.tsx',
      'apps/web/app/work/shelf-placement-panel.tsx',
      'apps/web/components/employees/employee-qr-button.tsx',
    ];
    for (const file of modals) {
      const src = readSrc(file);
      expect(
        src,
        `${file} должен импортировать ModalPortal`,
      ).toMatch(/import\s*\{[^}]*ModalPortal[^}]*\}\s*from\s*['"]@\/components\/modal-portal['"]/);
      expect(
        src,
        `${file} должен оборачивать overlay в <ModalPortal>`,
      ).toMatch(/<ModalPortal>/);
    }
  });
});

describe('modal positioning — никакая модалка не использует position: absolute для overlay', () => {
  const css = readSrc('apps/web/app/globals.css');

  test('overlay-классы используют position: fixed, не absolute', () => {
    const overlays = [
      '.qr-modal',
      '.modal-backdrop',
      '.master-actions-sheet',
      '.admin-size-plan-modal__backdrop',
    ];
    for (const sel of overlays) {
      const body = readRuleBody(css, sel);
      expect(body, `${sel} должен быть position: fixed`).toMatch(
        /position:\s*fixed/,
      );
      expect(
        body,
        `${sel} не должен быть position: absolute (overlay должен быть фиксирован к viewport, а не к странице)`,
      ).not.toMatch(/position:\s*absolute/);
    }
  });
});

describe('modal positioning — printer и bulk-print page обвязки', () => {
  test('bulk-print-panel.tsx использует общий `.qr-modal` overlay-паттерн', () => {
    const src = readSrc(
      'apps/web/app/admin/warehouses/[id]/bulk-print-panel.tsx',
    );
    // Модалка использует общий overlay-паттерн `.qr-modal`.
    expect(src).toMatch(/className="qr-modal"/);
    expect(src).toMatch(/role="dialog"/);
    expect(src).toMatch(/aria-modal="true"/);
    // Card / form / body / footer — структурные секции Option A+
    // (см. `docs/warehouse-bulk-print-modal-runtime-recon.md` §10):
    expect(src).toMatch(/className="qr-modal__card bulk-print-modal__card"/);
    expect(src).toMatch(/className="bulk-print-modal__form"/);
    expect(src).toMatch(/className="bulk-print-modal__body"/);
    expect(src).toMatch(/className="bulk-print-modal__footer"/);
    // Кнопка submit называется «Печать» — это именно то, что не
    // должно уезжать ниже экрана.
    expect(src).toMatch(/Печать/);
    expect(src).toMatch(/type="submit"/);
  });

  test('printer detail page не использует inline position для footer-кнопки печати', () => {
    const src = readSrc(
      'apps/web/app/admin/printers/[id]/test-print-form.tsx',
    );
    // Кнопка «Печать» не делается position: fixed/absolute на самой
    // себе — она лежит в обычном flow и зависит от позиции карточки
    // «Тест печати» на странице. Это форма, а не модалка.
    expect(src).not.toMatch(/position:\s*fixed/);
    expect(src).not.toMatch(/position:\s*absolute/);
    expect(src).toMatch(/type="submit"/);
    expect(src).toMatch(/Печать/);
  });
});

describe('modal positioning — RECON документ опубликован', () => {
  test('docs/modal-positioning-recon.md содержит inventory и fix plan', () => {
    const src = readSrc('docs/modal-positioning-recon.md');
    expect(src).toMatch(/Modal Positioning RECON/);
    expect(src).toMatch(/## 2\. Modal inventory/);
    expect(src).toMatch(/## 3\. Root cause/);
    expect(src).toMatch(/## 4\. Target behavior/);
    expect(src).toMatch(/## 5\. Fix plan/);
    // Главная цель — кнопка «Печать» на длинных admin-страницах.
    expect(src).toMatch(/Печать/);
    expect(src).toMatch(/qr-modal/);
    expect(src).toMatch(/bulk-print-modal/);
  });
});
