/**
 * Smoke-тесты «Автосохранение строк потребности цеха + дефолты закупщика»
 * (`apps/web/app/admin/workshop-needs/autosave.tsx`,
 * `apps/web/app/admin/workshop-needs/inline-edit-row.tsx`,
 * `apps/web/app/admin/workshop-needs/complete-calculation-form.tsx`,
 * `apps/web/app/admin/workshop-needs/page.tsx`,
 * `apps/web/app/admin/workshop-needs/[id]/edit-form.tsx`).
 *
 * Жалоба владельца 14.09.2026: введённое в строки на `/admin/workshop-needs`
 * пропадало — строка сохранялась только по галочке ✓, а «Завершить
 * расчёт» по несохранённым строкам отвечал «заполните данные по строке».
 * Плюс два дефолта: «К закупке» = расчёт («Нужно»), валюта = RUB.
 *
 * Покрытие:
 *   1. провайдер автосохранения: реестр строк, счётчик «в полёте»,
 *      `flushAll` (дождаться сохранений);
 *   2. строка: сохраняется по blur/change полей, если снимок формы
 *      отличается от последнего отправленного; ✓ остаётся; ошибка не
 *      сбрасывает поля (controlled), успех — зелёная галочка, а не плашка;
 *   3. «Завершить расчёт» перед отправкой зовёт `flushAll`;
 *   4. страница оборачивает список провайдером (выше карточек, где живут и
 *      строки, и кнопка «Завершить расчёт»);
 *   5. дефолты в строке и в полной карточке: «К закупке» предзаполнено
 *      расчётом (и для ниток, и для упаковок кнопок), валюта — RUB, опции
 *      «пустая валюта» нет.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function read(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

const AUTOSAVE = 'apps/web/app/admin/workshop-needs/autosave.tsx';
const INLINE = 'apps/web/app/admin/workshop-needs/inline-edit-row.tsx';
const COMPLETE =
  'apps/web/app/admin/workshop-needs/complete-calculation-form.tsx';
const PAGE = 'apps/web/app/admin/workshop-needs/page.tsx';
const DETAIL_FORM =
  'apps/web/app/admin/workshop-needs/[id]/edit-form.tsx';
const CSS = 'apps/web/app/globals.css';

describe('Workshop needs — провайдер автосохранения', () => {
  test('autosave.tsx существует и экспортирует провайдер + хук', () => {
    expect(existsSync(path.join(repoRoot, AUTOSAVE))).toBe(true);
    const src = read(AUTOSAVE);
    expect(src).toMatch(/^'use client';/u);
    expect(src).toMatch(/export function WorkshopNeedAutosaveProvider/);
    expect(src).toMatch(/export function useWorkshopNeedAutosave/);
  });

  test('провайдер ведёт реестр строк и счётчик «в полёте» в ref-ах', () => {
    const src = read(AUTOSAVE);
    expect(src).toMatch(/register\(id, flush\)/);
    expect(src).toMatch(/begin\(\)\s*\{\s*pending\.current \+= 1/);
    expect(src).toMatch(/end\(\)\s*\{\s*pending\.current = Math\.max\(0, pending\.current - 1\)/);
    // Реестр и счётчик — ref-ы, не state: flushAll должен видеть begin()
    // синхронно с requestSubmit строки.
    expect(src).toMatch(/const pending = useRef\(0\)/);
    expect(src).toMatch(/const rows = useRef\(new Map/);
  });

  test('flushAll дёргает flush всех строк, ждёт пустой счётчик и ограничен по времени', () => {
    const src = read(AUTOSAVE);
    expect(src).toMatch(/flushAll\(\)\s*\{\s*for \(const flush of rows\.current\.values\(\)\) flush\(\);/);
    expect(src).toMatch(/waiters\.current\.push\(finish\)/);
    expect(src).toMatch(/const FLUSH_MAX_WAIT_MS = \d+/);
    expect(src).toMatch(/setTimeout\(finish, FLUSH_MAX_WAIT_MS\)/);
  });
});

describe('Workshop needs — строка сохраняется сама', () => {
  test('строка оборачивает server-action счётчиком провайдера', () => {
    const src = read(INLINE);
    expect(src).toMatch(/useWorkshopNeedAutosave\(\)/);
    expect(src).toMatch(/autosave\?\.begin\(\);[\s\S]*?updateWorkshopNeedAction\(need\.id, prev, formData\)[\s\S]*?autosave\?\.end\(\);/);
  });

  test('автосохранение — только при изменении снимка полей формы', () => {
    const src = read(INLINE);
    expect(src).toMatch(/function formSignature\(form: HTMLFormElement\)/);
    expect(src).toMatch(/const lastSavedSigRef = useRef<string \| null>\(null\)/);
    expect(src).toMatch(/if \(sig === lastSavedSigRef\.current\) return;\s*form\.requestSubmit\(\);/);
    // Снимок фиксируется на любом submit (✓ / Enter / автосохранение).
    expect(src).toMatch(/onSubmit=\{\(e\) => \{[\s\S]*?lastSavedSigRef\.current = formSignature\(e\.currentTarget\)/);
    // Снимок считается по полям DTO, а не по всему <form> (bulk-чекбокс PO).
    expect(src).toMatch(/const AUTOSAVE_FIELDS = \[[\s\S]*?'purchaseQty',[\s\S]*?'quotedPrice',[\s\S]*?'quotedCurrency',[\s\S]*?'status',[\s\S]*?'comment',[\s\S]*?\] as const/);
  });

  test('поля ввода дёргают автосохранение по blur (текст/дата) и change (селекты)', () => {
    const src = read(INLINE);
    expect(src).toMatch(/name=\{isThread \? undefined : 'purchaseQty'\}[\s\S]*?onBlur=\{deferAutosave\}/);
    expect(src).toMatch(/name=\{isThread \|\| packMode \? undefined : 'quotedPrice'\}[\s\S]*?onBlur=\{deferAutosave\}/);
    expect(src).toMatch(/name="quotedCurrency"[\s\S]*?onChange=\{\(e\) => \{\s*setCurrency\(e\.target\.value\);\s*deferAutosave\(\);/);
    expect(src).toMatch(/name="supplierNameText"[\s\S]*?onBlur=\{deferAutosave\}/);
    expect(src).toMatch(/name="selectedSupplierId"[\s\S]*?onValueChange=\{deferAutosave\}/);
    // Дата — по blur, не по change (промежуточные валидные даты при наборе).
    expect(src).toMatch(/name="expectedDeliveryDate"[\s\S]*?type="date"[\s\S]*?onBlur=\{deferAutosave\}/);
    expect(src).not.toMatch(/name="expectedDeliveryDate"[\s\S]{0,400}?onChange=\{deferAutosave\}/);
    expect(src).toMatch(/name="status"[\s\S]*?onChange=\{deferAutosave\}/);
    expect(src).toMatch(/name="comment"[\s\S]*?onBlur=\{deferAutosave\}/);
  });

  test('строка регистрирует flush в провайдере', () => {
    const src = read(INLINE);
    expect(src).toMatch(/autosave\.register\(need\.id, \(\) => flushRef\.current\(\)\)/);
  });

  test('✓ остаётся; успех — зелёная галочка, а не плашка на всю ширину', () => {
    const src = read(INLINE);
    expect(src).toMatch(/ZoneSaveButton saved=\{savedFlash\}/);
    expect(src).toMatch(/wn-save--saved/);
    expect(src).toMatch(/const SAVED_FLASH_MS = \d+/);
    expect(src).not.toMatch(/className="success-box wn-zrow__alert"/);
    // Ошибка по-прежнему показывается в строке (поля не сбрасываются).
    expect(src).toMatch(/className="error-box wn-zrow__alert"/);
    expect(read(CSS)).toMatch(/\.wn-zone__body--log \.wn-save--saved/);
  });
});

describe('Workshop needs — «Завершить расчёт» ждёт строки', () => {
  test('форма перед отправкой зовёт flushAll и блокирует кнопку', () => {
    const src = read(COMPLETE);
    expect(src).toMatch(/useWorkshopNeedAutosave\(\)/);
    expect(src).toMatch(/e\.preventDefault\(\);\s*setFlushing\(true\);\s*void autosave\.flushAll\(\)/);
    expect(src).toMatch(/formRef\.current\?\.requestSubmit\(\)/);
    expect(src).toMatch(/Сохраняем строки…/);
    expect(src).toMatch(/disabled=\{pending \|\| flushing \|\| disabled\}/);
  });

  test('страница оборачивает список провайдером выше карточек', () => {
    const src = read(PAGE);
    expect(src).toMatch(/import \{ WorkshopNeedAutosaveProvider \} from '\.\/autosave'/);
    expect(src).toMatch(/<WorkshopNeedAutosaveProvider>\s*<CollapseProvider>/);
    expect(src).toMatch(/<\/CollapseProvider>\s*<\/WorkshopNeedAutosaveProvider>/);
  });
});

describe('Workshop needs — дефолты закупщика', () => {
  test('строка: «К закупке» предзаполнено расчётом, пока в БД пусто', () => {
    const src = read(INLINE);
    expect(src).toMatch(/const purchaseQtyIsDefault = need\.purchaseQty == null/);
    expect(src).toMatch(/const effectivePurchaseQty = need\.purchaseQty \?\? need\.calculatedQty/);
    expect(src).toMatch(/metersToYards\(effectivePurchaseQty\)/);
    expect(src).toMatch(/trimDecimal\(effectivePurchaseQty\)/);
    // Нитки: нетронутое поле уходит точным значением (расчёт, если пусто).
    expect(src).toMatch(/purchaseQtyValue === initialPurchaseDisplay\s*\?\s*effectivePurchaseQty/);
    // Упаковки кнопок: нетронутые «Упаковок» при пустом purchaseQty уходят расчётом.
    expect(src).toMatch(/piecesToPackages\(effectivePurchaseQty, need\.packSize\)/);
    expect(src).toMatch(/packQtyFromForm \?\? \(purchaseQtyIsDefault \? need\.calculatedQty : null\)/);
  });

  test('строка: валюта по умолчанию RUB, опции «—» нет', () => {
    const src = read(INLINE);
    expect(src).toMatch(/\?\s*initialCurrency\s*:\s*'RUB'/);
    expect(src).not.toMatch(/<option value="">—<\/option>/);
    expect(src).toMatch(/<select[^>]*name="quotedCurrency"[\s\S]*?MONEY_CURRENCIES\.map/);
  });

  test('полная карточка: те же дефолты', () => {
    const src = read(DETAIL_FORM);
    expect(src).toMatch(/const purchaseQtyIsDefault = need\.purchaseQty == null/);
    expect(src).toMatch(/const effectivePurchaseQty = need\.purchaseQty \?\? need\.calculatedQty/);
    expect(src).toMatch(/defaultValue=\{isThread \? undefined : initialPurchaseDisplay\}/);
    expect(src).toMatch(/packQtyFromForm \?\? \(purchaseQtyIsDefault \? need\.calculatedQty : null\)/);
    expect(src).toMatch(/name="quotedCurrency"[\s\S]*?defaultValue=\{[\s\S]*?: 'RUB'/);
    expect(src).not.toMatch(/— не выбрана —/);
  });
});
