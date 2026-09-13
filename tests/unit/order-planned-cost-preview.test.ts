/**
 * Юнит-тесты прикидки карточки «Плановая себестоимость» до фиксации
 * сметы (`apps/web/components/orders/order-planned-cost-preview.ts`).
 *
 * Аудит движка расчёта 13.09.2026, E1-5 (medium): в ветке
 * `workshopNeeds` карточка считала только `need.quotedPrice` и
 * логистику, а смета (`OrderCostEstimatesService.assembleEstimatePlan`)
 * кладёт ещё цену ERP (главнее `quotedPrice`), прочие расходы «в
 * себестоимость» и разработку лекала — итог «прыгал» после «Завершить
 * расчёт» без изменения данных. Сценарий аудита: материалы 100 000 ₽,
 * прочий расход 15 000 ₽, лекало 20 000 ₽, строка под ERP без
 * `quotedPrice` с `erpUnitPriceRub` 450 × 100 м → 180 000 ₽ до и после.
 */
import { describe, expect, test } from 'vitest';

import type { OrderExtraCostDto } from '@sewing/shared/order-extra-costs';
import type { WorkshopNeedListItemDto } from '@sewing/shared/workshop-needs';

import {
  addExtraCostsToBuckets,
  addPatternDevelopmentToBuckets,
  bucketsFromWorkshopNeeds,
  buildPreviewBuckets,
  emptyBuckets,
} from '../../apps/web/components/orders/order-planned-cost-preview';

/** Минимальная строка потребности: только поля, которые читает прикидка. */
function need(
  over: Partial<WorkshopNeedListItemDto>,
): WorkshopNeedListItemDto {
  return {
    id: 'n',
    status: 'CALCULATED',
    sourceType: 'ORDER_MATERIAL_REQUIREMENT',
    calculationMethod: 'LINEAR_M_BY_SIZE',
    materialRole: 'MAIN',
    calculatedQty: '100',
    purchaseQty: null,
    quotedPrice: null,
    quotedCurrency: null,
    erpManagedAt: null,
    erpUnitPriceRub: null,
    ...over,
  } as unknown as WorkshopNeedListItemDto;
}

function extraCost(over: Partial<OrderExtraCostDto>): OrderExtraCostDto {
  return {
    id: 'x',
    orderId: 'o',
    description: 'Аутсорс вышивки',
    amount: '15000',
    currency: 'RUB',
    includeInCostPrice: true,
    createdAtStatus: 'CALCULATION',
    comment: null,
    createdById: null,
    createdByName: null,
    createdAt: '2026-09-13T00:00:00.000Z',
    updatedAt: '2026-09-13T00:00:00.000Z',
    ...over,
  };
}

describe('order-planned-cost-preview — E1-5: цена ERP главнее quotedPrice', () => {
  test('строка под ERP без quotedPrice считается по erpUnitPriceRub в рублях', () => {
    const b = bucketsFromWorkshopNeeds([
      need({
        erpManagedAt: '2026-09-13T00:00:00.000Z',
        erpUnitPriceRub: '450',
        calculatedQty: '100',
      }),
    ]);
    expect(b.materialsRub).toBe(45_000);
    expect(b.hasUsdLines).toBe(false);
  });

  test('цена ERP главнее quotedPrice, даже если закупщик ввёл свою в USD', () => {
    const b = bucketsFromWorkshopNeeds([
      need({
        erpManagedAt: '2026-09-13T00:00:00.000Z',
        erpUnitPriceRub: '450',
        quotedPrice: '9',
        quotedCurrency: 'USD',
        calculatedQty: '100',
      }),
    ]);
    expect(b.materialsRub).toBe(45_000);
    // Валюта ERP-цены — рубли: USD-warning не поднимается.
    expect(b.hasUsdLines).toBe(false);
  });

  test('erpUnitPriceRub без erpManagedAt не используется (как в смете)', () => {
    const b = bucketsFromWorkshopNeeds([
      need({ erpUnitPriceRub: '450', quotedPrice: null }),
    ]);
    expect(b.materialsRub).toBe(0);
  });

  test('обычная строка: purchaseQty ?? calculatedQty × quotedPrice, USD → флаг', () => {
    const b = bucketsFromWorkshopNeeds([
      need({ quotedPrice: '1000', quotedCurrency: 'RUB', purchaseQty: '100' }),
      need({
        id: 'usd',
        quotedPrice: '5',
        quotedCurrency: 'USD',
        calculatedQty: '10',
      }),
      need({ id: 'cancelled', status: 'CANCELLED', quotedPrice: '1' }),
      need({
        id: 'hw',
        materialRole: 'PACKAGING',
        quotedPrice: '2',
        quotedCurrency: 'RUB',
        calculatedQty: '500',
      }),
    ]);
    expect(b.materialsRub).toBe(100_000);
    expect(b.hardwareRub).toBe(1_000);
    expect(b.hasUsdLines).toBe(true);
  });
});

describe('order-planned-cost-preview — E1-5: прочие расходы и лекало в «Прочее»', () => {
  test('прочий расход с includeInCostPrice → OTHER; без флага — нет', () => {
    const b = emptyBuckets();
    addExtraCostsToBuckets(b, [
      extraCost({ amount: '15000' }),
      extraCost({ id: 'off', amount: '999', includeInCostPrice: false }),
    ]);
    expect(b.otherRub).toBe(15_000);
  });

  test('прочий расход в USD только поднимает флаг курса', () => {
    const b = emptyBuckets();
    addExtraCostsToBuckets(b, [extraCost({ amount: '100', currency: 'USD' })]);
    expect(b.otherRub).toBe(0);
    expect(b.hasUsdLines).toBe(true);
  });

  test('разработка лекала входит при флаге (undefined = true, как default на бэке)', () => {
    const on = emptyBuckets();
    addPatternDevelopmentToBuckets(on, {
      patternDevelopmentCostRub: '20000',
      patternDevelopmentCostInCostPrice: true,
    });
    expect(on.otherRub).toBe(20_000);

    const dflt = emptyBuckets();
    addPatternDevelopmentToBuckets(dflt, {
      patternDevelopmentCostRub: '20000',
    });
    expect(dflt.otherRub).toBe(20_000);

    const off = emptyBuckets();
    addPatternDevelopmentToBuckets(off, {
      patternDevelopmentCostRub: '20000',
      patternDevelopmentCostInCostPrice: false,
    });
    expect(off.otherRub).toBe(0);

    const zero = emptyBuckets();
    addPatternDevelopmentToBuckets(zero, {
      patternDevelopmentCostRub: '0',
      patternDevelopmentCostInCostPrice: true,
    });
    expect(zero.otherRub).toBe(0);
  });
});

describe('order-planned-cost-preview — E1-5: сценарий аудита, итог до и после сметы один', () => {
  test('100 000 материалы + 45 000 ERP + 15 000 прочее + 20 000 лекало = 180 000', () => {
    const b = buildPreviewBuckets({
      needs: [
        need({
          id: 'fabric',
          quotedPrice: '1000',
          quotedCurrency: 'RUB',
          purchaseQty: '100',
        }),
        need({
          id: 'erp',
          erpManagedAt: '2026-09-13T00:00:00.000Z',
          erpUnitPriceRub: '450',
          calculatedQty: '100',
        }),
      ],
      extraCosts: [extraCost({ amount: '15000' })],
      order: {
        logisticsLines: [],
        patternDevelopmentCostRub: '20000',
        patternDevelopmentCostInCostPrice: true,
      },
    });
    expect(b.materialsRub).toBe(145_000);
    expect(b.otherRub).toBe(35_000);
    expect(b.hasUsdLines).toBe(false);
    const total =
      b.materialsRub + b.hardwareRub + b.applicationRub + b.otherRub;
    expect(total).toBe(180_000);
  });

  test('логистика по-прежнему в «Прочее», нулевые строки пропускаются', () => {
    const b = buildPreviewBuckets({
      needs: [],
      extraCosts: [],
      order: {
        logisticsLines: [
          {
            id: 'l1',
            sortOrder: 0,
            name: 'Доставка',
            status: null,
            statusLabel: null,
            deliveryDeadline: null,
            costRub: '3500',
            createdAt: '',
            updatedAt: '',
          },
          {
            id: 'l2',
            sortOrder: 1,
            name: 'Напоминание',
            status: null,
            statusLabel: null,
            deliveryDeadline: null,
            costRub: '0',
            createdAt: '',
            updatedAt: '',
          },
        ],
        patternDevelopmentCostRub: null,
        patternDevelopmentCostInCostPrice: true,
      },
    });
    expect(b.otherRub).toBe(3_500);
  });
});
