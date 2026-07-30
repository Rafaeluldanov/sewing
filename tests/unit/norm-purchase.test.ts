/**
 * Юнит-тесты пересчёта «норма расхода → количество к закупке»
 * (`packages/shared/src/norm-purchase.ts`).
 *
 * Что здесь по-настоящему важно:
 *   1. ОБРАТНАЯ СОВМЕСТИМОСТЬ. Строка без расщепления обязана считаться ровно
 *      как раньше — норма × тираж, без всяких пересчётов. Таких строк в базе
 *      подавляющее большинство, и любое расхождение здесь тихо поехало бы в
 *      сметы и на склад.
 *   2. ФОРМУЛА совпадает с расчётом потребности. Спецификация и закупка обязаны
 *      называть одно и то же число: ради этого всё и затевалось.
 *   3. ОТКАЗ, А НЕ НОЛЬ. Нет ширины или плотности — честно говорим, что
 *      пересчёт невозможен. Ноль читался бы как «материал не нужен».
 */
import { describe, expect, test } from 'vitest';

import {
  computeNormPurchase,
  needsPurchaseConversion,
} from '@sewing/shared/norm-purchase';

/** Боевая кулирка заказа O-20260617-0001: 195 г/м², рулон 185 см. */
const KULIRKA = {
  normPerUnit: 0.8232,
  normUnit: 'м пог.',
  qty: 1000,
  purchaseUnit: 'кг',
  widthCm: 185,
  densityGsm: 195,
};

describe('needsPurchaseConversion', () => {
  test('единица нормы не задана — расщепления нет', () => {
    expect(needsPurchaseConversion(null, 'кг')).toBe(false);
    expect(needsPurchaseConversion('', 'кг')).toBe(false);
  });

  test('единицы совпали (с точностью до написания) — пересчитывать нечего', () => {
    expect(needsPurchaseConversion('м пог.', 'м')).toBe(false);
    expect(needsPurchaseConversion('кг', 'кг')).toBe(false);
  });

  test('единицы разошлись — нужен пересчёт', () => {
    expect(needsPurchaseConversion('м пог.', 'кг')).toBe(true);
    expect(needsPurchaseConversion('м пог.', 'м²')).toBe(true);
  });
});

describe('computeNormPurchase', () => {
  test('ГЛАВНОЕ: без расщепления считается как раньше — норма × тираж', () => {
    const r = computeNormPurchase({
      normPerUnit: 1.4,
      normUnit: null,
      qty: 100,
      purchaseUnit: 'кг',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.totalNorm).toBe(140);
    expect(r.purchaseQty).toBe(140);
  });

  test('боевой случай: 0.8232 м пог. × 1000 при 185 см и 195 г/м² → 296.97 кг', () => {
    const r = computeNormPurchase(KULIRKA);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.totalNorm).toBe(823.2);
    expect(r.areaM2).toBe(1522.92);
    expect(r.purchaseQty).toBe(296.9694);
    expect(r.formula).toContain('185 см');
  });

  test('пересчёт в м² — только через ширину, плотность не нужна', () => {
    const r = computeNormPurchase({
      ...KULIRKA,
      purchaseUnit: 'м²',
      densityGsm: null,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.purchaseQty).toBe(1522.92);
  });

  test('нет ширины — отказ, а НЕ ноль', () => {
    const r = computeNormPurchase({ ...KULIRKA, widthCm: null });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problem).toBe('NO_WIDTH');
    // Расход от ширины не зависит и обязан вернуться в любом случае.
    expect(r.totalNorm).toBe(823.2);
  });

  test('нет плотности — отказ на шаге «кг», площадь тут уже не спасает', () => {
    const r = computeNormPurchase({ ...KULIRKA, densityGsm: 0 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problem).toBe('NO_DENSITY');
  });

  test('норма не в метрах — из веса длину не выводим', () => {
    const r = computeNormPurchase({ ...KULIRKA, normUnit: 'кг', purchaseUnit: 'м пог.' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problem).toBe('NORM_NOT_LINEAR');
  });

  test('закупка в штуках из метров не выводится', () => {
    const r = computeNormPurchase({ ...KULIRKA, purchaseUnit: 'шт' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problem).toBe('UNSUPPORTED_UNIT');
  });

  test('совпадение формулы с расчётом потребности на боевом заказе', () => {
    // O-20260721-0001: 1000 шт, кашкорсе 0.03 м пог., рулон 166 см, 220 г/м².
    // WorkshopNeed по тому же параметру даёт 10.956 кг.
    const r = computeNormPurchase({
      normPerUnit: 0.03,
      normUnit: 'м пог.',
      qty: 1000,
      purchaseUnit: 'кг',
      widthCm: 166,
      densityGsm: 220,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.purchaseQty).toBe(10.956);
  });
});
