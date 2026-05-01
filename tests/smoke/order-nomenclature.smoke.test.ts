/**
 * Smoke-тесты единого resolver-а «номенклатура заказа» (см.
 * `apps/web/lib/order-nomenclature.ts`,
 * `apps/web/app/admin/orders/[id]/page.tsx`,
 * `apps/web/components/orders/pattern-preview-card.tsx`,
 * `apps/web/app/orders/[id]/page.tsx`).
 *
 * Контекст: до этого изменения админ-карточка заказа в одном и том
 * же UI рисовала два разных названия одного и того же изделия —
 * preview брал `patternName` / `patternNameSnapshot` из карточки
 * лекала, а блок «Изделие» брал `productName` (legacy `Product.name`,
 * который сознательно НЕ синхронизируется при переименовании
 * `PatternItem`). Менеджер видел «ХУДИ БАЗА (КЕНГУРУ)» в превью и
 * «Худи» в блоке «Изделие» в одной карточке.
 *
 * Эти тесты — source-level (как и остальные в этой папке) и не
 * запускают сервер. Их задача — зафиксировать, что:
 *   - resolver реализован одним helper-ом и используется во всех
 *     местах, где раньше был дубликат логики;
 *   - порядок fallback-ов (snapshot → live PatternItem → legacy
 *     productName → null) и теги источника (`source`) — стабильны;
 *   - блок «Изделие» в admin-карточке и в legacy-карточке оба
 *     зовут resolver, а не `order.productName` напрямую;
 *   - `PatternPreviewCard` тоже использует resolver, чтобы preview
 *     и блок «Изделие» совпадали.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function read(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function exists(relativePath: string): boolean {
  return existsSync(path.join(repoRoot, relativePath));
}

// ---------------------------------------------------------------------------
// 1. Helper существует и реализует ожидаемый порядок fallback-ов
// ---------------------------------------------------------------------------

describe('apps/web/lib/order-nomenclature.ts — единый resolver', () => {
  const helperPath = 'apps/web/lib/order-nomenclature.ts';

  test('файл helper-а существует', () => {
    expect(exists(helperPath)).toBe(true);
  });

  const src = read(helperPath);

  test('экспортирует resolveOrderNomenclature + типы источника', () => {
    expect(src).toMatch(/export\s+function\s+resolveOrderNomenclature\b/);
    expect(src).toMatch(/export\s+type\s+OrderNomenclatureSource\b/);
    expect(src).toMatch(/export\s+type\s+OrderNomenclatureSourceTag\b/);
    expect(src).toMatch(/export\s+interface\s+ResolvedOrderNomenclature\b/);
  });

  test('реализует ровно цепочку snapshot ⊃ live ⊃ productName ⊃ none', () => {
    // Все три источника имени должны быть прямо упомянуты в коде —
    // если кто-то случайно уберёт одно из них, тест ловит это.
    expect(src).toMatch(/patternNameSnapshot/);
    expect(src).toMatch(/patternName\b/);
    expect(src).toMatch(/productName/);
    // Теги источника — стабильный публичный контракт UI-бейджа.
    expect(src).toMatch(/['"]snapshot['"]/);
    expect(src).toMatch(/['"]pattern['"]/);
    expect(src).toMatch(/['"]legacyProduct['"]/);
    expect(src).toMatch(/['"]none['"]/);
  });

  test('экспортирует таблицу лейблов бейджа источника', () => {
    expect(src).toMatch(/ORDER_NOMENCLATURE_SOURCE_BADGE/);
    // Лейблы — точный текст, который рисуется рядом с именем
    // в обоих UI (admin и legacy).
    expect(src).toMatch(/['"]снимок['"]/);
    expect(src).toMatch(/['"]актуальное['"]/);
    expect(src).toMatch(/['"]legacy['"]/);
  });

  test('runtime-поведение: цепочка fallback-ов и теги источника', async () => {
    const mod: typeof import('../../apps/web/lib/order-nomenclature') =
      await import('../../apps/web/lib/order-nomenclature');
    type Order = import('../../apps/web/lib/order-nomenclature').OrderNomenclatureSource;
    function make(o: Partial<Order>): Order {
      return {
        patternItemId: o.patternItemId ?? null,
        patternName: o.patternName ?? null,
        patternArticle: o.patternArticle ?? null,
        patternPreviewImageUrl: o.patternPreviewImageUrl ?? null,
        patternNameSnapshot: o.patternNameSnapshot ?? null,
        patternArticleSnapshot: o.patternArticleSnapshot ?? null,
        patternPreviewSnapshotUrl: o.patternPreviewSnapshotUrl ?? null,
        productName: o.productName ?? null,
      } as Order;
    }
    // Snapshot выигрывает у live PatternItem-а, даже если
    // PatternItem существует с другим именем (это и есть кейс
    // «после переименования лекала в работе»).
    const r1 = mod.resolveOrderNomenclature(
      make({
        patternItemId: 'p1',
        patternName: 'Худи база (кенгуру)',
        patternArticleSnapshot: 'P-OLD-1',
        patternNameSnapshot: 'Худи',
        productName: 'Старый Product',
      }),
    );
    expect(r1.source).toBe('snapshot');
    expect(r1.name).toBe('Худи');
    expect(r1.article).toBe('P-OLD-1');

    // Live PatternItem перебивает legacy productName.
    const r2 = mod.resolveOrderNomenclature(
      make({
        patternItemId: 'p2',
        patternName: 'Худи база (кенгуру)',
        productName: 'Худи',
      }),
    );
    expect(r2.source).toBe('pattern');
    expect(r2.name).toBe('Худи база (кенгуру)');

    // Legacy productName — последний fallback.
    const r3 = mod.resolveOrderNomenclature(
      make({ productName: 'Историческое изделие' }),
    );
    expect(r3.source).toBe('legacyProduct');
    expect(r3.name).toBe('Историческое изделие');
    // У legacy Product артикула и превью нет.
    expect(r3.article).toBeNull();
    expect(r3.previewImageUrl).toBeNull();

    // Ничего нет → none.
    const r4 = mod.resolveOrderNomenclature(make({}));
    expect(r4.source).toBe('none');
    expect(r4.name).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. /admin/orders/[id]/page.tsx — блок «Изделие» использует resolver
// ---------------------------------------------------------------------------

describe('admin/orders/[id] — номенклатура в OrderManagementHeader + OrderPlanTab', () => {
  // Order management redesign: блок «Изделие» как самостоятельная
  // секция страницы /admin/orders/[id] больше не существует — данные
  // показывает компактная шапка `OrderManagementHeader` (поле
  // «Изделие / лекало» + бейдж legacy) и отдельный блок «Продукт» в
  // вкладке «План» (`OrderPlanTab`). Оба зовут единый
  // `resolveOrderNomenclature`.
  const headerSrc = read(
    'apps/web/components/orders/view/order-management-header.tsx',
  );
  const planSrc = read(
    'apps/web/components/orders/view/tabs/order-plan-tab.tsx',
  );

  test('импортирует resolveOrderNomenclature и пользуется им (header + plan tab)', () => {
    for (const src of [headerSrc, planSrc]) {
      expect(src).toMatch(/from '@\/lib\/order-nomenclature'/);
      expect(src).toMatch(/resolveOrderNomenclature\(order\)/);
    }
  });

  test('основное название берётся из resolver-а, а не из productName', () => {
    for (const src of [headerSrc, planSrc]) {
      expect(src).toMatch(/<strong>\{nomenclature\.name\}<\/strong>/);
      expect(src).not.toMatch(
        /<strong>\{order\.productName \?\? '—'\}<\/strong>/,
      );
    }
  });

  test('legacy-бейдж рисуется только для resolver.source === legacyProduct', () => {
    for (const src of [headerSrc, planSrc]) {
      expect(src).toMatch(/nomenclature\.source === 'legacyProduct'/);
      expect(src).toMatch(/ORDER_NOMENCLATURE_SOURCE_BADGE\.legacyProduct/);
    }
  });

  test('OrderPlanTab показывает «Артикул» из resolver-а', () => {
    expect(planSrc).toMatch(/<dt>Артикул<\/dt>/);
    expect(planSrc).toMatch(/\{nomenclature\.article\}/);
  });
});

// ---------------------------------------------------------------------------
// 3. PatternPreviewCard — использует тот же resolver
// ---------------------------------------------------------------------------

describe('components/orders/pattern-preview-card.tsx — общий resolver', () => {
  const src = read('apps/web/components/orders/pattern-preview-card.tsx');

  test('импортирует resolveOrderNomenclature и не дублирует resolver-логику', () => {
    expect(src).toMatch(
      /from '@\/lib\/order-nomenclature'/,
    );
    expect(src).toMatch(/resolveOrderNomenclature\(order\)/);
    // Локальная функция `resolvePattern` была дубликатом логики —
    // её больше нет.
    expect(src).not.toMatch(/function resolvePattern\b/);
  });

  test('source-теги совпадают с resolver-ом и обрабатываются явно', () => {
    expect(src).toMatch(/['"]snapshot['"]/);
    expect(src).toMatch(/['"]pattern['"]/);
    expect(src).toMatch(/['"]legacyProduct['"]/);
    expect(src).toMatch(/['"]none['"]/);
  });

  test('Превью использует resolver.previewImageUrl', () => {
    expect(src).toMatch(/r\.previewImageUrl/);
    // Старая локальная переменная `previewUrl` из resolvePattern-а
    // удалена.
    expect(src).not.toMatch(/r\.previewUrl\b/);
  });
});

// ---------------------------------------------------------------------------
// 4. Legacy /orders/[id]/page.tsx — мета-блок тоже использует resolver
// ---------------------------------------------------------------------------

describe('orders/[id]/page.tsx (legacy) — мета-блок «Номенклатура»', () => {
  const src = read('apps/web/app/orders/[id]/page.tsx');

  test('импортирует resolveOrderNomenclature', () => {
    expect(src).toMatch(/from '@\/lib\/order-nomenclature'/);
    expect(src).toMatch(/resolveOrderNomenclature\(order\)/);
  });

  test('мета-блок показывает nomenclature.name, а не order.productName', () => {
    expect(src).toMatch(/<strong>\{nomenclature\.name \?\? '—'\}<\/strong>/);
    expect(src).not.toMatch(/<strong>\{order\.productName \?\? '—'\}<\/strong>/);
    // Лейбл сменился на «Номенклатура» — синхронно с admin-карточкой.
    expect(src).toMatch(/Номенклатура/);
  });

  test('legacy-бейдж рисуется только для legacyProduct-источника', () => {
    expect(src).toMatch(/nomenclature\.source === 'legacyProduct'/);
    expect(src).toMatch(/ORDER_NOMENCLATURE_SOURCE_BADGE\.legacyProduct/);
  });
});

// ---------------------------------------------------------------------------
// 5. /admin/orders/page.tsx — список заказов использует тот же resolver
// ---------------------------------------------------------------------------

describe('admin/orders/page.tsx — колонка «Изделие» в списке', () => {
  const src = read('apps/web/app/admin/orders/page.tsx');

  test('импортирует resolveOrderNomenclature и бейдж источника', () => {
    expect(src).toMatch(/from '@\/lib\/order-nomenclature'/);
    expect(src).toMatch(/resolveOrderNomenclature\(o\)/);
    expect(src).toMatch(/ORDER_NOMENCLATURE_SOURCE_BADGE/);
  });

  test('колонка «Изделие» больше не рисует order.productName напрямую', () => {
    // ТЗ §«Целевая логика отображения»: список заказов больше не
    // должен показывать `order.productName` как primary value.
    // Раньше тут было `<span>{o.productName ?? '—'}</span>` —
    // одна и та же строка прямо в JSX. Если её снова кто-то
    // вернёт, тест падает.
    expect(src).not.toMatch(/\{o\.productName \?\? '—'\}/);
    // А resolver-имя — есть и идёт как primary.
    expect(src).toMatch(/\{nomenclature\.name \?\? '—'\}/);
  });

  test('колонка «Изделие» рисует бейдж «legacy» только для legacyProduct-источника', () => {
    expect(src).toMatch(/nomenclature\.source === 'legacyProduct'/);
    expect(src).toMatch(
      /ORDER_NOMENCLATURE_SOURCE_BADGE\.legacyProduct/,
    );
  });

  test('артикул из resolver-а появляется в подсказке колонки', () => {
    // Цвет / артикул выводятся вторым ярусом через
    // `admin-table__hint`. Мы не фиксируем точную верстку, но
    // присутствие `nomenclature.article` и hint-класса достаточно,
    // чтобы регрессия типа «забыли вывести артикул» ловилась.
    expect(src).toMatch(/nomenclature\.article/);
    expect(src).toMatch(/admin-table__hint/);
  });
});

// ---------------------------------------------------------------------------
// 6. /orders/page.tsx (legacy) — список заказов тоже идёт через resolver
// ---------------------------------------------------------------------------

describe('orders/page.tsx (legacy) — колонка «Изделие» в списке', () => {
  const src = read('apps/web/app/orders/page.tsx');

  test('импортирует resolveOrderNomenclature', () => {
    expect(src).toMatch(/from '@\/lib\/order-nomenclature'/);
    expect(src).toMatch(/resolveOrderNomenclature\(o\)/);
  });

  test('legacy-список не рисует order.productName напрямую', () => {
    // До правки тут было `<td>{o.productName ?? '—'}</td>`.
    expect(src).not.toMatch(/\{o\.productName \?\? '—'\}/);
    expect(src).toMatch(/\{nomenclature\.name \?\? '—'\}/);
  });
});

// ---------------------------------------------------------------------------
// 7. OrderListItemDto содержит нужные pattern-поля
// ---------------------------------------------------------------------------

describe('OrderListItemDto — pattern live + snapshot fields', () => {
  // Источник истины — `packages/shared/src/orders.ts`. Если кто-то
  // удалит pattern-поля из list DTO, resolver на UI «провалится» в
  // `productName`-fallback, и список заказа снова покажет legacy
  // имя. Этот тест ловит такую регрессию на source-уровне.
  const src = read('packages/shared/src/orders.ts');

  test('OrderListItemDto объявляет pattern-поля и snapshot-поля', () => {
    // Грубая проверка наличия полей в файле — этого достаточно,
    // потому что компилируется только один общий DTO. Точные
    // типы (string | null) проверяет TS на этапе typecheck.
    expect(src).toMatch(/\bpatternItemId: string \| null;/);
    expect(src).toMatch(/\bpatternName: string \| null;/);
    expect(src).toMatch(/\bpatternArticle: string \| null;/);
    expect(src).toMatch(/\bpatternPreviewImageUrl: string \| null;/);
    expect(src).toMatch(/\bpatternNameSnapshot: string \| null;/);
    expect(src).toMatch(/\bpatternArticleSnapshot: string \| null;/);
    expect(src).toMatch(/\bpatternPreviewSnapshotUrl: string \| null;/);
    expect(src).toMatch(/\bproductName: string \| null;/);
  });

  test('backend list-mapper отдаёт live + snapshot pattern-поля', () => {
    // Источник — `apps/api/src/modules/orders/orders.service.ts`,
    // private `toListItemDto`. Регрессия «mapper не отдал
    // patternNameSnapshot» сделает UI-resolver слепым.
    const apiSrc = read('apps/api/src/modules/orders/orders.service.ts');
    expect(apiSrc).toMatch(/private toListItemDto\(/);
    expect(apiSrc).toMatch(/patternName:\s*o\.patternItem\?\.name/);
    expect(apiSrc).toMatch(/patternArticle:\s*o\.patternItem\?\.article/);
    expect(apiSrc).toMatch(
      /patternPreviewImageUrl:\s*o\.patternItem\?\.previewImageUrl/,
    );
    expect(apiSrc).toMatch(/patternNameSnapshot:\s*o\.patternNameSnapshot/);
    expect(apiSrc).toMatch(
      /patternArticleSnapshot:\s*o\.patternArticleSnapshot/,
    );
    expect(apiSrc).toMatch(
      /patternPreviewSnapshotUrl:\s*o\.patternPreviewSnapshotUrl/,
    );
    // Plus: include в list() запросе должен забирать карточку лекала
    // (без неё mapper отдаст null для live-полей).
    expect(apiSrc).toMatch(/patternItem:\s*\{\s*select:\s*\{/);
  });
});
