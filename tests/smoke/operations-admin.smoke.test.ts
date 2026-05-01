/**
 * Smoke-тесты для управления операциями (`/admin/operations`,
 * `/admin/operations/new`, `/admin/operations/[id]`, ADR-0020 §«UX»).
 *
 * Полноценного React-рендера в проекте нет (vitest + Node, без jsdom),
 * поэтому фиксируем структуру на уровне исходников: что встроенная
 * форма создания убрана из списка, что отдельная страница `/new`
 * подключает форму с back-link'ом, что server-action `create` ведёт
 * на карточку, что detail-page не сломалась. Этого достаточно, чтобы
 * поймать регресс «вернули форму в список» или «убрали редирект на
 * карточку после создания».
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('admin/operations — список без встроенной формы создания', () => {
  test('страница НЕ подключает CreateOperationForm и ведёт на /admin/operations/new', () => {
    const src = readSrc('apps/web/app/admin/operations/page.tsx');
    expect(src).not.toMatch(/CreateOperationForm/);
    expect(src).toMatch(/href="\/admin\/operations\/new"/);
    expect(src).toMatch(/Добавить операцию/);
    // Empty-state теперь зовёт на отдельную страницу, а не «форму выше».
    expect(src).not.toMatch(/форму выше/);
  });

  test('страница /admin/operations/new рендерит форму создания и back-link', () => {
    const src = readSrc('apps/web/app/admin/operations/new/page.tsx');
    expect(src).toMatch(/CreateOperationForm/);
    expect(src).toMatch(/DetailPageHeader/);
    expect(src).toMatch(/backHref="\/admin\/operations"/);
    expect(src).toMatch(/К списку операций/);
    expect(src).toMatch(/Новая операция/);
  });

  test('CreateOperationForm содержит все обязательные поля и кнопку submit', () => {
    const src = readSrc('apps/web/app/admin/operations/create-form.tsx');
    expect(src).toMatch(/name="code"/);
    expect(src).toMatch(/name="name"/);
    expect(src).toMatch(/name="category"/);
    expect(src).toMatch(/name="pricingMode"/);
    // Поле fixedRate показывается условно — сам input должен быть в файле.
    expect(src).toMatch(/name="fixedRate"/);
    expect(src).toMatch(/Создать операцию/);
    // Раньше форма была плоской через admin-equipment-form__meta —
    // теперь это аккуратный detail-form layout.
    expect(src).toMatch(/className="detail-form"/);
    expect(src).not.toMatch(/admin-equipment-form__meta/);
  });

  test('createOperationAction обращается к POST /api/operations и редиректит на карточку', () => {
    const src = readSrc('apps/web/app/admin/operations/actions.ts');
    expect(src).toMatch(/createOperation\(/);
    expect(src).toMatch(/redirect\(`\/admin\/operations\/\$\{createdId\}`\)/);
    expect(src).toMatch(/revalidatePath\('\/admin\/operations'\)/);
  });
});

describe('admin/operations/[id] — detail-page остаётся рабочей', () => {
  test('detail-страница рендерит DetailPageHeader и форму редактирования', () => {
    const src = readSrc('apps/web/app/admin/operations/[id]/page.tsx');
    expect(src).toMatch(/DetailPageHeader/);
    expect(src).toMatch(/OperationEditForm/);
    expect(src).toMatch(/backHref="\/admin\/operations"/);
    expect(src).toMatch(/К списку операций/);
  });

  test('OperationEditForm сохраняет pricingMode-логику (FIXED/BY_SIZE/SALARY_ONLY)', () => {
    const src = readSrc('apps/web/app/admin/operations/[id]/edit-form.tsx');
    expect(src).toMatch(/updateOperationAction/);
    expect(src).toMatch(/pricingMode === 'FIXED'/);
    expect(src).toMatch(/pricingMode === 'BY_SIZE'/);
    expect(src).toMatch(/pricingMode === 'SALARY_ONLY'/);
    // Bulk-helper по размерам и таблица ставок остаются — это часть
    // обязательного UX по ADR-0020.
    expect(src).toMatch(/Заполнить всем одну ставку/);
    expect(src).toMatch(/rate-\$\{s\.id\}/);
  });
});
