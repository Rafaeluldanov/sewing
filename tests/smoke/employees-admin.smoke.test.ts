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

describe('GET /api/employees/cutters — узкий справочник раскройщиков для CUTTER_ASSISTANT', () => {
  // Регресс-щит для бага «помощник раскройщика не может выпустить
  // паспорт» (`docs/cutter-assistant-passport-release-recon.md`).
  // Фиксируем все четыре звена одновременно: контроллер, сервис,
  // shared DTO, frontend-страница и helper. Если хотя бы одно
  // звено сломается — баг вернётся.

  test('контроллер выставляет GET /employees/cutters c CUTTER_ASSISTANT в @Roles и ДО @Get(\':id\')', () => {
    const src = readSrc('apps/api/src/modules/employees/employees.controller.ts');
    // Узкий маршрут с собственным method-уровневым @Roles. Ищем
    // именно декоратор в начале строки (ровно два пробела отступа),
    // чтобы не ловить упоминания внутри JSDoc-комментариев.
    const cuttersMatch = src.match(/^ {2}@Get\('cutters'\)/m);
    const idMatch = src.match(/^ {2}@Get\(':id'\)/m);
    expect(cuttersMatch).not.toBeNull();
    expect(idMatch).not.toBeNull();
    const cuttersIdx = cuttersMatch!.index!;
    const idIdx = idMatch!.index!;
    // Иначе Nest распарсит литерал `cutters` как параметр `:id` и
    // улетит в `get('cutters')` → 404 EMPLOYEE_NOT_FOUND.
    expect(cuttersIdx).toBeLessThan(idIdx);
    // Method-уровневый @Roles переопределяет класс-уровневый
    // ('SHOP_MANAGER', 'ADMIN') и расширяет его на CUTTER_ASSISTANT.
    // Окно специально широкое — над @Get('cutters') живёт JSDoc-блок,
    // а сам @Roles(...) идёт прямо перед декоратором маршрута.
    const block = src.slice(
      Math.max(0, cuttersIdx - 1500),
      cuttersIdx,
    );
    expect(block).toMatch(
      /@Roles\(\s*'CUTTER_ASSISTANT',\s*'SHOP_MANAGER',\s*'ADMIN'\s*\)\s*$/,
    );
    // Класс по-прежнему admin-only — широкий /employees не открыт.
    expect(src).toMatch(/^@Roles\('SHOP_MANAGER',\s*'ADMIN'\)/m);
  });

  test('EmployeesService.listActiveCutters использует Prisma `select` (а не `include`/`toListDto`)', () => {
    const src = readSrc('apps/api/src/modules/employees/employees.service.ts');
    expect(src).toMatch(/async listActiveCutters\(/);
    const start = src.indexOf('async listActiveCutters(');
    expect(start).toBeGreaterThan(0);
    // Метод короткий — отсекаем по следующей закрывающей `}` блока.
    const block = src.slice(start, start + 800);
    // Hard-coded фильтр: только активные раскройщики.
    expect(block).toMatch(/role:\s*Role\.CUTTER/);
    expect(block).toMatch(/active:\s*true/);
    // Прямая проекция, никакого toListDto/include.
    expect(block).toMatch(
      /select:\s*\{\s*id:\s*true,\s*fullName:\s*true,\s*login:\s*true\s*\}/,
    );
    expect(block).not.toMatch(/toListDto/);
    expect(block).not.toMatch(/include:/);
    // ORDER BY fullName ASC — для предсказуемого UI-дропдауна.
    expect(block).toMatch(/orderBy:\s*\{\s*fullName:\s*'asc'\s*\}/);
  });

  test('shared DTO ActiveCutterListItemDto содержит ровно { id, fullName, login } и НЕ наследует EmployeeListItemDto', () => {
    const src = readSrc('packages/shared/src/employees.ts');
    expect(src).toMatch(/export interface ActiveCutterListItemDto/);
    const start = src.indexOf('export interface ActiveCutterListItemDto');
    const end = src.indexOf('}', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const block = src.slice(start, end);
    // Никакого `extends EmployeeListItemDto` — иначе любое будущее
    // поле широкого DTO утечёт через узкий endpoint.
    expect(block).not.toMatch(/extends/);
    // Поля жёстко зафиксированы.
    expect(block).toMatch(/id:\s*string/);
    expect(block).toMatch(/fullName:\s*string/);
    expect(block).toMatch(/login:\s*string/);
    // Никаких payroll-полей.
    expect(block).not.toMatch(/salaryPerShift/);
    expect(block).not.toMatch(/compensationType/);
    expect(block).not.toMatch(/companyDivision/);
  });

  test('apps/web/lib/employees-api.ts экспортирует listActiveCutters → /employees/cutters', () => {
    const src = readSrc('apps/web/lib/employees-api.ts');
    expect(src).toMatch(/export function listActiveCutters\(/);
    expect(src).toMatch(/apiFetch<ActiveCutterListItemDto\[\]>\('\/employees\/cutters'\)/);
  });

  test('страница /orders/[id]/passports/new использует listActiveCutters, а не listEmployees', () => {
    const src = readSrc('apps/web/app/orders/[id]/passports/new/page.tsx');
    // Импорт переключён.
    expect(src).toMatch(/import \{ listActiveCutters \} from '@\/lib\/employees-api'/);
    // Старый широкий helper больше не вызывается на этой странице.
    expect(src).not.toMatch(/listEmployees\(/);
    // Новая ветка вызова.
    expect(src).toMatch(/await listActiveCutters\(\)/);
  });
});
