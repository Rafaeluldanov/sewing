/**
 * Smoke-тесты для создания заказа в Admin Order Form 2.3
 * (`/admin/orders/new`).
 *
 * После этапа «Номенклатура = Лекала» (см.
 * `docs/recon-soft-integration.md §«Номенклатура = Лекала»`) форма
 * имеет новую структуру блоков, ориентированную на «лекало как
 * единственная видимая номенклатура»:
 *   1. «Заказ»        — клиент / orderDate / dueDate (+ badge «Срок не
 *                       указан») / подразделение / статус / комментарий;
 *   2. «Изделие»      — единственный select «Номенклатура / лекало»
 *                       (`patternItemId`) + цвет; legacy «Учётное
 *                       изделие» (Product) удалён из UI;
 *   3. «Производство» — техкарта / маршрут + read-only summary лекала
 *                       и preview маршрута;
 *   4. «План по размерам» — компактный summary `SizePlanSelector` с
 *                       кнопкой «Выбрать размеры», модалка
 *                       со списком размеров выбранной номенклатуры.
 *                       Видимая сетка `AdminSizeGrid` на странице
 *                       больше не используется (компонент остаётся
 *                       только в read-only превью карточки заказа).
 *
 * Справа сверху — `PatternHeroPreview`: большая карточка превью
 * выбранного лекала.
 *
 * Контракт FormData (источник правды — `createOrderAction`):
 * `patternItemId`, `dueDate`, `orderDate`, `color`, `comment`,
 * `clientId`, `companyDivisionId`, `techCardId`, `routeTemplateId`,
 * `qty[<sizeId>]`. Поле `productId` форма больше НЕ шлёт — backend
 * через `OrdersService.ensureLegacyProductForPattern()` подставит
 * технический legacy Product сам. Подробные смоки на сетку
 * размеров — в `admin-order-layout.smoke.test.ts`.
 *
 * Этот файл сохраняем как «исторический» smoke: проверяем, что страница
 * не съехала с admin-shell, FormData-ключи не сломаны и ссылка из
 * списка ведёт на новую форму. Старый `/orders/new` сознательно
 * остаётся на месте — на него полагается легаси-flow CUTTER_ASSISTANT,
 * у которого по-прежнему ходит `productId`.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('admin/orders/new — Admin Order Form 2.0 страница создания заказа', () => {
  test('страница существует и подключена к admin-shell', () => {
    const pagePath = 'apps/web/app/admin/orders/new/page.tsx';
    expect(existsSync(path.join(repoRoot, pagePath))).toBe(true);

    const src = readSrc(pagePath);
    expect(src).toMatch(/AdminPageShell/);
    expect(src).toMatch(/from 'lucide-react'/);
    // Order-workspace unification: section title — обобщённое
    // «Заказы» (одинаково на /admin/orders, /admin/orders/new и
    // /admin/orders/[id]); конкретный лейбл «Создание заказа»
    // лежит в subtitle. Сам hero с «Новым заказом» рендерится в
    // `AdminCreateOrderForm` через `OrderHeroCard`. Back-link
    // «К списку» переехал в hero actions.
    expect(src).toMatch(/title="Заказы"/);
    expect(src).toMatch(/Создание заказа/);
    // Header использует Package в blue soft bubble (через
    // .admin-page-shell__icon, см. globals.css).
    expect(src).toMatch(/Package/);
  });

  test('мастер открывается шагом «Клиент» и даёт выход к списку', () => {
    const formPath =
      'apps/web/app/admin/orders/new/order-create-wizard.tsx';
    const src = readSrc(formPath);
    // Order workspace v2 сменился мастером: hero-карточки с «Новым
    // заказом» больше нет — её роль играет степпер и заголовок шага.
    expect(src).not.toMatch(/OrderHeroCard/);
    expect(src).not.toMatch(/OrderWorkspaceLayout/);
    expect(src).toMatch(/Чей это заказ|WIZARD_STEPS/);
    // Выход к списку — в подвале мастера, рядом с «Далее».
    expect(src).toMatch(/href="\/admin\/orders"/);
    expect(src).toMatch(/К списку/);
  });

  test('страница не использует легаси DetailPageHeader / page-shell / <Icon name=', () => {
    const src = readSrc('apps/web/app/admin/orders/new/page.tsx');
    expect(src).not.toMatch(/DetailPageHeader/);
    expect(src).not.toMatch(/page-shell\b/);
    expect(src).not.toMatch(/<Icon\s+name=/);
  });

  test('мастер шлёт DTO через свои server actions, а не один FormData', () => {
    const formPath = 'apps/web/app/admin/orders/new/order-create-wizard.tsx';
    expect(existsSync(path.join(repoRoot, formPath))).toBe(true);

    const src = readSrc(formPath);
    // Заказ создаётся посреди мастера (`createOrderDraftAction`), а не
    // одним финальным сабмитом `createOrderAction`. Последний остался
    // только у легаси `/orders/new`.
    expect(src).toMatch(/createOrderDraftAction/);
    expect(src).toMatch(/patchOrderDraftAction/);
    expect(src).toMatch(/from '\.\/wizard-actions'/);
    // Поля заказа собираются в DTO, скрытых inputs с ключами заказа нет.
    expect(src).not.toMatch(/name="orderDate"/);
    expect(src).not.toMatch(/name="clientId"/);
    expect(src).not.toMatch(/name="productId"/);
    expect(src).not.toMatch(/name=\{`qty\[\$\{s\.id\}\]`\}/);
    expect(src).toMatch(/buildBasicsDto/);
    expect(src).toMatch(/buildDraftDto/);
    // Ветка «Создать изделие» по-прежнему ходит в общий action —
    // backend создаёт лекало и заказ одной транзакцией.
    expect(src).toMatch(/createOrderForCalculationAction/);
    expect(src).toMatch(/from '@\/app\/orders\/actions'/);
    // План по размерам — компактный селектор, видимой сетки нет.
    expect(src).toMatch(/SizePlanSelector/);
    expect(src).not.toMatch(/AdminSizeGrid/);
    expect(src).not.toMatch(/Добавить строку/);
    expect(src).not.toMatch(/Trash2/);
    expect(src).not.toMatch(/admin-table/);
  });

  test('содержимое разложено по шагам, а не по карточкам одной простыни', () => {
    const src = readSrc(
      'apps/web/app/admin/orders/new/order-create-wizard.tsx',
    );
    // Карточки старой «простыни» (`admin-order-card--*`) больше не
    // используются: каждый шаг — отдельная панель мастера.
    expect(src).not.toMatch(/admin-order-card--/);
    // Названия шагов приходят из единого конфига.
    const stepsSrc = readSrc(
      'apps/web/app/admin/orders/new/wizard-steps.ts',
    );
    expect(stepsSrc).toMatch(/Изделие/);
    expect(stepsSrc).toMatch(/Маршрут/);
    expect(stepsSrc).toMatch(/Расцветки и размеры/);
    expect(stepsSrc).toMatch(/Нанесение/);
    expect(stepsSrc).toMatch(/Проверка/);
  });

  test('мастер использует PatternHeroPreview и одно лекало как номенклатуру', () => {
    const src = readSrc(
      'apps/web/app/admin/orders/new/order-create-wizard.tsx',
    );
    expect(src).toMatch(/PatternHeroPreview/);
    expect(src).toMatch(/Номенклатура \/ лекало/);
    // Этап «Номенклатура = Лекала»: legacy `productId` в UI нет.
    expect(src).not.toMatch(/name="productId"/);
    expect(src).not.toMatch(/Учётное изделие/);
    // Лекало живёт в state шага «Изделие», а не в скрытом input.
    expect(src).toMatch(/setPatternItemId/);
  });

});

describe('admin/orders/new — план по размерам через SizePlanSelector', () => {
  const formPath =
    'apps/web/app/admin/orders/new/order-create-wizard.tsx';
  const selectorPath =
    'apps/web/app/admin/orders/new/size-plan-selector.tsx';

  test('файл компонента SizePlanSelector существует', () => {
    expect(existsSync(path.join(repoRoot, selectorPath))).toBe(true);
  });

  test('форма не использует AdminSizeGrid и подключает SizePlanSelector', () => {
    const src = readSrc(formPath);
    // Видимой сетки `AdminSizeGrid` на /admin/orders/new больше нет.
    expect(src).not.toMatch(/AdminSizeGrid/);
    expect(src).toMatch(/SizePlanSelector/);
    expect(src).toMatch(/from '\.\/size-plan-selector'/);
  });

  test('количества живут в state мастера, скрытых qty-inputs нет', () => {
    const src = readSrc(formPath);
    // Мастер не собирает FormData: план по размерам уезжает в DTO
    // ключом `items` (`itemsPayload`), поэтому скрытые
    // `qty[<sizeId>]` больше не рендерятся.
    expect(src).not.toMatch(/name=\{`qty\[\$\{s\.id\}\]`\}/);
    expect(src).toMatch(/itemsPayload/);
    expect(src).toMatch(/quantities/);
    expect(src).toMatch(/setQuantities/);
  });

  test('доступные размеры берутся из выбранного лекала', () => {
    const src = readSrc(formPath);
    // Размеры предлагаются только те, у которых у лекала есть
    // активный DXF. Иначе «выбрал XL → сменил лекало на S/M/L»
    // создал бы битый заказ.
    expect(src).toMatch(/availableSizes/);
    expect(src).toMatch(/selectedPattern\??\.sizes/);
    // Сумма плана считается по тем же размерам справочника.
    expect(src).toMatch(/allSizeIds/);
  });

  test('мастер показывает итог плана на шаге размеров', () => {
    const src = readSrc(formPath);
    expect(src).toMatch(/Итого по плану/);
    expect(src).toMatch(/sizesTotal/);
  });

  test('SizePlanSelector содержит ключевые UX-надписи и role="dialog"', () => {
    const src = readSrc(selectorPath);
    // Кнопка с двумя состояниями: «Выбрать размеры» / «Изменить размеры».
    expect(src).toMatch(/Выбрать размеры/);
    expect(src).toMatch(/Изменить размеры/);
    // Empty state на summary.
    expect(src).toMatch(/Размеры не выбраны/);
    // Пользователь не выбрал номенклатуру.
    expect(src).toMatch(/Сначала выберите номенклатуру/);
    // У выбранной номенклатуры нет активных DXF-размеров.
    expect(src).toMatch(/нет активных размеров/);
    expect(src).toMatch(/Загрузите DXF/);
    // Модалка как настоящий dialog.
    expect(src).toMatch(/role="dialog"/);
    expect(src).toMatch(/aria-modal="true"/);
    // Заголовок и кнопки модалки.
    expect(src).toMatch(/Размеры номенклатуры/);
    expect(src).toMatch(/Очистить\s*<\/button>/);
    expect(src).toMatch(/Отмена\s*<\/button>/);
    expect(src).toMatch(/Сохранить\s*<\/button>/);
    // Esc / backdrop close — обязательны по ТЗ.
    expect(src).toMatch(/Escape/);
    expect(src).toMatch(/handleBackdropClick/);
    // Кнопка disabled, пока модалку нельзя открыть.
    expect(src).toMatch(/disabled=\{!canOpen\}/);
  });

  test('SizePlanSelector использует pattern.sizes как источник доступных размеров', () => {
    const src = readSrc(formPath);
    // Источник правды — `PatternListItemDto.sizes` (отдаётся
    // `/api/patterns?status=ACTIVE` и уже содержит активные размеры,
    // см. `apps/api/src/modules/patterns/patterns.service.ts::list`).
    // Никаких client-fetch / отдельных запросов лекала не делаем.
    expect(src).toMatch(/selectedPattern\.sizes\.map/);
  });
});

describe('shared/api — PatternListItemDto.sizes отдаёт активные DXF-размеры', () => {
  test('shared `PatternListItemDto` содержит `sizes: PatternSizeRefDto[]`', () => {
    const src = readSrc('packages/shared/src/patterns.ts');
    expect(src).toMatch(/sizes:\s*PatternSizeRefDto\[\]/);
    expect(src).toMatch(/interface PatternSizeRefDto/);
  });

  test('PatternsService.list заполняет `sizes` из активных PatternSizeFile', () => {
    const src = readSrc('apps/api/src/modules/patterns/patterns.service.ts');
    // Только ACTIVE-DXF: пользователь не должен видеть архивные
    // размеры в модалке выбора.
    expect(src).toMatch(/sizeFiles:\s*\{[\s\S]*?status:\s*'ACTIVE'/);
    expect(src).toMatch(/sizes,/);
  });
});

describe('admin/orders/new — Product как сущность скрыт от UI', () => {
  test('страница /admin/orders/new больше не грузит список Product', () => {
    const src = readSrc('apps/web/app/admin/orders/new/page.tsx');
    expect(src).not.toMatch(/listProducts/);
    expect(src).not.toMatch(/ProductDto/);
  });

  test('форма /admin/orders/new не импортирует ProductDto и не держит products-state', () => {
    const src = readSrc(
      'apps/web/app/admin/orders/new/order-create-wizard.tsx',
    );
    expect(src).not.toMatch(/ProductDto/);
    expect(src).not.toMatch(/products:/);
    expect(src).not.toMatch(/setProductId/);
  });

  test('orders/actions.ts buildCreateDto уже не требует productId', () => {
    const src = readSrc('apps/web/app/orders/actions.ts');
    // productId читается из FormData как опциональный — собственный
    // helper делает «нет в FormData → undefined». Прежняя жёсткая
    // строка `String(form.get('productId') ?? '').trim()` без
    // условия больше нам не нужна.
    expect(src).toMatch(/form\.get\('productId'\)/);
    expect(src).toMatch(/productId(?:Raw)?\s*===\s*null/);
  });
});

describe('shared CreateOrderSchema — productId опционален, patternItemId один из двух', () => {
  test('CreateOrderSchema не требует productId жёстко', () => {
    const src = readSrc('packages/shared/src/orders.ts');
    // В новом контракте productId optional, а superRefine отбивает
    // dto без обоих полей с адресной ошибкой.
    expect(src).toMatch(/productId:\s*z\.string\(\)\.min\(1\)\.optional/);
    expect(src).toMatch(/patternItemId:\s*z\.string\(\)\.min\(1\)\.nullable\(\)\.optional/);
    expect(src).toMatch(/superRefine\(\(dto, ctx\)/);
    expect(src).toMatch(/Выберите номенклатуру \/ лекало/);
  });
});

describe('OrdersService — ensureLegacyProductForPattern', () => {
  test('helper присутствует и используется в create() / update()', () => {
    const src = readSrc('apps/api/src/modules/orders/orders.service.ts');
    expect(src).toMatch(/ensureLegacyProductForPattern\s*\(/);
    // Используется хотя бы дважды (create + update-helper).
    const calls = src.match(/ensureLegacyProductForPattern\s*\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    // Создаёт Product и записывает legacyProductId на PatternItem
    // (инвариант «один лекало — один Product»).
    expect(src).toMatch(/legacyProductId/);
  });
});

describe('Prisma schema — PatternItem.legacyProductId', () => {
  test('PatternItem имеет nullable @unique legacyProductId с back-relation', () => {
    const src = readSrc('prisma/schema.prisma');
    expect(src).toMatch(/legacyProductId\s+String\?\s+@unique/);
    expect(src).toMatch(
      /legacyProduct\s+Product\?\s+@relation\("PatternLegacyProduct"/,
    );
    expect(src).toMatch(
      /patternItems\s+PatternItem\[\]\s+@relation\("PatternLegacyProduct"\)/,
    );
  });

  test('миграция 20260513100000_pattern_legacy_product_link существует и additive', () => {
    const sql = readSrc(
      'prisma/migrations/20260513100000_pattern_legacy_product_link/migration.sql',
    );
    expect(sql).toMatch(/ALTER TABLE "PatternItem"\s+ADD COLUMN "legacyProductId" TEXT/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX "PatternItem_legacyProductId_key"/);
    expect(sql).toMatch(/FOREIGN KEY \("legacyProductId"\) REFERENCES "Product"\("id"\)/);
    expect(sql).toMatch(/ON DELETE SET NULL/);
    // Миграция не должна трогать OrderItem / Passport / Product
    // (только back-relation Prisma — это ничего в SQL не меняет).
    expect(sql).not.toMatch(/ALTER TABLE "OrderItem"/);
    expect(sql).not.toMatch(/ALTER TABLE "Passport"/);
    expect(sql).not.toMatch(/ALTER TABLE "Product"/);
    expect(sql).not.toMatch(/DROP\s+(TABLE|COLUMN)/);
  });
});

describe('admin/orders — кнопка «Создать заказ» ведёт в новую форму', () => {
  test('href кнопки на /admin/orders указывает на /admin/orders/new', () => {
    const src = readSrc('apps/web/app/admin/orders/page.tsx');
    expect(src).toMatch(/href="\/admin\/orders\/new"/);
    expect(src).not.toMatch(/href="\/orders\/new"/);
  });
});

describe('legacy /orders/new — НЕ удалён (нужен для CUTTER_ASSISTANT и старого flow)', () => {
  test('страница и форма легаси-маршрута на месте', () => {
    expect(
      existsSync(path.join(repoRoot, 'apps/web/app/orders/new/page.tsx')),
    ).toBe(true);
    expect(
      existsSync(
        path.join(repoRoot, 'apps/web/app/orders/new/new-order-form.tsx'),
      ),
    ).toBe(true);
  });

  test('createOrderAction в actions.ts остался и его контракт не сломан', () => {
    const src = readSrc('apps/web/app/orders/actions.ts');
    expect(src).toMatch(/export async function createOrderAction/);
    expect(src).toMatch(/CreateOrderSchema/);
    expect(src).toMatch(/createOrder\(/);
    expect(src).toMatch(/redirect\(`\/orders\/\$\{created\.id\}`\)/);
  });
});

describe('backend / Prisma — контракт POST /orders не сломан', () => {
  test('OrdersController всё ещё принимает POST /orders с CreateOrderSchema', () => {
    const src = readSrc('apps/api/src/modules/orders/orders.controller.ts');
    expect(src).toMatch(/CreateOrderSchema/);
    expect(src).toMatch(/@Post\(\)/);
  });
});
