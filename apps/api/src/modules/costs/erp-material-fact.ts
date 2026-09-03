import { Prisma } from '@prisma/client';

import type { PrismaService } from '../../prisma/prisma.service.js';

/**
 * ФАКТ МАТЕРИАЛА ИЗ ERP в себестоимости цеха (лестница остатков, шаг 6).
 *
 * Материал, купленный и хранимый в ERP, списывается ЕЮ по факту выпуска — с конкретного рулона и
 * по цене его партии (правило владельца §0.3, `service/docs/kb/sewing.md`). Результат приезжает
 * сюда (`ErpMaterialConsumption` + строки) и становится фактом расхода: своего движения по складу
 * и своего документа расхода у таких материалов в цехе нет.
 *
 * Поэтому себестоимость складывается из ДВУХ источников, которые не пересекаются:
 *   • свои материалы цеха — `MaterialIssue` (нетто возвратов), как и раньше;
 *   • материалы под ERP — этот факт.
 * Непересечение держится тем, что автосписание при выдаче кроя строк под ERP больше не создаёт
 * (`material-issues.service.ts::createAutoCutIssueForPassport`). Если однажды начнёт — суммы
 * задвоятся, и это будет видно только сверкой с ERP.
 *
 * Учитывается ТОЛЬКО `POSTED`: `REVERSED` (списание сторнировано в ERP), `EMPTY` и `FAILED` —
 * не расход. Сумма — та, что ERP реально списала с партий, а не план закупщика.
 */
export const ERP_CONSUMPTION_POSTED = 'POSTED';

/** Σ списаний ERP по паспортам, ₽. Ключ — `passportId`; паспорта без факта в карту не попадают. */
export async function erpMaterialCostByPassport(
  prisma: PrismaService,
  passportIds: string[],
): Promise<Map<string, Prisma.Decimal>> {
  const out = new Map<string, Prisma.Decimal>();
  if (passportIds.length === 0) return out;
  const rows = await prisma.erpMaterialConsumption.findMany({
    where: { passportId: { in: passportIds }, state: ERP_CONSUMPTION_POSTED },
    select: { passportId: true, amountRub: true },
  });
  for (const r of rows) {
    if (r.amountRub == null) continue;
    const prev = out.get(r.passportId) ?? new Prisma.Decimal(0);
    out.set(r.passportId, prev.add(r.amountRub));
  }
  return out;
}

/** Факт по одному паспорту, ₽ (0, если ERP по нему ничего не списывала). */
export async function erpMaterialCostForPassport(
  prisma: PrismaService,
  passportId: string,
): Promise<Prisma.Decimal> {
  const map = await erpMaterialCostByPassport(prisma, [passportId]);
  return map.get(passportId) ?? new Prisma.Decimal(0);
}

/** Строка факта по потребности: сколько и на какую сумму списала ERP, с разрезом по паспорту. */
export type ErpNeedFact = {
  workshopNeedId: string;
  description: string;
  unit: string | null;
  qty: Prisma.Decimal;
  rub: Prisma.Decimal;
  /** Разрез «размер · цвет» для план→факта: берётся с паспорта, по которому шло списание. */
  breakdown: Array<{
    sizeCode: string | null;
    color: string | null;
    qty: Prisma.Decimal;
    rub: Prisma.Decimal;
  }>;
};

/** Факт материала ERP по заказу цеха, сгруппированный по потребности. */
export async function erpMaterialFactByNeed(
  prisma: PrismaService,
  orderId: string,
): Promise<Map<string, ErpNeedFact>> {
  const lines = await prisma.erpMaterialConsumptionLine.findMany({
    where: {
      workshopNeedId: { not: null },
      consumption: { orderId, state: ERP_CONSUMPTION_POSTED },
    },
    select: {
      workshopNeedId: true,
      description: true,
      unit: true,
      qty: true,
      amountRub: true,
      consumption: {
        select: {
          passport: {
            select: { color: true, size: { select: { code: true } } },
          },
        },
      },
    },
  });
  const out = new Map<string, ErpNeedFact>();
  for (const l of lines) {
    const needId = l.workshopNeedId;
    if (!needId) continue;
    const acc = out.get(needId) ?? {
      workshopNeedId: needId,
      description: l.description,
      unit: l.unit,
      qty: new Prisma.Decimal(0),
      rub: new Prisma.Decimal(0),
      breakdown: [],
    };
    acc.qty = acc.qty.add(l.qty);
    acc.rub = acc.rub.add(l.amountRub);
    const sizeCode = l.consumption.passport?.size?.code ?? null;
    const color = l.consumption.passport?.color ?? null;
    const found = acc.breakdown.find(
      (b) => b.sizeCode === sizeCode && b.color === color,
    );
    if (found) {
      found.qty = found.qty.add(l.qty);
      found.rub = found.rub.add(l.amountRub);
    } else {
      acc.breakdown.push({
        sizeCode,
        color,
        qty: new Prisma.Decimal(l.qty),
        rub: new Prisma.Decimal(l.amountRub),
      });
    }
    out.set(needId, acc);
  }
  return out;
}
