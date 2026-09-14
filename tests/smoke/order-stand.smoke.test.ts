/**
 * Smoke-щит «Схемы стенда» по заказу (14.09.2026) — `/admin/orders/[id]/stand`,
 * `GET /api/orders/:id/stand`, `@sewing/shared/order-stand`.
 *
 * React-рендера в vitest нет (см. `frontend-rbac.smoke.test.ts`), поэтому
 * фиксируем инварианты по исходникам:
 *
 *   1. Стадии паспортов схема считает ТОЙ ЖЕ `bucketOf`, что и монитор
 *      цеха — иначе «сшито 12» на схеме и на `/shopfloor/display`
 *      разъедутся. Свою копию `bucketOf` сервис не заводит.
 *   2. QR на странице — только через `QrCodeView`, payload'ы приходят с
 *      backend в штатных форматах ADR-0008 (`equipment:`, `cell:`,
 *      `passport:`, `box:`); клиент их не собирает сам.
 *   3. Клиентская доска не тянет server-only модули (`next/headers`
 *      через `lib/api.ts` / `lib/orders-api.ts`) — иначе страница
 *      падает 500 на сборке клиентского бандла.
 *   4. Кнопка «Схема стенда» стоит у номера заказа в шапке карточки и
 *      ведёт на `/admin/orders/:id/stand`.
 *   5. Клиентский `getApiBaseUrl()` на чужом хосте (тенант ≠ хост из
 *      `NEXT_PUBLIC_API_URL`) уходит в same-origin `/api` — иначе на
 *      любом тенанте кроме дефолтного поллинг получал бы 401.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { ORDER_STAND_PLACES, ORDER_STAND_PLACE_LABELS } from '../../packages/shared/src/order-stand';

const ROOT = path.resolve(__dirname, '../..');
const readSrc = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

const SERVICE = 'apps/api/src/modules/shopfloor/order-stand.service.ts';
const BOARD = 'apps/web/app/admin/orders/[id]/stand/order-stand-board.tsx';
const PAGE = 'apps/web/app/admin/orders/[id]/stand/page.tsx';
const HEADER = 'apps/web/components/orders/view/order-management-header.tsx';

describe('схема стенда — контракт', () => {
  test('у каждого места паспорта есть подпись', () => {
    for (const p of ORDER_STAND_PLACES) {
      expect(ORDER_STAND_PLACE_LABELS[p]).toBeTruthy();
    }
  });

  test('shared-модуль экспортируется пакетом и индексом', () => {
    const pkg = JSON.parse(readSrc('packages/shared/package.json'));
    expect(pkg.exports['./order-stand']).toBe('./src/order-stand.ts');
    expect(readSrc('packages/shared/src/index.ts')).toMatch(/export \* from '\.\/order-stand'/);
  });
});

describe('схема стенда — backend', () => {
  test('стадии считает bucketOf монитора, а не своя копия', () => {
    const src = readSrc(SERVICE);
    expect(src).toMatch(/import \{ bucketOf[^}]*\} from '\.\/shopfloor-projection\.js'/);
    expect(src).not.toMatch(/function bucketOf/);
    expect(src).toMatch(/bucketOf\(\{/);
  });

  test('QR-payload — штатные форматы ADR-0008 из БД / по id', () => {
    const src = readSrc(SERVICE);
    expect(src).toMatch(/qrPayload: `equipment:\$\{e\.id\}`/);
    expect(src).toMatch(/qrPayload: p\.qrCode/);
    expect(src).toMatch(/qrPayload: c\.qrCode/);
    expect(src).toMatch(/qrPayload: b\.qrCode/);
  });

  test('готовность к крою — из CutReadinessService, fail-soft', () => {
    const src = readSrc(SERVICE);
    expect(src).toMatch(/this\.cutReadiness\.getForOrder\(order\.id\)/);
    expect(src).toMatch(/order-stand\.readiness\.failed/);
    const mod = readSrc('apps/api/src/modules/shopfloor/shopfloor.module.ts');
    expect(mod).toMatch(/imports: \[CutReadinessModule\]/);
    expect(mod).toMatch(/OrderStandController/);
    expect(mod).toMatch(/OrderStandService/);
  });

  test('ручка живёт под /api/orders/:id/stand', () => {
    const ctl = readSrc('apps/api/src/modules/shopfloor/order-stand.controller.ts');
    expect(ctl).toMatch(/@Controller\('orders'\)/);
    expect(ctl).toMatch(/@Get\(':id\/stand'\)/);
  });
});

describe('схема стенда — frontend', () => {
  test('доска — client component, QR только через QrCodeView', () => {
    const src = readSrc(BOARD);
    expect(src.startsWith("'use client';")).toBe(true);
    expect(src).toMatch(/import \{ QrCodeView \} from '@\/components\/qr\/qr-code-view'/);
    expect(src).not.toMatch(/from 'qrcode\.react'/);
    // payload не собирается на клиенте
    expect(src).not.toMatch(/`equipment:\$\{/);
    expect(src).not.toMatch(/`passport:\$\{/);
    expect(src).not.toMatch(/`cell:\$\{/);
  });

  test('клиентская доска не тянет server-only модули', () => {
    const src = readSrc(BOARD);
    expect(src).not.toMatch(/from '@\/lib\/api'/);
    expect(src).not.toMatch(/from '@\/lib\/orders-api'/);
    expect(src).not.toMatch(/from '@\/lib\/order-stand-api'/);
    expect(src).not.toMatch(/from 'next\/headers'/);
    expect(src).toMatch(/from '@\/lib\/api-base'/);
  });

  test('поллинг раз в 5 с с паузой на скрытой вкладке', () => {
    const src = readSrc(BOARD);
    expect(src).toMatch(/const POLL_MS = 5000/);
    expect(src).toMatch(/visibilitychange/);
    expect(src).toMatch(/credentials: 'include'/);
  });

  test('перекладина = маршрут без CUTTING/PACKING, раскрой и упаковка — свои блоки', () => {
    const src = readSrc(BOARD);
    expect(src).toMatch(/s\.category !== 'PACKING' && s\.category !== 'CUTTING'/);
    expect(src).toMatch(/s\.category === 'CUTTING'/);
    expect(src).toMatch(/--ostand-cols/);
  });

  test('страница под /admin — серверный первый кадр + notFound на 404', () => {
    const src = readSrc(PAGE);
    expect(src).toMatch(/getOrderStand\(params\.id\)/);
    expect(src).toMatch(/statusCode === 404\) notFound\(\)/);
    expect(src).toMatch(/<OrderStandBoard orderId=\{params\.id\} initial=\{initial\} \/>/);
  });

  test('кнопка «Схема стенда» — у номера заказа в шапке карточки', () => {
    const src = readSrc(HEADER);
    expect(src).toMatch(/href=\{`\/admin\/orders\/\$\{order\.id\}\/stand`\}/);
    expect(src).toMatch(/Схема стенда/);
    expect(src).toMatch(/order-hero-card__stand-link/);
  });

  test('стили страницы объявлены в globals.css', () => {
    const css = readSrc('apps/web/app/globals.css');
    for (const cls of ['.ostand__board', '.ostand-blk', '.ostand-core', '.ostand-cell', '.ostand-prow', '.ostand-trail', '.order-hero-card__title-row']) {
      expect(css).toContain(cls);
    }
  });
});

describe('клиентский API base — мультитенантность', () => {
  test('чужой хост → same-origin /api', () => {
    const src = readSrc('apps/web/lib/api-base.ts');
    expect(src).toMatch(/isSameHost\(configured, window\.location\)/);
    expect(src).toMatch(/return '\/api';/);
  });
});
