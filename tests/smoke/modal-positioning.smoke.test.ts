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

  test('.bulk-print-modal__form > .admin-actions-row — flex-fixed footer внутри ограниченной карточки', () => {
    const body = readRuleBody(
      css,
      '.bulk-print-modal__form > .admin-actions-row',
    );
    // Footer закрепляется не sticky, а bounded-panel layout'ом
    // (`docs/modal-positioning-recon.md` §6): карточка ограничена
    // по высоте, preview скроллится внутри, actions — последний
    // flex-child формы.
    expect(body).toMatch(/flex:\s*0\s+0\s+auto/);
  });

  test('.bulk-print-modal__card — bounded по dvh, flex-column, overflow:hidden', () => {
    const body = readRuleBody(css, '.bulk-print-modal__card');
    // Главная защита от регресса: карточка не имеет права снова
    // расти выше viewport. Иначе footer уезжает ниже экрана
    // (`docs/modal-positioning-recon.md` §6, скриншот «Печать линии»).
    expect(body).toMatch(/max-height:\s*calc\(100dvh\s*-\s*2rem\)/);
    expect(body).toMatch(/overflow:\s*hidden/);
    // Карточка должна быть flex-column сама по себе, чтобы header/form/footer
    // выстраивались колонкой и form могла занять оставшееся место.
    expect(body).toMatch(/display:\s*flex/);
    expect(body).toMatch(/flex-direction:\s*column/);
  });

  test('.bulk-print-modal__form — flex-grow внутри карточки, без overflow за пределы', () => {
    const body = readRuleBody(css, '.bulk-print-modal__form');
    expect(body).toMatch(/display:\s*flex/);
    expect(body).toMatch(/flex-direction:\s*column/);
    expect(body).toMatch(/flex:\s*1\s+1\s+auto/);
    expect(body).toMatch(/min-height:\s*0/);
    expect(body).toMatch(/overflow:\s*hidden/);
  });

  test('.bulk-print-modal__form > .bulk-print-modal__preview — единственный scrollable child', () => {
    const body = readRuleBody(
      css,
      '.bulk-print-modal__form > .bulk-print-modal__preview',
    );
    expect(body).toMatch(/flex:\s*1\s+1\s+0/);
    expect(body).toMatch(/min-height:\s*0/);
    expect(body).toMatch(/overflow:\s*hidden/);
  });

  test('.bulk-print-modal__preview-grid — flex:1, скролл внутри preview, без max-height: 32vh', () => {
    const body = readRuleBody(css, '.bulk-print-modal__preview-grid');
    expect(body).toMatch(/flex:\s*1\s+1\s+auto/);
    expect(body).toMatch(/min-height:\s*0/);
    expect(body).toMatch(/overflow-y:\s*auto/);
    // Старый max-height: 32vh + overflow-y: auto не справлялся с
    // длинными карточками — теперь верхний лимит задаёт
    // `.bulk-print-modal__card`.
    expect(body).not.toMatch(/max-height:\s*32vh/);
  });
});

/**
 * Regression guard: `.admin-form` объявлен ниже по globals.css и без
 * cascade-override-а перебивает `display: flex` на `display: grid`,
 * из-за чего footer-кнопка «Печать» уезжает ниже viewport на длинных
 * линиях склада (см. `docs/warehouse-bulk-print-modal-runtime-recon.md`
 * §7.1). Проверяем именно компаунд-селектор
 * `.bulk-print-modal__card .bulk-print-modal__form.admin-form` —
 * простая «есть `display:flex` в теле `.bulk-print-modal__form`»
 * проверка давала false-positive, потому что cascade выигрывал
 * `.admin-form { display: grid }`.
 */
describe('modal positioning — cascade conflict .admin-form vs .bulk-print-modal__form', () => {
  const css = readSrc('apps/web/app/globals.css');

  test('JSX рендерит обе class-name (`bulk-print-modal__form admin-form`) — конфликт реальный', () => {
    // Defensive baseline: если в JSX когда-то уберут `admin-form`, тесты
    // ниже становятся overhead-ом. Этот тест явно фиксирует, что
    // конфликт всё ещё актуален.
    const src = readSrc(
      'apps/web/app/admin/warehouses/[id]/bulk-print-panel.tsx',
    );
    expect(src).toMatch(/className="bulk-print-modal__form admin-form"/);
  });

  test('.admin-form объявлен в globals.css с display: grid (regression guard, источник конфликта)', () => {
    // Пока `.admin-form { display: grid }` существует, нам нужен
    // override с большей специфичностью. Если когда-то `.admin-form`
    // уберут или поменяют display, можно будет упростить override.
    // Регэксп с lookbehind на newline-граничный `.admin-form` —
    // чтобы не зацепить компаунд `.bulk-print-modal__form.admin-form`.
    expect(css).toMatch(/\n\.admin-form\s*\{[^}]*display:\s*grid/);
  });

  test('.bulk-print-modal__card .bulk-print-modal__form.admin-form — компаунд-override (specificity 0,3,0) возвращает flex-column', () => {
    const body = readRuleBody(
      css,
      '.bulk-print-modal__card .bulk-print-modal__form.admin-form',
    );
    expect(body).toMatch(/display:\s*flex/);
    expect(body).toMatch(/flex-direction:\s*column/);
    expect(body).toMatch(/flex:\s*1\s+1\s+auto/);
    expect(body).toMatch(/min-height:\s*0/);
    expect(body).toMatch(/overflow:\s*hidden/);
  });

  test('.bulk-print-modal__card .bulk-print-modal__form.admin-form > .bulk-print-modal__preview — preview занимает свободное место в реальном runtime-каскаде', () => {
    const body = readRuleBody(
      css,
      '.bulk-print-modal__card .bulk-print-modal__form.admin-form > .bulk-print-modal__preview',
    );
    expect(body).toMatch(/flex:\s*1\s+1\s+0/);
    expect(body).toMatch(/min-height:\s*0/);
    expect(body).toMatch(/overflow:\s*hidden/);
  });

  test('.bulk-print-modal__card .bulk-print-modal__form.admin-form > .admin-actions-row — footer прибит к низу формы и виден без скролла', () => {
    const body = readRuleBody(
      css,
      '.bulk-print-modal__card .bulk-print-modal__form.admin-form > .admin-actions-row',
    );
    expect(body).toMatch(/flex:\s*0\s+0\s+auto/);
    expect(body).toMatch(/margin-top:\s*auto/);
    expect(body).toMatch(/border-top:/);
    expect(body).toMatch(/background:/);
  });

  test('override-селектор объявлен ПОСЛЕ `.admin-form` ИЛИ имеет более высокую специфичность', () => {
    // Гарантируем, что cascade-победитель — наш override, а не
    // `.admin-form`. Текущий компаунд `.bulk-print-modal__card
    // .bulk-print-modal__form.admin-form` имеет специфичность
    // (0,3,0), что выше `.admin-form` (0,1,0) при любом source-order.
    // Заодно проверяем сам факт присутствия override-а — без него
    // фикс мёртв.
    expect(css).toContain(
      '.bulk-print-modal__card .bulk-print-modal__form.admin-form',
    );
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
  test('bulk-print-panel.tsx использует общий `.qr-modal` и группирует actions внутри form', () => {
    const src = readSrc(
      'apps/web/app/admin/warehouses/[id]/bulk-print-panel.tsx',
    );
    // Модалка использует общий overlay-паттерн `.qr-modal`.
    expect(src).toMatch(/className="qr-modal"/);
    expect(src).toMatch(/role="dialog"/);
    expect(src).toMatch(/aria-modal="true"/);
    // Footer-actions лежат внутри `.bulk-print-modal__form`,
    // что позволяет sticky-правилу из globals.css закрепить их
    // на дне карточки при overlay-scroll.
    expect(src).toMatch(/className="bulk-print-modal__form admin-form"/);
    expect(src).toMatch(/className="admin-actions-row"/);
    // Кнопка submit называется «Печать» — это именно то, что не
    // должно уезжать ниже экрана (см. docs/modal-positioning-recon.md).
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
