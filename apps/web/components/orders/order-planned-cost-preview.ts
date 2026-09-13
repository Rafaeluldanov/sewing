/**
 * Чистая арифметика карточки «Плановая себестоимость»
 * (`./order-planned-cost-summary-card.tsx`): группировка денег по
 * секциям (материалы / фурнитура / нанесение / прочее) из живых
 * `WorkshopNeed` и прочих расходов заказа — ветка «смета ещё не
 * зафиксирована».
 *
 * Вынесена из server component ради unit-теста
 * (`tests/unit/order-planned-cost-preview.test.ts`): сам компонент
 * тянет `lucide-react` и `@/lib/*`, в vitest его не поднять.
 *
 * Аудит движка расчёта 13.09.2026, E1-5: до фиксации сметы карточка
 * считала только `need.quotedPrice` и логистику, а после
 * `completeCalculation` переключалась на смету, в которой бэк
 * (`OrderCostEstimatesService.assembleEstimatePlan`) складывает ещё три
 * слагаемых: цену ERP (`erpUnitPriceRub`, главнее `quotedPrice`), прочие
 * расходы «в себестоимость» (`OrderExtraCost.includeInCostPrice`) и
 * разработку лекала (`Order.patternDevelopmentCostRub` при флаге
 * `patternDevelopmentCostInCostPrice`). Итог «прыгал» без изменения
 * данных. Теперь прикидка зеркалит состав сметы:
 *
 *   - строка потребности: цена = `erpUnitPriceRub` (RUB), если строка
 *     под ERP (`erpManagedAt`) и цена ERP задана; иначе `quotedPrice` в
 *     `quotedCurrency`; количество = `purchaseQty ?? calculatedQty`;
 *   - прочие расходы с `includeInCostPrice` → «Прочее» (USD → warning,
 *     как у строк потребности);
 *   - логистика → «Прочее» (всегда RUB, нули пропускаются);
 *   - разработка лекала → «Прочее», если флаг включён и сумма > 0.
 *
 * Политика давальческого сырья (`materialsAndHardwareCostPolicy`)
 * применяется выше, при сложении итога — как и на бэке, секции
 * MATERIAL/HARDWARE остаются на экране.
 *
 * В БД ничего не пишет; деньги в документах не трогает — это витрина.
 */
import type { OrderExtraCostDto } from '@sewing/shared/order-extra-costs';
import type {
  OrderDetailDto,
  OrderLogisticsLineDto,
} from '@sewing/shared/orders';
import {
  getWorkshopNeedKind,
  type WorkshopNeedKind,
  type WorkshopNeedListItemDto,
} from '@sewing/shared/workshop-needs';

export interface SummaryBuckets {
  materialsRub: number;
  hardwareRub: number;
  applicationRub: number;
  otherRub: number;
  /** Были строки в USD — итог в рублях доступен только после курса. */
  hasUsdLines: boolean;
}

export function emptyBuckets(): SummaryBuckets {
  return {
    materialsRub: 0,
    hardwareRub: 0,
    applicationRub: 0,
    otherRub: 0,
    hasUsdLines: false,
  };
}

export function addToBucket(
  buckets: SummaryBuckets,
  kind: WorkshopNeedKind,
  amountRub: number,
): void {
  if (!Number.isFinite(amountRub)) return;
  switch (kind) {
    case 'MATERIAL':
      buckets.materialsRub += amountRub;
      break;
    case 'HARDWARE':
      buckets.hardwareRub += amountRub;
      break;
    case 'APPLICATION':
      buckets.applicationRub += amountRub;
      break;
    case 'OTHER':
    default:
      buckets.otherRub += amountRub;
      break;
  }
}

export function bucketsAreEmpty(b: SummaryBuckets): boolean {
  return (
    b.materialsRub === 0 &&
    b.hardwareRub === 0 &&
    b.applicationRub === 0 &&
    b.otherRub === 0
  );
}

function parseAmount(raw: string | number | null | undefined): number | null {
  if (raw == null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Считаем суммы по kind из текущих `WorkshopNeed`. До завершения
 * расчёта это «прикидка», поэтому:
 *   - используем `purchaseQty ?? calculatedQty` как финальное
 *     количество (это та же логика, что у backend в
 *     `OrderCostEstimatesService.completeCalculation` — см.
 *     `apps/api/src/modules/orders/order-cost-estimates.service.ts`);
 *   - цена: для строки под ERP (`erpManagedAt`) с заданной
 *     `erpUnitPriceRub` — она, в рублях (E1-5: так считает смета — факт
 *     нашего заказа поставщику главнее плановой цены закупщика цеха);
 *     иначе `quotedPrice` — только для RUB-строк;
 *   - USD-строки помечаем флагом, чтобы UI вывел warning «итог
 *     в рублях будет доступен после ввода курса».
 *
 * Строки с пустой ценой / нулевой ценой / отменённые сознательно
 * пропускаем (нечего класть в итог).
 */
export function bucketsFromWorkshopNeeds(
  needs: WorkshopNeedListItemDto[],
): SummaryBuckets {
  const buckets = emptyBuckets();
  for (const need of needs) {
    if (need.status === 'CANCELLED') continue;

    // Аудит движка расчёта 13.09.2026, E1-5: цена ERP главнее quotedPrice
    // и всегда в рублях — ровно как в `assembleEstimatePlan`.
    const erpPrice =
      need.erpManagedAt && need.erpUnitPriceRub
        ? parseAmount(need.erpUnitPriceRub)
        : null;
    const price = erpPrice ?? parseAmount(need.quotedPrice);
    if (price == null || price <= 0) continue;
    const qtyRaw = need.purchaseQty ?? need.calculatedQty;
    const qty = Number(qtyRaw);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    const total = price * qty;

    const currency = (
      erpPrice != null ? 'RUB' : (need.quotedCurrency ?? 'RUB')
    ) as string;
    if (currency === 'USD') {
      buckets.hasUsdLines = true;
      continue;
    }
    if (currency !== 'RUB') {
      // Чужая валюта (не должна попадать после сужения до
      // MoneyCurrencySchema, но защищаемся): не кладём в итог,
      // но и USD-warning не показываем — это редкий legacy-кейс.
      continue;
    }

    // Роль материала — ГЛАВНЫЙ признак классификации (см.
    // `getWorkshopNeedKind`): по ней фурнитура отделяется от тканей.
    // Без неё молнии и люверсы уезжали в «Материалы» и «Прочее», строка
    // «Фурнитура» показывала ноль, а «материалы за изделие» — завышенное
    // число. Передаём ровно как соседний `resolveMaterialSection`.
    const kind = getWorkshopNeedKind({
      sourceType: need.sourceType,
      calculationMethod: need.calculationMethod,
      materialRole: need.materialRole ?? undefined,
    });
    addToBucket(buckets, kind, total);
  }
  return buckets;
}

/**
 * Прочие / непредвиденные расходы заказа, помеченные «в себестоимость»
 * (аудит движка расчёта 13.09.2026, E1-5). Смета кладёт их позицией
 * «Прочее»; USD — через тот же курс, что и материалы, поэтому до курса
 * только поднимаем флаг.
 */
export function addExtraCostsToBuckets(
  buckets: SummaryBuckets,
  extraCosts: readonly OrderExtraCostDto[],
): void {
  for (const e of extraCosts) {
    if (!e.includeInCostPrice) continue;
    const amount = parseAmount(e.amount);
    if (amount == null || amount <= 0) continue;
    if ((e.currency ?? 'RUB').toUpperCase() === 'USD') {
      buckets.hasUsdLines = true;
      continue;
    }
    addToBucket(buckets, 'OTHER', amount);
  }
}

/**
 * Ручные строки логистики («Добавить поле» в таблице «Операции»)
 * потребностью цеха не являются, но в себестоимость входят — backend
 * заводит их в смету позицией «Прочее». Всегда в рублях; нулевые
 * («доставка 0 ₽» как напоминание) пропускаем, как и смета.
 */
export function addLogisticsToBuckets(
  buckets: SummaryBuckets,
  logisticsLines: readonly OrderLogisticsLineDto[] | null | undefined,
): void {
  for (const line of logisticsLines ?? []) {
    const cost = parseAmount(line.costRub);
    if (cost != null && cost > 0) {
      addToBucket(buckets, 'OTHER', cost);
    }
  }
}

/**
 * Разработка лекала (аудит движка расчёта 13.09.2026, E1-5): смета
 * добавляет строку «Разработка лекала», если чекбокс «входит в
 * себестоимость» включён (default `true`, см.
 * `Order.patternDevelopmentCostInCostPrice`) и сумма > 0.
 */
export function addPatternDevelopmentToBuckets(
  buckets: SummaryBuckets,
  order: Pick<
    OrderDetailDto,
    'patternDevelopmentCostRub' | 'patternDevelopmentCostInCostPrice'
  >,
): void {
  if (order.patternDevelopmentCostInCostPrice === false) return;
  const cost = parseAmount(order.patternDevelopmentCostRub);
  if (cost != null && cost > 0) {
    addToBucket(buckets, 'OTHER', cost);
  }
}

/**
 * Полная прикидка «до сметы»: потребность + прочие расходы + логистика
 * + разработка лекала — тот же состав, что у
 * `OrderCostEstimatesService.assembleEstimatePlan`, чтобы итог карточки
 * не менялся после «Завершить расчёт» (E1-5).
 */
export function buildPreviewBuckets(args: {
  needs: WorkshopNeedListItemDto[];
  extraCosts: readonly OrderExtraCostDto[];
  order: Pick<
    OrderDetailDto,
    | 'logisticsLines'
    | 'patternDevelopmentCostRub'
    | 'patternDevelopmentCostInCostPrice'
  >;
}): SummaryBuckets {
  const buckets = bucketsFromWorkshopNeeds(args.needs);
  addExtraCostsToBuckets(buckets, args.extraCosts);
  addLogisticsToBuckets(buckets, args.order.logisticsLines);
  addPatternDevelopmentToBuckets(buckets, args.order);
  return buckets;
}
