/**
 * Smoke-тесты для управления складами (`/admin/warehouses`,
 * `/admin/warehouses/new`, `/admin/warehouses/[id]`,
 * см. `docs/screens.md §10b`).
 *
 * Полноценного React-рендера в проекте нет (vitest + Node, без jsdom),
 * поэтому фиксируем структуру на уровне исходников: что встроенная
 * форма создания убрана из списка, что отдельная страница `/new`
 * подключает форму с back-link'ом, что server-action `create` ведёт
 * на карточку, и что detail-page склада не сломалась (линии/ячейки
 * остаются на месте). Этого достаточно, чтобы поймать регресс
 * «вернули форму в список» или «убрали редирект на карточку
 * после создания». Тот же паттерн уже применён в
 * `equipment-admin.smoke.test.ts` и `operations-admin.smoke.test.ts`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('admin/warehouses — список без встроенной формы создания', () => {
  test('страница НЕ подключает CreateWarehouseForm и ведёт на /admin/warehouses/new', () => {
    const src = readSrc('apps/web/app/admin/warehouses/page.tsx');
    // Создание вынесено на отдельную страницу — встроенной формы
    // на списке быть не должно (это ровно то, что регрессировало бы
    // при «вернули как было»).
    expect(src).not.toMatch(/CreateWarehouseForm/);
    expect(src).toMatch(/href="\/admin\/warehouses\/new"/);
    expect(src).toMatch(/Добавить склад/);
    // Empty-state теперь зовёт на отдельную страницу, а не «форму выше».
    expect(src).not.toMatch(/форма выше/);
  });

  test('страница /admin/warehouses/new рендерит форму создания и back-link', () => {
    const src = readSrc('apps/web/app/admin/warehouses/new/page.tsx');
    expect(src).toMatch(/CreateWarehouseForm/);
    expect(src).toMatch(/DetailPageHeader/);
    // Back-link к списку — обязательный элемент detail-pages.
    expect(src).toMatch(/backHref="\/admin\/warehouses"/);
    expect(src).toMatch(/К списку складов/);
    expect(src).toMatch(/Новый склад/);
  });

  test('CreateWarehouseForm содержит обязательные поля и кнопку submit', () => {
    const src = readSrc('apps/web/app/admin/warehouses/create-form.tsx');
    // Минимальный набор — name (обязательное) и code (опциональное).
    expect(src).toMatch(/name="name"/);
    expect(src).toMatch(/required/);
    expect(src).toMatch(/name="code"/);
    // Submit на отдельной странице создания — «Создать склад»
    // (кнопка «Добавить склад» остаётся на списке как ссылка
    // на /admin/warehouses/new).
    expect(src).toMatch(/Создать склад/);
    // Раньше форма была плоской через admin-equipment-form__meta —
    // теперь это аккуратный detail-form layout (как у operations).
    expect(src).toMatch(/className="detail-form"/);
    expect(src).not.toMatch(/admin-equipment-form__meta/);
  });

  test('createWarehouseAction обращается к POST /api/warehouses и редиректит на карточку', () => {
    const src = readSrc('apps/web/app/admin/warehouses/actions.ts');
    expect(src).toMatch(/createWarehouse\(/);
    expect(src).toMatch(/redirect\(`\/admin\/warehouses\/\$\{createdId\}`\)/);
    expect(src).toMatch(/revalidatePath\('\/admin\/warehouses'\)/);
    // Пустое название должно отсекаться ещё на стороне action — это
    // даёт менеджеру понятную ошибку без сетевого round-trip.
    expect(src).toMatch(/Введите название склада/);
  });
});

describe('admin/warehouses/[id] — detail-page остаётся рабочей', () => {
  test('detail-страница рендерит DetailPageHeader, редактирование, линии и ячейки', () => {
    const src = readSrc('apps/web/app/admin/warehouses/[id]/page.tsx');
    expect(src).toMatch(/DetailPageHeader/);
    expect(src).toMatch(/backHref="\/admin\/warehouses"/);
    expect(src).toMatch(/К списку складов/);
    // Старые секции не должны быть удалены — это «do not break»
    // условие из ТЗ §6.
    expect(src).toMatch(/WarehouseEditForm/);
    expect(src).toMatch(/CreateLineForm/);
    expect(src).toMatch(/AssignCellForm/);
    expect(src).toMatch(/DetachCellButton/);
  });

  test('actions для линий и привязки ячеек на месте (не сломаны)', () => {
    const src = readSrc('apps/web/app/admin/warehouses/actions.ts');
    expect(src).toMatch(/createWarehouseLineAction/);
    expect(src).toMatch(/assignCellToWarehouseAction/);
    expect(src).toMatch(/detachCellFromWarehouseAction/);
    expect(src).toMatch(/updateWarehouseAction/);
  });
});

describe('backend warehouse контракт', () => {
  test('контроллер выставляет POST /warehouses под ADMIN/SHOP_MANAGER', () => {
    const src = readSrc('apps/api/src/modules/warehouses/warehouses.controller.ts');
    expect(src).toMatch(/@Post\(\)/);
    expect(src).toMatch(/CreateWarehouseSchema/);
    expect(src).toMatch(/@Roles\('SHOP_MANAGER',\s*'ADMIN'\)/);
  });

  test('CreateWarehouseSchema принимает name и опциональный code', () => {
    const src = readSrc('packages/shared/src/warehouses.ts');
    expect(src).toMatch(/CreateWarehouseSchema/);
    expect(src).toMatch(/name:/);
    expect(src).toMatch(/code:/);
  });
});

// ---------------------------------------------------------------------------
// «Печать всех ячеек» — новый bulk-print flow (см. `docs/api.md §15`,
// `docs/screens.md §10b`).
// ---------------------------------------------------------------------------

describe('admin/warehouses/[id] — кнопка «Печать всех ячеек» и окно настройки печати', () => {
  test('detail-страница рендерит BulkPrintPanel и подгружает список принтеров', () => {
    const src = readSrc('apps/web/app/admin/warehouses/[id]/page.tsx');
    // Панель — отдельный client-component, чтобы держать остальную
    // страницу серверной (не тащим printers fetch на client просто так).
    expect(src).toMatch(/WarehouseBulkPrintPanel/);
    expect(src).toMatch(/from '@\/lib\/printers-api'/);
    expect(src).toMatch(/listPrinters\(\)/);
  });

  test('bulk-print-panel содержит выбор принтера, копий, размера и preview', () => {
    const src = readSrc('apps/web/app/admin/warehouses/[id]/bulk-print-panel.tsx');
    // Кнопка-триггер — заметная, по ТЗ её точно «Печать всех ячеек».
    expect(src).toMatch(/Печать всех ячеек/);
    // Окно настройки печати — modal, а не browser confirm.
    expect(src).toMatch(/role="dialog"/);
    expect(src).toMatch(/aria-modal/);
    // Обязательные подписи полей настроек печати.
    expect(src).toMatch(/>Принтер</);
    expect(src).toMatch(/>Размер этикетки</);
    expect(src).toMatch(/>Копий каждой</);
    // Состояние формы держим в React-state (controlled inputs).
    expect(src).toMatch(/setPrinterId/);
    expect(src).toMatch(/setCopies/);
    expect(src).toMatch(/setLabelSize/);
    // Размер этикетки фиксирован 38×58 (см. WAREHOUSE_LABEL_SIZES),
    // но dropdown остаётся для будущего расширения.
    expect(src).toMatch(/WAREHOUSE_LABEL_SIZES/);
    expect(src).toMatch(/38\s*[x×]\s*58/i);
    // Preview плиток ячеек обязателен — это часть UX.
    expect(src).toMatch(/buildCellQrImageUrl/);
    expect(src).toMatch(/Превью этикеток/);
    // Submit идёт через server action, а не fetch напрямую из client.
    expect(src).toMatch(/printWarehouseCellsAction/);
    // Action-buttons — Отмена + Печать.
    expect(src).toMatch(/Отмена\s*<\/button>/);
    expect(src).toMatch(/'Печать'/);
  });

  test('printWarehouseCellsAction обращается к POST /api/warehouses/:id/print-cells', () => {
    const src = readSrc('apps/web/app/admin/warehouses/actions.ts');
    expect(src).toMatch(/printWarehouseCellsAction/);
    // API-обёртка живёт в lib/warehouses-api.ts — action её зовёт.
    const api = readSrc('apps/web/lib/warehouses-api.ts');
    expect(api).toMatch(/printWarehouseCells/);
    expect(api).toMatch(/\/warehouses\/.+\/print-cells/);
  });
});

describe('backend bulk print: контракт и шаблон 38×58', () => {
  test('контроллер выставляет POST /:id/print-cells под ADMIN/SHOP_MANAGER', () => {
    const src = readSrc('apps/api/src/modules/warehouses/warehouses.controller.ts');
    expect(src).toMatch(/@Post\(':id\/print-cells'\)/);
    expect(src).toMatch(/PrintWarehouseCellsSchema/);
    // RBAC класса распространяется на все ручки контроллера.
    expect(src).toMatch(/@Roles\('SHOP_MANAGER',\s*'ADMIN'\)/);
  });

  test('PrintWarehouseCellsSchema валидирует printerId/copies/labelSize', () => {
    const src = readSrc('packages/shared/src/warehouses.ts');
    expect(src).toMatch(/PrintWarehouseCellsSchema/);
    expect(src).toMatch(/printerId:/);
    expect(src).toMatch(/copies:/);
    expect(src).toMatch(/labelSize:/);
    expect(src).toMatch(/WAREHOUSE_LABEL_SIZES.*38x58/s);
  });

  test('PrintJobSource содержит CELL_LABEL', () => {
    const src = readSrc('packages/shared/src/printers.ts');
    expect(src).toMatch(/'CELL_LABEL'/);
  });

  test('cell-print.ts рендерит 38×58 горизонтально, только QR + номер', () => {
    const src = readSrc('apps/api/src/modules/passports/cell-print.ts');
    // Жёсткий @page — 58×38 (горизонтально).
    expect(src).toMatch(/@page[\s\S]*size:\s*58mm\s+38mm/);
    expect(src).toMatch(/width:\s*58mm/);
    expect(src).toMatch(/height:\s*38mm/);
    // Контракт: на этикетке только QR + номер. В HTML-теле не должно
    // быть ни payload-строки `cell:{id}`, ни ссылки на warehouse.
    expect(src).not.toMatch(/cell:\$\{/);
    expect(src).not.toMatch(/c\.warehouse/);
    expect(src).not.toMatch(/qrPayload/);
    // На печати кнопку «Печать» обязательно прячем (см. @media print).
    expect(src).toMatch(/@media print[\s\S]*\.actions[\s\S]*display:\s*none/);
    // Print-safety: цвет не должен «оптимизироваться», контент — не уезжать
    // на вторую страницу (см. требования к термоэтикетке).
    expect(src).toMatch(/print-color-adjust:\s*exact/);
    expect(src).toMatch(/-webkit-print-color-adjust:\s*exact/);
    expect(src).toMatch(/page-break-inside:\s*avoid/);
    expect(src).toMatch(/break-inside:\s*avoid/);
    expect(src).toMatch(/overflow:\s*hidden/);
  });
});
