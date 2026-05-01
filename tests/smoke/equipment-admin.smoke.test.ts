/**
 * Smoke-тесты для управления оборудованием (`/admin/equipment`,
 * `/admin/equipment/[id]`, ADR-0017 §5).
 *
 * Полноценного React-рендера в проекте нет (vitest + Node, без jsdom),
 * поэтому фиксируем структуру на уровне исходников: что нужная форма
 * подключена, что server-action существует, что backend-роут добавлен.
 * Этого достаточно, чтобы поймать регресс «удалили форму создания» или
 * «убрали поле name из PATCH-схемы».
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('admin/equipment — список без встроенной формы создания', () => {
  test('страница НЕ подключает CreateEquipmentForm и ведёт на /admin/equipment/new', () => {
    const src = readSrc('apps/web/app/admin/equipment/page.tsx');
    // Создание вынесено на отдельную страницу — встроенной формы
    // на списке быть не должно (это ровно то, что регрессировало бы
    // при «вернули как было»).
    expect(src).not.toMatch(/CreateEquipmentForm/);
    expect(src).toMatch(/href="\/admin\/equipment\/new"/);
    // Admin UI 2.5: текст action-кнопки сократили до «Добавить»;
    // длинный лейбл «Добавить оборудование» остаётся в EmptyState.
    expect(src).toMatch(/Добавить/);
  });

  test('страница /admin/equipment/new рендерит форму создания и back-link', () => {
    const src = readSrc('apps/web/app/admin/equipment/new/page.tsx');
    expect(src).toMatch(/CreateEquipmentForm/);
    expect(src).toMatch(/operations=\{operations\}/);
    // Admin UI 2.5: AdminPageShell + back-link через обычный <Link>.
    expect(src).toMatch(/href="\/admin\/equipment"/);
    expect(src).toMatch(/AdminPageShell/);
    expect(src).toMatch(/getShiftMeta/);
  });

  test('CreateEquipmentForm содержит все обязательные поля и кнопку submit', () => {
    const src = readSrc('apps/web/app/admin/equipment/create-form.tsx');
    expect(src).toMatch(/name="name"/);
    expect(src).toMatch(/required/);
    expect(src).toMatch(/name="displayNumber"/);
    // Чек-лист операций — Admin UI 2.6 использует chip-list вместо
    // option-list; имя поля для submit осталось `operationIds`.
    expect(src).toMatch(/name="operationIds"/);
    // Submit-кнопка — «Создать» (Admin UI 2.6 sokraty).
    expect(src).toMatch(/Создать/);
  });

  test('createEquipmentAction обращается к POST /api/equipment и редиректит на карточку', () => {
    const src = readSrc('apps/web/app/admin/equipment/actions.ts');
    expect(src).toMatch(/createEquipment\(/);
    expect(src).toMatch(/redirect\(`\/admin\/equipment\/\$\{createdId\}`\)/);
    expect(src).toMatch(/revalidatePath\('\/admin\/equipment'\)/);
    // Пустое название должно отсекаться ещё на стороне action — это
    // даёт менеджеру понятную ошибку «Название обязательно» без
    // сетевого round-trip.
    expect(src).toMatch(/Название обязательно/);
  });
});

describe('admin/equipment/[id] — переименование оборудования', () => {
  test('detail-страница рендерит форму названия отдельной секцией', () => {
    const src = readSrc('apps/web/app/admin/equipment/[id]/page.tsx');
    expect(src).toMatch(/EquipmentNameForm/);
    // Admin UI 2.6: «Название» и «Номер» теперь живут в общей карточке
    // «Основное», секция QR-этикетки осталась рядом.
    expect(src).toMatch(/title="Основное"/);
    // Старые секции не должны быть удалены — это «do not break»
    // условие из ТЗ §8.
    expect(src).toMatch(/EquipmentDisplayNumberForm/);
    expect(src).toMatch(/EquipmentOperationsEditor/);
  });

  test('EquipmentNameForm — input name="name" с required и привязкой к updateEquipmentNameAction', () => {
    const src = readSrc('apps/web/app/admin/equipment/[id]/edit-form.tsx');
    expect(src).toMatch(/EquipmentNameForm/);
    expect(src).toMatch(/updateEquipmentNameAction/);
    expect(src).toMatch(/name="name"/);
    // Admin UI 2.6: текст кнопки сократили до «Сохранить».
    expect(src).toMatch(/Сохранить/);
  });

  test('updateEquipmentNameAction шлёт PATCH через updateEquipment и валидирует пустое имя', () => {
    const src = readSrc('apps/web/app/admin/equipment/[id]/actions.ts');
    expect(src).toMatch(/updateEquipmentNameAction/);
    expect(src).toMatch(/updateEquipment\(equipmentId,\s*\{\s*name\s*\}/);
    expect(src).toMatch(/Название обязательно/);
    // /work показывает имя в форме старта смены — после
    // переименования его кэш надо сбросить.
    expect(src).toMatch(/revalidatePath\('\/work'\)/);
  });
});

describe('backend equipment контракт', () => {
  test('контроллер выставляет POST /equipment c CreateEquipmentSchema под ADMIN/SHOP_MANAGER', () => {
    const src = readSrc('apps/api/src/modules/equipment/equipment.controller.ts');
    expect(src).toMatch(/@Post\(\)/);
    expect(src).toMatch(/CreateEquipmentSchema/);
    expect(src).toMatch(/@Roles\('SHOP_MANAGER',\s*'ADMIN'\)/);
  });

  test('UpdateEquipmentSchema умеет name и не ломает displayNumber', () => {
    const src = readSrc('packages/shared/src/equipment.ts');
    expect(src).toMatch(/CreateEquipmentSchema/);
    expect(src).toMatch(/name:\s*NameField\.optional\(\)/);
    expect(src).toMatch(/displayNumber:\s*DisplayNumberField/);
    // Автогенерация qrCode не должна попасть в схему — это инвариант
    // ADR-0008, scan flow ломать нельзя.
    expect(src).not.toMatch(/qrCode:\s*z\./);
  });

  test('EquipmentService умеет create + name update + slug-генерацию', () => {
    const src = readSrc('apps/api/src/modules/equipment/equipment.service.ts');
    expect(src).toMatch(/async create\(/);
    expect(src).toMatch(/nextAvailableCode/);
    expect(src).toMatch(/slugifyName/);
    // Каноничный qrCode по ADR-0008.
    expect(src).toMatch(/equipment:\$\{created\.id\}/);
    // PATCH должен принимать name.
    expect(src).toMatch(/data\.name = dto\.name/);
  });
});
