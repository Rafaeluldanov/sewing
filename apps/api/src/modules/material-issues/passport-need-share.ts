import { Prisma } from '@prisma/client';
import type { Logger } from '@nestjs/common';

import { TIRAGE_NEED_WHERE } from '../workshop-needs/workshop-need-scope.js';
import { normalizeColor } from '@sewing/shared/colors';

/**
 * ДОЛЯ ПОТРЕБНОСТИ ЦЕХА НА ОДИН ПАСПОРТ — одна формула для двух потребителей.
 *
 * `issuedQty = WorkshopNeed.calculatedQty × Passport.qtyCut / знаменатель`, где знаменатель —
 * плановое количество ЭТОЙ расцветки (`Σ OrderVariantSize.qtyPlan`) для строк расцветки и весь
 * заказ (`Σ OrderItem.qtyPlan`) для order-level строк и паспортов без расцветки.
 *
 * Потребителей два: автосписание при выдаче кроя (`MaterialIssueService.createAutoCutIssueForPassport`)
 * и очередь списания материала в ERP по выпуску (`ErpConsumptionService`, лестница остатков шаг 5).
 * Формула вынесена сюда именно поэтому: два раза посчитанная «доля на паспорт» разъехалась бы на
 * первой же правке, и тогда цех и ERP говорили бы о расходе одного паспорта разные числа —
 * расхождение, которое не видно ни в одном отчёте, потому что цифра есть в обоих.
 *
 * Отбор потребностей тоже часть формулы: только активный вариант просчёта (`TIRAGE_NEED_WHERE`),
 * без отменённых и без строк заявки клиента, при известной расцветке — её строки + order-level.
 */

/** Поля потребности, нужные обоим потребителям (цена — цеху, идентичность ERP — шву). */
export const PASSPORT_NEED_SELECT = {
  id: true,
  description: true,
  sourceName: true,
  materialRole: true,
  unit: true,
  calculatedQty: true,
  quotedPrice: true,
  quotedCurrency: true,
  orderVariantId: true,
  erpManagedAt: true,
  erpUnitPriceRub: true,
  erpNomenclatureId: true,
  erpCharacteristicId: true,
  erpUnitId: true,
} as const;

export type PassportNeedRow = Prisma.WorkshopNeedGetPayload<{
  select: typeof PASSPORT_NEED_SELECT;
}>;

/** Потребность + посчитанная доля на паспорт (только строки с долей > 0). */
export type PassportNeedShare = { need: PassportNeedRow; qty: Prisma.Decimal };

export type PassportNeedSharesSkip =
  | 'passport_not_found'
  | 'passport_qty_zero'
  | 'total_order_qty_zero'
  | 'no_material_needs';

export type PassportNeedSharesResult =
  | {
      ok: true;
      passport: {
        id: string;
        orderId: string;
        qtyCut: number;
        orderVariantId: string | null;
        color: string;
      };
      /** Расцветка, в разрезе которой считали (прямая связь или выведенная по цвету). */
      variantId: string | null;
      /** Знаменатель заказа: `Σ OrderItem.qtyPlan` (для аудита формулы). */
      totalOrderQty: number;
      /** Знаменатель расцветки: `Σ OrderVariantSize.qtyPlan`, `null` — считали по заказу. */
      variantPlanQty: Prisma.Decimal | null;
      /** Строки с ненулевой долей. Пустой массив = все доли округлились в ноль. */
      shares: PassportNeedShare[];
    }
  | { ok: false; reason: PassportNeedSharesSkip };

/** Описание строки расхода: описание потребности → имя источника → роль материала. */
export function needDescription(need: {
  description?: string | null;
  sourceName?: string | null;
  materialRole?: string | null;
}): string {
  const description = (need.description ?? '').trim();
  if (description.length > 0) return description;
  const sourceName = (need.sourceName ?? '').trim();
  if (sourceName.length > 0) return sourceName;
  return need.materialRole ?? 'Материал';
}

export async function resolvePassportNeedShares(
  tx: Prisma.TransactionClient,
  passportId: string,
  logger?: Logger,
): Promise<PassportNeedSharesResult> {
  const passport = await tx.passport.findUnique({
    where: { id: passportId },
    select: {
      id: true,
      orderId: true,
      qtyCut: true,
      orderVariantId: true,
      color: true,
    },
  });
  if (!passport) return { ok: false, reason: 'passport_not_found' };
  if (passport.qtyCut <= 0) return { ok: false, reason: 'passport_qty_zero' };

  // totalOrderQty = Σ OrderItem.qtyPlan по orderId. Канонический источник, тот же, что
  // используется в `CutReadinessService` и `WorkshopNeedsService`: поля `quantity` в проекте
  // нет, размерная матрица раскладывается через OrderItem.
  const orderItems = await tx.orderItem.findMany({
    where: { orderId: passport.orderId },
    select: { qtyPlan: true },
  });
  const totalOrderQty = orderItems.reduce((acc, it) => acc + (it.qtyPlan ?? 0), 0);
  if (totalOrderQty <= 0) return { ok: false, reason: 'total_order_qty_zero' };

  // Фича «Расцветки»: у паспорта расцветки берём потребности ЭТОЙ расцветки (+ order-level) и
  // делим на её плановое количество. Прямая связь `orderVariantId` — быстрый путь; без неё, если
  // заказ мультирасцветочный, пробуем вывести расцветку по цвету паспорта (спасает
  // несбэкфилленные и ручные паспорта). Неоднозначно — легаси-поведение (весь заказ) + warning.
  let variantId = passport.orderVariantId;
  if (!variantId) {
    const variants = await tx.orderVariant.findMany({
      where: { orderId: passport.orderId },
      select: { id: true, color: true },
    });
    if (variants.length >= 2) {
      const matches = variants.filter((v) => normalizeColor(v.color) === passport.color);
      if (matches.length === 1) {
        variantId = matches[0].id;
      } else {
        logger?.warn(
          `event=passport_need_share.colorway_unresolved passportId=${passportId} ` +
            `orderId=${passport.orderId} color=${passport.color} ` +
            `variants=${variants.length} matches=${matches.length}`,
        );
      }
    }
  }

  let variantQtyDec: Prisma.Decimal | null = null;
  if (variantId) {
    const variantSizes = await tx.orderVariantSize.findMany({
      where: { variantId },
      select: { qtyPlan: true },
    });
    const variantQty = variantSizes.reduce((acc, s) => acc + (s.qtyPlan ?? 0), 0);
    // Нет планового количества расцветки (не должно, но предохраняемся) — общий знаменатель.
    variantQtyDec = variantQty > 0 ? new Prisma.Decimal(variantQty) : null;
  }

  const needs = await tx.workshopNeed.findMany({
    where: {
      orderId: passport.orderId,
      status: { not: 'CANCELLED' },
      sourceType: { not: 'ORDER_APPLICATION' },
      AND: [TIRAGE_NEED_WHERE],
      ...(variantId
        ? { OR: [{ orderVariantId: variantId }, { orderVariantId: null }] }
        : {}),
    },
    select: PASSPORT_NEED_SELECT,
  });
  if (needs.length === 0) return { ok: false, reason: 'no_material_needs' };

  const passportQtyCut = new Prisma.Decimal(passport.qtyCut);
  const totalQtyDec = new Prisma.Decimal(totalOrderQty);
  const shares: PassportNeedShare[] = [];
  for (const need of needs) {
    const denom =
      variantQtyDec != null && need.orderVariantId != null ? variantQtyDec : totalQtyDec;
    // Округление до 4 знаков — precision `MaterialIssueLine.issuedQty` (Decimal(14,4)).
    const qty = need.calculatedQty
      .mul(passportQtyCut)
      .div(denom)
      .toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
    if (qty.lessThanOrEqualTo(0)) continue;
    shares.push({ need, qty });
  }
  return { ok: true, passport, variantId, totalOrderQty, variantPlanQty: variantQtyDec, shares };
}
