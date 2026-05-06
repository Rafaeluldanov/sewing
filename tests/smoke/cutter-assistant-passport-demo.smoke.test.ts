/**
 * Smoke-тесты на демо-режим серийного выпуска паспортов помощником
 * раскройщика (`/orders/:id/passports/new-demo`).
 *
 * UX по ТЗ:
 *   1. Из `/work` есть отдельная кнопка «Выпустить паспорт (демо)»
 *      рядом с обычной — она ведёт на `/work/cut-orders?mode=demo`.
 *   2. `/work/cut-orders` при `mode=demo` маршрутизирует и
 *      авто-редирект, и карточки списка на `/passports/new-demo`
 *      (а не на `/passports/new`).
 *   3. На странице первым стоит выбор размера (по умолчанию XS,
 *      fallback — первый по `sizeSortOrder`); затем поле «Количество
 *      рулонов» и кнопка «Создать сетку»; затем таблица «Рулон 1..N»
 *      с количеством и итогом по размеру; внизу — «Выпустить паспорта».
 *   4. Если рулонов 0 → «Нельзя создавать сетку без указания
 *      количества рулонов».
 *   5. Если пользователь сменил размер при уже созданной сетке —
 *      сетка пересоздаётся автоматически с тем же количеством рулонов.
 *   6. Server action в цикле дёргает существующий `POST /api/passports`
 *      (новых endpoint-ов не заводим).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('CUTTER_ASSISTANT — кнопка «Выпустить паспорт (демо)» на /work', () => {
  const panelPath = 'apps/web/app/work/active-shift-panel.tsx';

  test('файл active-shift-panel.tsx существует', () => {
    expect(existsSync(path.join(repoRoot, panelPath))).toBe(true);
  });

  test('CutterAssistantWorkPanel содержит вторую кнопку «Выпустить паспорт (демо)»', () => {
    const src = readSrc(panelPath);
    // Обычная кнопка
    expect(src).toMatch(/href="\/work\/cut-orders"/);
    // Демо-кнопка
    expect(src).toMatch(/href="\/work\/cut-orders\?mode=demo"/);
    expect(src).toMatch(/Выпустить паспорт \(демо\)/);
  });
});

describe('/work/cut-orders — учитывает searchParams.mode=demo', () => {
  const pagePath = 'apps/web/app/work/cut-orders/page.tsx';

  test('страница принимает searchParams и отрешает на new-demo', () => {
    const src = readSrc(pagePath);
    expect(src).toMatch(/searchParams\??:\s*\{\s*mode\?:\s*string\s*\}/);
    expect(src).toMatch(/searchParams\?\.mode\s*===\s*'demo'/);
    // newPassportPath = isDemo ? 'new-demo' : 'new'
    expect(src).toMatch(/'new-demo'/);
    // Используется в обоих местах: авто-редирект (один заказ) и карточки.
    const usages = src.match(/passports\/\$\{newPassportPath\}/g) ?? [];
    expect(usages.length).toBeGreaterThanOrEqual(2);
  });

  test('заголовок переключается в «Выберите заказ (демо)» при mode=demo', () => {
    const src = readSrc(pagePath);
    expect(src).toMatch(/Выберите заказ \(демо\)/);
  });
});

describe('/orders/[id]/passports/new-demo/page.tsx — серверная страница', () => {
  const pagePath =
    'apps/web/app/orders/[id]/passports/new-demo/page.tsx';

  test('страница существует', () => {
    expect(existsSync(path.join(repoRoot, pagePath))).toBe(true);
  });

  test('грузит заказ, паспорта, размеры и активных раскройщиков', () => {
    const src = readSrc(pagePath);
    expect(src).toMatch(/from '@\/lib\/orders-api'/);
    expect(src).toMatch(/from '@\/lib\/passports-api'/);
    expect(src).toMatch(/from '@\/lib\/employees-api'/);
    expect(src).toMatch(/getOrder\(/);
    expect(src).toMatch(/listOrderPassports\(/);
    // Узкий `/api/employees/cutters` (RBAC: CUTTER_ASSISTANT, SHOP_MANAGER,
    // ADMIN). Широкий `listEmployees` для CUTTER_ASSISTANT даёт 403 —
    // именно так и сделана обычная форма выпуска паспорта.
    expect(src).toMatch(/listActiveCutters\(/);
    expect(src).not.toMatch(/listEmployees\(/);
  });

  test('передаёт today/disabled/sizes в клиентскую форму', () => {
    const src = readSrc(pagePath);
    expect(src).toMatch(/NewPassportDemoForm/);
    expect(src).toMatch(/today=\{today\}/);
    expect(src).toMatch(/disabled=\{blocked\}/);
    expect(src).toMatch(/sizes=\{sizeOptions\}/);
    // Блокировка по статусу заказа сохраняется (как в `new/page.tsx`).
    expect(src).toMatch(/order\.status\s*!==\s*'IN_PRODUCTION'/);
  });
});

describe('NewPassportDemoForm — UX размер/рулоны/сетка', () => {
  const formPath =
    'apps/web/app/orders/[id]/passports/new-demo/new-passport-demo-form.tsx';

  test('файл клиентской формы существует и помечен use client', () => {
    expect(existsSync(path.join(repoRoot, formPath))).toBe(true);
    const src = readSrc(formPath);
    expect(src).toMatch(/^'use client';/);
  });

  test('по умолчанию выбран XS (с fallback на первый по sortOrder)', () => {
    const src = readSrc(formPath);
    // Хелпер `pickDefaultSize` ищет код XS и иначе берёт первый.
    expect(src).toMatch(/pickDefaultSize/);
    expect(src).toMatch(/sizeCode\.trim\(\)\.toUpperCase\(\)\s*===\s*'XS'/);
  });

  test('первым блоком идёт выбор размера, потом поле «Количество рулонов»', () => {
    const src = readSrc(formPath);
    const sizeIdx = src.indexOf('id="demo-sizeId-label"');
    const rollsIdx = src.indexOf('htmlFor="rollsCount"');
    expect(sizeIdx).toBeGreaterThan(0);
    expect(rollsIdx).toBeGreaterThan(0);
    expect(sizeIdx).toBeLessThan(rollsIdx);
  });

  test('кнопка «Создать сетку» проверяет, что rollsCount > 0', () => {
    const src = readSrc(formPath);
    expect(src).toMatch(/Создать сетку/);
    expect(src).toMatch(
      /Нельзя создавать сетку без указания количества рулонов/,
    );
    // handleCreateGrid снапшотит rollsCount → gridSize и инициализирует
    // массив количеств нулями.
    expect(src).toMatch(/setGridSize\(/);
    expect(src).toMatch(/setQuantities\(new Array\(\s*n\s*\)\.fill\(0\)\)/);
  });

  test('сетка пересоздаётся автоматически при смене размера', () => {
    const src = readSrc(formPath);
    // useEffect зависит от sizeId и при существующей сетке (gridSize > 0)
    // переинициализирует quantities длиной gridSize.
    expect(src).toMatch(/useEffect\(/);
    expect(src).toMatch(/if \(gridSize > 0\)/);
    expect(src).toMatch(/}, \[sizeId\]\);/);
  });

  test('таблица с строками «Рулон N» и итогом по размеру внизу', () => {
    const src = readSrc(formPath);
    expect(src).toMatch(/Рулон \{idx \+ 1\}/);
    expect(src).toMatch(/Итого по размеру/);
    // Сумма по quantities считается явно.
    expect(src).toMatch(/quantities\.reduce/);
  });

  test('форма шлёт скрытые cutDate и quantities (JSON) в server action', () => {
    const src = readSrc(formPath);
    expect(src).toMatch(/type="hidden"\s+name="cutDate"/);
    expect(src).toMatch(/type="hidden"\s+name="quantities"/);
    expect(src).toMatch(/JSON\.stringify\(quantities\)/);
  });

  test('кнопка submit подписана «Выпустить паспорта» и блокируется без сетки/итога', () => {
    const src = readSrc(formPath);
    expect(src).toMatch(/Выпустить паспорта/);
    // Disable: либо страница заблокирована, либо сетка ещё не создана,
    // либо итого = 0.
    expect(src).toMatch(/disabled=\{disabled \|\| gridSize === 0 \|\| total <= 0\}/);
  });
});

describe('actions.ts — batch создание паспортов через существующий API', () => {
  const actionsPath =
    'apps/web/app/orders/[id]/passports/new-demo/actions.ts';

  test('файл server action существует', () => {
    expect(existsSync(path.join(repoRoot, actionsPath))).toBe(true);
  });

  test('createPassportDemoBatchAction в цикле дёргает createPassport', () => {
    const src = readSrc(actionsPath);
    expect(src).toMatch(/^'use server';/);
    expect(src).toMatch(/export async function createPassportDemoBatchAction/);
    // Не заводим новых endpoint-ов: используем существующий хелпер.
    expect(src).toMatch(/from '@\/lib\/passports-api'/);
    expect(src).toMatch(/await createPassport\(/);
    // Цикл по элементам сетки.
    expect(src).toMatch(/for \(let i = 0; i < quantities\.length;/);
    // Тело паспорта валидируется shared-схемой.
    expect(src).toMatch(/CreatePassportSchema\.safeParse/);
  });

  test('пропускает рулоны с qty <= 0 и собирает счётчики created/failed', () => {
    const src = readSrc(actionsPath);
    expect(src).toMatch(/if \(!Number\.isFinite\(qty\) \|\| qty <= 0\) continue;/);
    expect(src).toMatch(/created\+\+/);
    expect(src).toMatch(/failed\+\+/);
    // Если ни одного не создано — единый error; иначе success с
    // разбивкой.
    expect(src).toMatch(/if \(created === 0\)/);
  });

  test('rollNumber генерится автоматически как «Демо-Р{n}-…»', () => {
    const src = readSrc(actionsPath);
    expect(src).toMatch(/rollNumber:\s*`Демо-Р\$\{i \+ 1\}-\$\{ts\}`/);
  });

  test('revalidatePath пересчитывает страницы заказа и списка', () => {
    const src = readSrc(actionsPath);
    expect(src).toMatch(/revalidatePath\(`\/orders\/\$\{orderId\}`\)/);
    expect(src).toMatch(/revalidatePath\('\/orders'\)/);
  });
});
