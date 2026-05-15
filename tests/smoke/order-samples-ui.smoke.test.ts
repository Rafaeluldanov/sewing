/**
 * Smoke-тесты UI «Сигнальный образец» — source-level (без backend и БД).
 *
 * Проверяем, что в карточке заказа `/admin/orders/[id]`:
 *   - есть таб `signalSample`;
 *   - есть модалка запуска с правильными полями и текстами;
 *   - есть переключатель `countsTowardOrderQty` и radio
 *     `materialMode`;
 *   - есть actions approve / reject / cancel;
 *   - нет добавления в sidebar.
 *
 * См. `apps/web/components/orders/view/order-view-tabs-config.ts`,
 * `apps/web/components/orders/samples/*`,
 * `apps/web/app/admin/orders/[id]/page.tsx`,
 * `apps/web/lib/order-samples-api.ts`.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function read(p: string): string {
  return readFileSync(path.join(repoRoot, p), 'utf8');
}
function exists(p: string): boolean {
  return existsSync(path.join(repoRoot, p));
}

// ---------------------------------------------------------------------------
// 1. Tab registered
// ---------------------------------------------------------------------------

describe('order-samples — таб зарегистрирован', () => {
  test('order-view-tabs-config.ts содержит signalSample', () => {
    const src = read('apps/web/components/orders/view/order-view-tabs-config.ts');
    expect(src).toMatch(/'signalSample'/);
    expect(src).toMatch(/Сигнальный образец/);
  });
  test('page.tsx подключает OrderSignalSampleTab под activeTab === "signalSample"', () => {
    const src = read('apps/web/app/admin/orders/[id]/page.tsx');
    expect(src).toMatch(/OrderSignalSampleTab/);
    expect(src).toMatch(/activeTab === 'signalSample'/);
  });
});

// ---------------------------------------------------------------------------
// 2. Components present
// ---------------------------------------------------------------------------

describe('order-samples — components present', () => {
  test('файлы компонентов существуют', () => {
    expect(
      exists('apps/web/components/orders/samples/order-samples-card.tsx'),
    ).toBe(true);
    expect(
      exists(
        'apps/web/components/orders/samples/start-order-sample-modal.tsx',
      ),
    ).toBe(true);
    expect(
      exists(
        'apps/web/components/orders/samples/order-sample-status-badge.tsx',
      ),
    ).toBe(true);
    expect(
      exists(
        'apps/web/components/orders/samples/order-sample-effect-preview.tsx',
      ),
    ).toBe(true);
    expect(
      exists(
        'apps/web/components/orders/view/tabs/order-signal-sample-tab.tsx',
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Modal fields
// ---------------------------------------------------------------------------

describe('order-samples — модалка запуска', () => {
  const modalSrc = () =>
    read(
      'apps/web/components/orders/samples/start-order-sample-modal.tsx',
    );

  test('заголовок модалки', () => {
    expect(modalSrc()).toMatch(/Запуск сигнального образца/);
  });

  test('select размеров (sizeId)', () => {
    const s = modalSrc();
    expect(s).toMatch(/Размер из заказа/);
    expect(s).toMatch(/name="sizeId"/);
  });

  test('input qty integer-only (min=1)', () => {
    const s = modalSrc();
    expect(s).toMatch(/name="qty"/);
    expect(s).toMatch(/type="number"/);
    expect(s).toMatch(/min=\{1\}/);
    expect(s).toMatch(/step=\{1\}/);
  });

  test('radio "materialMode" с SAMPLE_ONLY и FULL_ORDER + тексты', () => {
    const s = modalSrc();
    expect(s).toMatch(/value="SAMPLE_ONLY"/);
    expect(s).toMatch(/value="FULL_ORDER"/);
    expect(s).toMatch(/Только на образец/);
    expect(s).toMatch(/На весь заказ/);
    expect(s).toMatch(/Система запустит образец и рассчитает потребность только на выбранное/);
    expect(s).toMatch(/потребность на материалы может быть\s*\n?\s*сформирована на весь заказ/);
  });

  test('switch "countsTowardOrderQty" + дефолт false + тексты-подсказки', () => {
    const s = modalSrc();
    expect(s).toMatch(/name="countsTowardOrderQty"/);
    expect(s).toMatch(/role="switch"/);
    expect(s).toMatch(/useState\(false\)/);
    expect(s).toMatch(/Включить образец в тираж/);
    expect(s).toMatch(/Образец будет отдельной единицей сверх тиража/);
    expect(s).toMatch(
      /После согласования образец будет засчитан в количество заказа/,
    );
  });

  test('preview-таблица «Материалы / Включить в тираж / Сейчас / После согласования»', () => {
    const previewSrc = read(
      'apps/web/components/orders/samples/order-sample-effect-preview.tsx',
    );
    expect(previewSrc).toMatch(/Материалы/);
    expect(previewSrc).toMatch(/Включить в тираж/);
    expect(previewSrc).toMatch(/Сейчас/);
    expect(previewSrc).toMatch(/После согласования/);
  });
});

// ---------------------------------------------------------------------------
// 4. Actions
// ---------------------------------------------------------------------------

describe('order-samples — actions exist', () => {
  test('order-samples-actions.ts экспортирует start/approve/reject/cancel', () => {
    const s = read('apps/web/app/admin/orders/[id]/order-samples-actions.ts');
    expect(s).toMatch(/export async function startOrderSampleAction/);
    expect(s).toMatch(/export async function approveOrderSampleAction/);
    expect(s).toMatch(/export async function rejectOrderSampleAction/);
    expect(s).toMatch(/export async function cancelOrderSampleAction/);
  });
  test('OrderSamplesCard рендерит actions для IN_PROGRESS', () => {
    const s = read('apps/web/components/orders/samples/order-samples-card.tsx');
    expect(s).toMatch(/Согласовать/);
    expect(s).toMatch(/Отклонить/);
    expect(s).toMatch(/Отменить/);
  });
});

// ---------------------------------------------------------------------------
// 5. API client
// ---------------------------------------------------------------------------

describe('order-samples — API client wrappers', () => {
  test('order-samples-api.ts экспортирует все 5 функций', () => {
    const s = read('apps/web/lib/order-samples-api.ts');
    expect(s).toMatch(/export function listOrderSamples/);
    expect(s).toMatch(/export function startOrderSample/);
    expect(s).toMatch(/export function getOrderSample/);
    expect(s).toMatch(/export function approveOrderSample/);
    expect(s).toMatch(/export function rejectOrderSample/);
    expect(s).toMatch(/export function cancelOrderSample/);
  });
});

// ---------------------------------------------------------------------------
// 6. No sidebar addition
// ---------------------------------------------------------------------------

describe('order-samples — sidebar НЕ изменён', () => {
  test('admin layout / sidebar не содержит ссылку на /admin/order-samples', () => {
    const candidates = [
      'apps/web/app/admin/layout.tsx',
      'apps/web/components/admin/admin-sidebar.tsx',
    ];
    for (const p of candidates) {
      if (!exists(p)) continue;
      const s = read(p);
      expect(s.includes('/admin/order-samples')).toBe(false);
      expect(s.includes('order-samples')).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Backend endpoints documented
// ---------------------------------------------------------------------------

describe('order-samples — backend endpoints', () => {
  test('контроллер существует и объявляет все 6 routes', () => {
    expect(
      exists(
        'apps/api/src/modules/order-samples/order-samples.controller.ts',
      ),
    ).toBe(true);
    const s = read(
      'apps/api/src/modules/order-samples/order-samples.controller.ts',
    );
    expect(s).toMatch(/@Post\(':orderId\/samples\/start'\)/);
    expect(s).toMatch(/@Get\(':orderId\/samples'\)/);
    expect(s).toMatch(/@Get\(':id'\)/);
    expect(s).toMatch(/@Post\(':id\/approve'\)/);
    expect(s).toMatch(/@Post\(':id\/reject'\)/);
    expect(s).toMatch(/@Post\(':id\/cancel'\)/);
  });
});
