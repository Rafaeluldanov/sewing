/**
 * Smoke-тесты задачи «Статус заказа в admin UI 2.7».
 *
 * Зачем:
 *   - В форме `/admin/orders/new` появилось поле «Статус заказа»
 *     (visual-only «Черновик», т.к. `CreateOrderSchema` пока не
 *     принимает `status` — заказ создаётся как DRAFT).
 *   - После успешного создания админ-форма редиректит в новую
 *     карточку `/admin/orders/<id>`, а не в легаси `/orders/<id>`.
 *     Маркер — hidden `redirectTo="admin"` в форме + ветка в
 *     `createOrderAction`.
 *   - На карточке `/admin/orders/[id]` статус заказа выведен
 *     рядом с номером (header) и в карточке «1. Заказ»
 *     (`AdminStatusBadge` с тоном из `getOrderStatusTone`).
 *   - Лейблы и тоны держим в общем helper-е
 *     `apps/web/lib/admin-labels.ts`:
 *       * `formatOrderStatus(DRAFT)` → «Черновик»;
 *       * `formatOrderStatus(IN_PRODUCTION)` → «В производстве»;
 *       * `formatOrderStatus(DONE)` → «Готов»;
 *       * `formatOrderStatus(CANCELLED)` → «Отменён»;
 *       * `getOrderStatusTone(IN_PRODUCTION)` → `'info'`;
 *       * `getOrderStatusTone(DONE)` → `'success'`;
 *       * `getOrderStatusTone(CANCELLED)` → `'danger'`.
 *   - Старый `/orders/new` НЕ ломаем: его форма не содержит
 *     `redirectTo`, и ветка action оставляет редирект на
 *     `/orders/<id>`.
 *
 * Все проверки — source-level, чтобы CI не зависел от backend/БД.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  formatOrderStatus,
  getOrderStatusTone,
} from '../../apps/web/lib/admin-labels';

const repoRoot = path.resolve(__dirname, '..', '..');

function read(p: string): string {
  return readFileSync(path.join(repoRoot, p), 'utf8');
}
function exists(p: string): boolean {
  return existsSync(path.join(repoRoot, p));
}

// ---------------------------------------------------------------------------
// 1. admin-labels — formatOrderStatus / getOrderStatusTone
// ---------------------------------------------------------------------------

describe('admin-labels — formatOrderStatus / getOrderStatusTone', () => {
  test('файл и экспорты существуют', () => {
    expect(exists('apps/web/lib/admin-labels.ts')).toBe(true);
    const src = read('apps/web/lib/admin-labels.ts');
    expect(src).toMatch(/export function formatOrderStatus/);
    expect(src).toMatch(/export function getOrderStatusTone/);
  });

  test('formatOrderStatus возвращает человекочитаемые лейблы', () => {
    expect(formatOrderStatus('DRAFT')).toBe('Черновик');
    expect(formatOrderStatus('IN_PRODUCTION')).toBe('В производстве');
    expect(formatOrderStatus('DONE')).toBe('Готов');
    expect(formatOrderStatus('CANCELLED')).toBe('Отменён');
    expect(formatOrderStatus(null)).toBe('—');
    expect(formatOrderStatus(undefined)).toBe('—');
    // Неизвестный enum не должен ронять UI — fallback в формат строки.
    expect(formatOrderStatus('UNKNOWN_FUTURE')).toBe('UNKNOWN_FUTURE');
  });

  test('getOrderStatusTone сопоставляет статус и цветовой тон', () => {
    expect(getOrderStatusTone('DRAFT')).toBe('muted');
    expect(getOrderStatusTone('IN_PRODUCTION')).toBe('info');
    expect(getOrderStatusTone('DONE')).toBe('success');
    expect(getOrderStatusTone('CANCELLED')).toBe('danger');
    expect(getOrderStatusTone(null)).toBe('muted');
  });
});

// ---------------------------------------------------------------------------
// 2. /admin/orders/new — поле «Статус заказа» + redirectTo
// ---------------------------------------------------------------------------

describe('/admin/orders/new — статус «Черновик» через hidden status', () => {
  const formPath = 'apps/web/app/admin/orders/new/order-create-wizard.tsx';
  const formSrc = read(formPath);

  test('мастер создаёт заказ черновиком и не шлёт status/redirectTo', () => {
    // Заказ всегда рождается как DRAFT (Prisma default), мастер
    // статус не передаёт. Скрытых полей формы у него нет вообще —
    // шаги шлют DTO своими server actions.
    expect(formSrc).not.toMatch(/name="status"/);
    expect(formSrc).not.toMatch(/redirectTo/);
    expect(formSrc).toMatch(/createOrderDraftAction/);
    // Переход в расчёт — отдельный шаг «Проверка», а не поле статуса.
    expect(formSrc).toMatch(/finishOrderDraftAction/);
    expect(formSrc).toMatch(/Отправить в расчёт/);
  });
});

// ---------------------------------------------------------------------------
// 3. createOrderAction — поддержка redirectTo='admin'
// ---------------------------------------------------------------------------

describe('createOrderAction — поддержка redirectTo и совместимость с /orders/new', () => {
  const actionPath = 'apps/web/app/orders/actions.ts';
  const src = read(actionPath);

  test('action читает redirectTo из FormData', () => {
    expect(src).toMatch(/form\.get\('redirectTo'\)/);
  });

  test('admin-ветка редиректит на /admin/orders/<id>', () => {
    expect(src).toMatch(/redirect\(`\/admin\/orders\/\$\{created\.id\}`\)/);
    expect(src).toMatch(/redirectTo === 'admin'/);
    // revalidate новой и старой страниц — иначе data в кэше будет
    // отставать после создания заказа.
    expect(src).toMatch(/revalidatePath\('\/admin\/orders'\)/);
  });

  test('legacy-ветка по-прежнему редиректит на /orders/<id>', () => {
    // Это и есть гарантия, что старый `/orders/new` не сломан:
    // он не передаёт redirectTo, попадает в else и идёт в `/orders/<id>`.
    expect(src).toMatch(/redirect\(`\/orders\/\$\{created\.id\}`\)/);
  });

  test('добавлен TODO про status в DTO', () => {
    expect(src).toMatch(/TODO\(orders-status-on-create\)/);
  });
});

// ---------------------------------------------------------------------------
// 4. /admin/orders/[id] — AdminStatusBadge + redesign
// ---------------------------------------------------------------------------

describe('/admin/orders/[id] — статус заказа и management header', () => {
  const pagePath = 'apps/web/app/admin/orders/[id]/page.tsx';
  const src = read(pagePath);
  const headerPath =
    'apps/web/components/orders/view/order-management-header.tsx';
  const headerSrc = read(headerPath);

  test('лейбл и тон статуса берутся из admin-labels — теперь внутри контрола статуса', () => {
    // Бейдж статуса переехал в `OrderStatusSelect` (кликабельный, со
    // списком маршрута); словари лейблов/тонов не продублированы.
    const controlSrc = read(
      'apps/web/components/orders/view/order-status-select.tsx',
    );
    expect(controlSrc).toMatch(/formatOrderStatus/);
    expect(controlSrc).toMatch(/getOrderStatusTone/);
    expect(controlSrc).toMatch(/from '@\/lib\/admin-labels'/);
  });

  test('в шапке — контрол статуса и отдельный бейдж срока', () => {
    expect(headerSrc).toMatch(/<OrderStatusSelect/);
    // Бейдж контроля срока остаётся обычным `AdminStatusBadge`.
    expect(headerSrc).toMatch(/<AdminStatusBadge tone=\{deadlineTone\}/);
  });

  test('header показывает summary-поля (клиент, срок, изделие, цвет, план)', () => {
    expect(headerSrc).toMatch(/label="Клиент"/);
    expect(headerSrc).toMatch(/label="Срок"/);
    expect(headerSrc).toMatch(/label="Изделие \/ лекало"/);
    expect(headerSrc).toMatch(/label="Цвет"/);
    expect(headerSrc).toMatch(/label="Общий план"/);
    expect(headerSrc).toMatch(/label="Выпущено паспортов"/);
    expect(headerSrc).toMatch(/label="Упаковано"/);
    expect(headerSrc).toMatch(/label="Прогресс"/);
  });

  test('страница распределяет блоки по 5 management-вкладкам', () => {
    for (const tab of ['production', 'passports', 'plan', 'needs', 'history']) {
      expect(src).toMatch(new RegExp(`activeTab === '${tab}'`));
    }
    // Старых сеток с 11 зонами не осталось.
    expect(src).not.toMatch(/className="admin-order-detail-layout"/);
    expect(src).not.toMatch(/admin-order-detail-grid/);
  });
});

// ---------------------------------------------------------------------------
// 5. Legacy /orders/new — не сломан и НЕ редиректит в admin
// ---------------------------------------------------------------------------

describe('Legacy /orders/new — не редиректит в admin', () => {
  test('форма не содержит redirectTo="admin"', () => {
    const src = read('apps/web/app/orders/new/new-order-form.tsx');
    expect(src).not.toMatch(/redirectTo="admin"/);
    expect(src).not.toMatch(/name="redirectTo"/);
  });

  test('страница и форма легаси-маршрута на месте', () => {
    expect(exists('apps/web/app/orders/new/page.tsx')).toBe(true);
    expect(exists('apps/web/app/orders/new/new-order-form.tsx')).toBe(true);
  });
});
