/**
 * Smoke-тесты для управления display-экранами
 * (`/admin/display-screens`, `/admin/display-screens/new` +
 * backend `POST /api/display-screens`).
 *
 * Полноценного React-рендера в проекте нет (vitest + Node, без jsdom),
 * поэтому фиксируем структуру на уровне исходников: что нужная форма
 * подключена, что server-action существует, что backend-роут добавлен.
 * Этого достаточно, чтобы поймать регресс «удалили кнопку создания»
 * или «убрали POST из контроллера дисплеев», и чтобы случайным
 * рефакторингом не сломать auto-resolve-логику подразделения для
 * DISPLAY-роли в shopfloor.
 *
 * Парные примеры — `tests/smoke/employees-admin.smoke.test.ts`,
 * `tests/smoke/equipment-admin.smoke.test.ts`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('admin/display-screens — кнопка «Создать экран» в шапке списка', () => {
  test('страница списка ведёт на /admin/display-screens/new и НЕ подключает форму создания inline', () => {
    const src = readSrc('apps/web/app/admin/display-screens/page.tsx');
    expect(src).toMatch(/href="\/admin\/display-screens\/new"/);
    expect(src).toMatch(/Создать экран/);
    // Inline-формы создания на списке быть не должно — паттерн зеркалит
    // employees / equipment / operations.
    expect(src).not.toMatch(/CreateDisplayScreenForm/);
  });

  test('страница списка показывает базовые колонки (название, подразделение, логин, статус)', () => {
    const src = readSrc('apps/web/app/admin/display-screens/page.tsx');
    expect(src).toMatch(/Название/);
    expect(src).toMatch(/Подразделение/);
    // Admin UI 2.5: колонки сократили — «Логин дисплея» → «Логин»,
    // «Активен» → «Статус» (badge активен/отключён).
    expect(src).toMatch(/Логин/);
    expect(src).toMatch(/Статус/);
  });
});

describe('admin/display-screens/new — отдельная страница создания', () => {
  test('страница /admin/display-screens/new рендерит форму создания и back-link к списку', () => {
    const src = readSrc('apps/web/app/admin/display-screens/new/page.tsx');
    expect(src).toMatch(/CreateDisplayScreenForm/);
    // Admin UI 2.5: AdminPageShell + back-link через обычный <Link>.
    expect(src).toMatch(/AdminPageShell/);
    expect(src).toMatch(/href="\/admin\/display-screens"/);
    expect(src).toMatch(/Новый display-экран/);
  });

  test('CreateDisplayScreenForm содержит все обязательные поля и кнопку submit', () => {
    const src = readSrc('apps/web/app/admin/display-screens/create-form.tsx');
    // Поля собраны строго по DTO POST /api/display-screens
    // (см. `packages/shared/src/display-screens.ts`).
    expect(src).toMatch(/name="name"/);
    // Подразделение — FK на master-справочник `CompanyDivision`.
    expect(src).toMatch(/name="companyDivisionId"/);
    expect(src).toMatch(/name="login"/);
    expect(src).toMatch(/name="pin"/);
    expect(src).toMatch(/name="isActive"/);
    // Submit на отдельной странице создания — «Создать экран».
    expect(src).toMatch(/Создать экран/);
  });

  test('createDisplayScreenAction обращается к POST /api/display-screens и редиректит на список', () => {
    const src = readSrc('apps/web/app/admin/display-screens/actions.ts');
    expect(src).toMatch(/createDisplayScreen\(/);
    expect(src).toMatch(/redirect\('\/admin\/display-screens'\)/);
    expect(src).toMatch(/revalidatePath\('\/admin\/display-screens'\)/);
    // Локальные guards до сетевого round-trip — даём менеджеру
    // понятную ошибку без 400 от backend.
    expect(src).toMatch(/Название экрана должно быть не короче/);
    expect(src).toMatch(/Логин должен быть не короче 2 символов/);
    expect(src).toMatch(/PIN должен быть не короче 4 символов/);
  });
});

describe('backend display-screens контракт', () => {
  test('контроллер выставляет POST /display-screens c CreateDisplayScreenSchema под ADMIN/SHOP_MANAGER', () => {
    const src = readSrc(
      'apps/api/src/modules/display-screens/display-screens.controller.ts',
    );
    expect(src).toMatch(/@Post\(\)/);
    expect(src).toMatch(/CreateDisplayScreenSchema/);
    expect(src).toMatch(/@Roles\('SHOP_MANAGER',\s*'ADMIN'\)/);
    expect(src).toMatch(/@Get\(\)/);
  });

  test('CreateDisplayScreenSchema — name/companyDivisionId/login/pin/isActive (без выбора существующего DISPLAY)', () => {
    const src = readSrc('packages/shared/src/display-screens.ts');
    expect(src).toMatch(/CreateDisplayScreenSchema/);
    expect(src).toMatch(/name:/);
    expect(src).toMatch(/companyDivisionId:/);
    expect(src).toMatch(/login:/);
    expect(src).toMatch(/pin:/);
    expect(src).toMatch(/isActive:/);
    // На MVP сознательно нет режима «привязать к существующему
    // employee» — каждое создание заводит новую DISPLAY-учётку.
    // Извлекаем только тело CreateDisplayScreenSchema и убеждаемся,
    // что там нет `employeeId` (в response-DTO он быть обязан — это
    // ID созданной учётки).
    const createSchemaMatch = src.match(
      /CreateDisplayScreenSchema\s*=\s*z\.object\(\{[\s\S]*?\n\}\);/,
    );
    expect(createSchemaMatch).not.toBeNull();
    expect(createSchemaMatch![0]).not.toMatch(/employeeId/);
  });

  test('DisplayScreensService.create — обе колонки PIN + транзакция + DISPLAY_LOGIN_TAKEN', () => {
    const src = readSrc(
      'apps/api/src/modules/display-screens/display-screens.service.ts',
    );
    expect(src).toMatch(/async create\(/);
    // Раньше здесь звался bcrypt.hash напрямую. С фичей «показать пароль
    // сотрудника» PIN стал парой колонок (pinHash + pinEnc), и считает
    // её общий common/pin-columns.ts: DISPLAY-учётка — обычная строка
    // Employee, она видна в /admin/employees/[id].
    expect(src).toMatch(/buildPinColumns/);
    // Главный инвариант: одна транзакция, обе сущности или ни одной.
    expect(src).toMatch(/\$transaction/);
    expect(src).toMatch(/Role\.DISPLAY/);
    expect(src).toMatch(/DisplayLoginTakenException/);
  });

  test('app.module регистрирует DisplayScreensModule', () => {
    const src = readSrc('apps/api/src/app.module.ts');
    expect(src).toMatch(/DisplayScreensModule/);
  });

  test('schema.prisma содержит модель DisplayScreenConfig с employeeId UNIQUE и связью на Employee', () => {
    const src = readSrc('prisma/schema.prisma');
    expect(src).toMatch(/model DisplayScreenConfig/);
    expect(src).toMatch(/employeeId\s+String\s+@unique/);
    expect(src).toMatch(/displayScreen\s+DisplayScreenConfig\?/);
  });
});

describe('admin/display-screens/[id] — карточка экрана (правка)', () => {
  // Экран живёт в цехе годами, а его атрибуты меняются: подразделение
  // переехало, железку переименовали, PIN забыли. До карточки любая из
  // этих правок означала «удалить и завести заново» — с потерей
  // DISPLAY-учётки, её логина (уникальный индекс) и истории событий.

  test('страница карточки читает экран, ловит 404 и рендерит обе формы', () => {
    const src = readSrc('apps/web/app/admin/display-screens/[id]/page.tsx');
    expect(src).toMatch(/getDisplayScreen\(/);
    // 404 → notFound(), а не общий error-box: экрана просто нет.
    expect(src).toMatch(/statusCode === 404[\s\S]{0,40}notFound\(\)/);
    expect(src).toMatch(/DisplayScreenMainForm/);
    expect(src).toMatch(/DisplayScreenPinForm/);
    // Подразделения — из master-справочника CompanyDivision.
    expect(src).toMatch(/listCompanyDivisions\(/);
    // Даты в технической врезке — с явной таймзоной, иначе hydration.
    expect(src).toMatch(/timeZone: 'Europe\/Moscow'/);
  });

  test('форма «Основное» правит название, подразделение и логин', () => {
    const src = readSrc('apps/web/app/admin/display-screens/[id]/edit-form.tsx');
    expect(src).toMatch(/id="ds-edit-name"/);
    expect(src).toMatch(/id="ds-edit-companyDivisionId"/);
    expect(src).toMatch(/id="ds-edit-login"/);
    expect(src).toMatch(/updateDisplayScreenAction\.bind\(null, screen\.id\)/);
    // Текущее подразделение подставлено в select.
    expect(src).toMatch(/defaultValue=\{[\s\S]{0,80}screen\.companyDivisionId/);
  });

  test('PIN — отдельная форма с повтором (не поле в «Основном»)', () => {
    const src = readSrc('apps/web/app/admin/display-screens/[id]/edit-form.tsx');
    // Сохранение названия не должно иметь шанса сбросить PIN монитора,
    // поэтому это ДВЕ разные формы и два разных server action'а.
    expect(src).toMatch(/id="ds-edit-pin"/);
    expect(src).toMatch(/id="ds-edit-pin-repeat"/);
    expect(src).toMatch(/updateDisplayScreenPinAction\.bind\(null, screen\.id\)/);
    const main = src.match(
      /export function DisplayScreenMainForm[\s\S]*?\n}\n/,
    );
    expect(main).not.toBeNull();
    expect(main![0]).not.toMatch(/name="pin"/);
  });

  test('server actions зовут PATCH и ревалидируют список и карточку', () => {
    const src = readSrc('apps/web/app/admin/display-screens/[id]/actions.ts');
    expect(src).toMatch(/'use server'/);
    expect(src).toMatch(/updateDisplayScreen\(/);
    expect(src).toMatch(/revalidatePath\('\/admin\/display-screens'\)/);
    expect(src).toMatch(/revalidatePath\(`\/admin\/display-screens\/\$\{id\}`\)/);
    // Повтор PIN'а проверяется локально — без сетевого round-trip.
    expect(src).toMatch(/pin !== pinRepeat/);
    // Файл с 'use server' экспортирует ТОЛЬКО async-функции: initial
    // state лежит рядом (иначе страница падает в рантайме, а tsc/lint
    // молчат).
    expect(src).not.toMatch(/export const /);
  });

  test('drill-in по строке ведёт в карточку, «Монитор» — отдельная ссылка на витрину', () => {
    const src = readSrc('apps/web/app/admin/display-screens/page.tsx');
    expect(src).toMatch(/rowHref=\{screenCardHref\}/);
    expect(src).toMatch(
      /function screenCardHref[\s\S]*?`\/admin\/display-screens\/\$\{s\.id\}`/,
    );
    // Витрина осталась доступной отдельной колонкой-действием.
    expect(src).toMatch(/href=\{screenBoardHref\(s\)\}/);
  });

  test('backend: GET/PATCH :id под теми же ролями, isActive в PATCH не принимается', () => {
    const ctrl = readSrc(
      'apps/api/src/modules/display-screens/display-screens.controller.ts',
    );
    expect(ctrl).toMatch(/@Get\(':id'\)/);
    expect(ctrl).toMatch(/@Patch\(':id'\)/);
    expect(ctrl).toMatch(/UpdateDisplayScreenSchema/);

    const shared = readSrc('packages/shared/src/display-screens.ts');
    const updateSchema = shared.match(
      /UpdateDisplayScreenSchema\s*=\s*z[\s\S]*?\.strict\(\);/,
    );
    expect(updateSchema).not.toBeNull();
    // Включение/выключение — контур архива (он же гасит DISPLAY-учётку).
    // Второй путь к тому же флагу разъехался бы с `Employee.active`.
    expect(updateSchema![0]).not.toMatch(/isActive/);
    expect(updateSchema![0]).toMatch(/companyDivisionId/);
    expect(updateSchema![0]).toMatch(/pin:/);
  });

  test('DisplayScreensService.update — транзакция на пару «конфиг + учётка» и аудит без PIN', () => {
    const src = readSrc(
      'apps/api/src/modules/display-screens/display-screens.service.ts',
    );
    expect(src).toMatch(/async update\(/);
    expect(src).toMatch(/DisplayScreenNotFoundException/);
    expect(src).toMatch(/COMPANY_DIVISION_NOT_FOUND/);
    expect(src).toMatch(/DisplayLoginTakenException/);
    const update = src.match(/async update\([\s\S]*?\n  }\n/);
    expect(update).not.toBeNull();
    // Имя учётки идёт следом за именем экрана — иначе аудит врёт.
    expect(update![0]).toMatch(/fullName = `Display: \$\{dto\.name\}`/);
    expect(update![0]).toMatch(/\$transaction/);
    // В журнал уходит ФЛАГ смены PIN, а не сам PIN и не его хеш.
    expect(update![0]).toMatch(/pinChanged: true/);
    expect(update![0]).not.toMatch(/payload:[\s\S]{0,400}pin: /);
  });
});

describe('admin-sidebar — «Цеховой монитор» ведёт в админ-управление', () => {
  test('sidebar содержит пункт «Цеховой монитор» и ведёт на /admin/display-screens', () => {
    const src = readSrc('apps/web/components/admin-sidebar.tsx');
    expect(src).toMatch(/label:\s*['"]Цеховой монитор['"]/);
    // href и label идут в одном объекте — закрепляем привязку.
    expect(src).toMatch(
      /href:\s*['"]\/admin\/display-screens['"][\s\S]*?label:\s*['"]Цеховой монитор['"]/,
    );
    // Иконка по требованию — MonitorSmartphone.
    expect(src).toMatch(
      /label:\s*['"]Цеховой монитор['"][\s\S]*?Icon:\s*MonitorSmartphone/,
    );
    // match расширен на префикс админ-раздела для корректной подсветки.
    expect(src).toMatch(
      /label:\s*['"]Цеховой монитор['"][\s\S]*?match:\s*\[\s*['"]\/admin\/display-screens['"]/,
    );
  });

  test('sidebar НЕ содержит ссылку /shopfloor/display (TV-экран не в админке)', () => {
    const src = readSrc('apps/web/components/admin-sidebar.tsx');
    expect(src).not.toMatch(/href:\s*['"]\/shopfloor\/display['"]/);
  });

  test('порядок sidebar: Обзор → Заказы → Цеховой монитор → Сотрудники → … → Себестоимость', () => {
    const src = readSrc('apps/web/components/admin-sidebar.tsx');
    const labels = [
      'Обзор',
      'Заказы',
      'Цеховой монитор',
      'Сотрудники',
      'Оборудование',
      'Операции',
      'Маршруты',
      'Техкарты',
      'Склады',
      'Принтеры',
      'Диагностика',
      'Себестоимость',
    ];
    const positions = labels.map((l) => src.indexOf(`label: '${l}'`));
    positions.forEach((p, i) => {
      expect(p, `label «${labels[i]}» должен присутствовать`).toBeGreaterThan(0);
    });
    for (let i = 1; i < positions.length; i += 1) {
      expect(
        positions[i],
        `«${labels[i]}» должен идти после «${labels[i - 1]}»`,
      ).toBeGreaterThan(positions[i - 1]);
    }
  });
});

describe('admin/display-screens — Admin UI shell для списка и create', () => {
  test('страница списка использует AdminPageShell + AdminCard + AdminTable', () => {
    const src = readSrc('apps/web/app/admin/display-screens/page.tsx');
    expect(src).toMatch(/AdminPageShell/);
    expect(src).toMatch(/AdminCard/);
    expect(src).toMatch(/AdminTable/);
    // Никакого старого page-shell / DetailPageHeader / <Icon name=…>.
    expect(src).not.toMatch(/className=['"]page-shell['"]/);
    expect(src).not.toMatch(/DetailPageHeader/);
    expect(src).not.toMatch(/<Icon\s+name=/);
    expect(src).not.toMatch(/from ['"]@\/components\/icon['"]/);
  });

  test('страница /admin/display-screens/new использует AdminPageShell + AdminCard', () => {
    const src = readSrc('apps/web/app/admin/display-screens/new/page.tsx');
    expect(src).toMatch(/AdminPageShell/);
    expect(src).toMatch(/AdminCard/);
    expect(src).not.toMatch(/className=['"]page-shell['"]/);
    expect(src).not.toMatch(/DetailPageHeader/);
    expect(src).not.toMatch(/<Icon\s+name=/);
    expect(src).not.toMatch(/from ['"]@\/components\/icon['"]/);
  });

  test('CreateDisplayScreenForm построена в admin-form-классах', () => {
    const src = readSrc('apps/web/app/admin/display-screens/create-form.tsx');
    expect(src).toMatch(/className=['"]admin-form['"]/);
    expect(src).toMatch(/admin-form-grid/);
    expect(src).toMatch(/admin-actions-row/);
    expect(src).not.toMatch(/<Icon\s+name=/);
  });
});

describe('shopfloor/display — изоляция от admin компонентов', () => {
  test('/shopfloor/display/page.tsx не импортирует admin-компоненты', () => {
    const src = readSrc('apps/web/app/shopfloor/display/page.tsx');
    expect(src).not.toMatch(/from ['"]@\/components\/admin['"]/);
    expect(src).not.toMatch(/AdminPageShell/);
    expect(src).not.toMatch(/AdminSidebar/);
  });
});

describe('shopfloor — auto-resolve подразделения для DISPLAY-роли (контракт жив)', () => {
  test('контроллер /api/shopfloor/display прокидывает CurrentUser в сервис', () => {
    const src = readSrc(
      'apps/api/src/modules/shopfloor/shopfloor.controller.ts',
    );
    expect(src).toMatch(/CurrentUser/);
    expect(src).toMatch(/getDisplaySummary\(query, user\)/);
  });

  test('shopfloor.service.ts резолвит подразделение по DisplayScreenConfig для роли DISPLAY', () => {
    const src = readSrc('apps/api/src/modules/shopfloor/shopfloor.service.ts');
    expect(src).toMatch(/resolveDisplayDivisionCode/);
    expect(src).toMatch(/displayScreenConfig\.findUnique/);
    expect(src).toMatch(/Role\.DISPLAY/);
    // Источник истины — `companyDivision.code` через FK.
    expect(src).toMatch(/companyDivision: \{ select: \{ code: true \} \}/);
    // Query-параметр приоритетнее автодетектора.
    expect(src).toMatch(/if \(query\.divisionCode\)/);
  });
});
