/**
 * Smoke-тесты для управления сотрудниками
 * (`/admin/employees`, `/admin/employees/new`, `/admin/employees/[id]`,
 * + post-задача «Добавить сотрудника» поверх ADR-0021).
 *
 * Полноценного React-рендера в проекте нет (vitest + Node, без jsdom),
 * поэтому фиксируем структуру на уровне исходников: что нужная форма
 * подключена, что server-action существует, что backend-роут добавлен.
 * Этого достаточно, чтобы поймать регресс «удалили кнопку создания»
 * или «убрали POST из контроллера сотрудников».
 *
 * Парный пример — `tests/smoke/equipment-admin.smoke.test.ts`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('admin/employees — кнопка «Добавить сотрудника» в шапке списка', () => {
  test('страница списка ведёт на /admin/employees/new и НЕ подключает форму создания inline', () => {
    const src = readSrc('apps/web/app/admin/employees/page.tsx');
    expect(src).toMatch(/href="\/admin\/employees\/new"/);
    // Admin UI 2.5: текст кнопки сократили до «Добавить» (subtitle/actions
    // должны быть короткими). Раньше было «Добавить сотрудника».
    expect(src).toMatch(/Добавить/);
    // Inline-формы создания на списке быть не должно — это ровно тот
    // паттерн, который был зафиксирован для equipment / operations /
    // warehouses (создание = отдельная страница).
    expect(src).not.toMatch(/CreateEmployeeForm/);
  });

  test('страница списка не сломала редактирование: ссылка «Открыть» на карточку остаётся', () => {
    const src = readSrc('apps/web/app/admin/employees/page.tsx');
    expect(src).toMatch(/href=\{`\/admin\/employees\/\$\{e\.id\}`\}/);
  });
});

describe('admin/employees/new — отдельная страница создания сотрудника', () => {
  test('страница /admin/employees/new рендерит форму создания и back-link к списку', () => {
    const src = readSrc('apps/web/app/admin/employees/new/page.tsx');
    expect(src).toMatch(/CreateEmployeeForm/);
    // Admin UI 2.5: вместо `DetailPageHeader` теперь `AdminPageShell`
    // с back-link через обычный `<Link href="/admin/employees">`.
    expect(src).toMatch(/href="\/admin\/employees"/);
    expect(src).toMatch(/AdminPageShell/);
    expect(src).toMatch(/Новый сотрудник/);
  });

  test('CreateEmployeeForm содержит все обязательные поля и кнопку submit', () => {
    const src = readSrc('apps/web/app/admin/employees/create-form.tsx');
    // Поля собираются строго из существующей модели Employee — никаких
    // выдуманных. Список зеркалит docs/screens.md §10d.
    expect(src).toMatch(/name="fullName"/);
    expect(src).toMatch(/name="login"/);
    expect(src).toMatch(/name="pin"/);
    expect(src).toMatch(/name="role"/);
    expect(src).toMatch(/name="compensationType"/);
    // Поле `paymentType` удалено: единственный источник истины «как
    // платим» — `compensationType` (см. `docs/domain.md §9a`,
    // ADR-0021 + post-задача «remove paymentType»).
    expect(src).not.toMatch(/name="paymentType"/);
    expect(src).toMatch(/name="salaryPerShift"/);
    // Submit на отдельной странице создания. Admin UI 2.6: текст
    // кнопки сократили до «Создать», как у остальных compact-форм.
    expect(src).toMatch(/Создать/);
  });

  test('createEmployeeAction обращается к POST /api/employees и редиректит на карточку', () => {
    const src = readSrc('apps/web/app/admin/employees/actions.ts');
    expect(src).toMatch(/createEmployee\(/);
    expect(src).toMatch(/redirect\(`\/admin\/employees\/\$\{createdId\}`\)/);
    expect(src).toMatch(/revalidatePath\('\/admin\/employees'\)/);
    // Локальные guards до сетевого round-trip — даём менеджеру
    // понятную ошибку без 400 от backend.
    expect(src).toMatch(/Введите ФИО сотрудника/);
    expect(src).toMatch(/Логин должен быть не короче 2 символов/);
    expect(src).toMatch(/PIN должен быть не короче 4 символов/);
  });

  test('updateEmployeeAction остался на месте — редактирование не сломано', () => {
    // Защищаем существующий контракт §10d: если кто-то случайно
    // снесёт update, edit-форма перестанет сохранять. Этот guard в
    // точности тот же, что в smoke equipment-admin §«detail».
    const src = readSrc('apps/web/app/admin/employees/actions.ts');
    expect(src).toMatch(/updateEmployeeAction/);
    expect(src).toMatch(/updateEmployee\(employeeId/);
  });
});

describe('backend employees контракт', () => {
  test('контроллер выставляет POST /employees c CreateEmployeeSchema под ADMIN/SHOP_MANAGER', () => {
    const src = readSrc('apps/api/src/modules/employees/employees.controller.ts');
    expect(src).toMatch(/@Post\(\)/);
    expect(src).toMatch(/CreateEmployeeSchema/);
    expect(src).toMatch(/@Roles\('SHOP_MANAGER',\s*'ADMIN'\)/);
    // PATCH/GET по-прежнему живы — без них карточку нельзя ни
    // прочитать, ни сохранить.
    expect(src).toMatch(/@Patch\(':id'\)/);
    expect(src).toMatch(/@Get\(':id'\)/);
  });

  test('CreateEmployeeSchema умеет fullName/login/pin/role/compensationType + окладные поля', () => {
    const src = readSrc('packages/shared/src/employees.ts');
    expect(src).toMatch(/CreateEmployeeSchema/);
    expect(src).toMatch(/fullName:/);
    expect(src).toMatch(/login:/);
    expect(src).toMatch(/pin:/);
    expect(src).toMatch(/role:/);
    expect(src).toMatch(/compensationType:/);
    expect(src).toMatch(/salaryPerShift:/);
    // Список ролей зеркалит UI ROLE_LABELS (без служебной DISPLAY).
    expect(src).toMatch(/EMPLOYEE_ROLES/);
    expect(src).not.toMatch(/'DISPLAY'/);
    // `paymentType`/`PaymentType` полностью удалены — единственный
    // источник истины «как платим» теперь `compensationType`.
    expect(src).not.toMatch(/paymentType/);
    expect(src).not.toMatch(/PaymentType/);
    expect(src).not.toMatch(/PAYMENT_TYPES/);
  });

  test('EmployeesService.create хеширует PIN через bcrypt и ловит P2002 как EMPLOYEE_LOGIN_TAKEN', () => {
    const src = readSrc('apps/api/src/modules/employees/employees.service.ts');
    expect(src).toMatch(/async create\(/);
    expect(src).toMatch(/bcrypt\.hash/);
    expect(src).toMatch(/EmployeeLoginTakenException/);
    // UPDATE-флоу не должен быть тронут случайным рефакторингом.
    expect(src).toMatch(/async update\(/);
    expect(src).toMatch(/EmployeeSalaryRateRequiredException/);
  });
});
