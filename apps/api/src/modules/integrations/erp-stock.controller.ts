import { Body, Controller, Get, Put } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { MachineScopes } from '../auth/auth.decorators.js';

/**
 * Приёмник снимка остатка швейного склада, ведомого в ERP upgifts.
 *
 * ⛔ ТЁМНЫЙ ШАГ. Данные складываются в `ErpShopStock`, и на сегодня их НЕ ЧИТАЕТ
 * ни один рабочий путь: готовность кроя (`cut-readiness.service.ts`) считает
 * `placedQty` по собственной приёмке цеха. Переключение — отдельным шагом и
 * только вместе со старым путём, иначе в день переключения `placedQty` станет
 * нулём и крой физически встанет.
 *
 * Почему PUT-снимок, а не поштучные события: у остатка нет своей истории, у него
 * есть текущее значение. Снимок самовосстанавливается — пропущенная доставка
 * лечится следующей, тогда как потерянное событие «+5 м» расходится навсегда.
 *
 * Почему пишет ERP, а не цех спрашивает: недоступность ERP не должна
 * останавливать цех. Со снимком у цеха всегда есть последнее известное
 * состояние и видно, насколько оно устарело.
 */
@Controller('integrations/erp-stock')
@MachineScopes('stock:read')
export class ErpStockController {
  constructor(private readonly prisma: PrismaService) {}

  /** Что цех знает об остатке ERP и насколько это свежо. */
  @Get()
  async read() {
    const rows = await this.prisma.erpShopStock.findMany({
      orderBy: [{ erpProductName: 'asc' }, { rollNumber: 'asc' }],
    });
    const syncedAt = rows.reduce<Date | null>(
      (max, r) => (max === null || r.syncedAt > max ? r.syncedAt : max),
      null,
    );
    return { syncedAt, count: rows.length, items: rows };
  }

  /**
   * Принять снимок целиком. Замена, а не слияние: строка, которой в снимке нет,
   * означает «остатка больше нет» — при слиянии она осталась бы висеть вечно.
   */
  @MachineScopes('stock:write')
  @Put()
  @MachineScopes('stock:write')
  async replace(@Body() body: { items?: ErpStockLine[] }) {
    const items = Array.isArray(body?.items) ? body.items : [];
    const now = new Date();
    const rows = items
      .filter((i) => i && i.nomenclature_id)
      .map((i) => ({
        erpProductId: String(i.nomenclature_id),
        erpProductCode: i.nomenclature_code ?? null,
        erpProductName: i.nomenclature_name ?? '',
        erpCharacteristicId: i.characteristic_id ?? null,
        erpSeriesId: i.series_id ?? null,
        rollNumber: i.roll_number ?? null,
        shade: i.shade == null ? null : String(i.shade),
        widthCm: i.width_cm == null ? null : String(i.width_cm),
        densityGsm: i.density_gsm == null ? null : String(i.density_gsm),
        qty: i.qty ?? '0',
        unit: i.unit ?? i.unit_code ?? null,
        bins: (i.bins ?? []) as object,
        syncedAt: now,
      }));

    // Одной транзакцией: между «снесли» и «залили» читатель не должен увидеть
    // пустой склад. Читателей сегодня нет, но появятся — и тогда уже поздно.
    await this.prisma.$transaction([
      this.prisma.erpShopStock.deleteMany({}),
      this.prisma.erpShopStock.createMany({ data: rows }),
    ]);
    return { accepted: rows.length, syncedAt: now };
  }
}

/** Строка снимка в терминах ERP — переименовывать её здесь нельзя, это её контракт. */
type ErpStockLine = {
  nomenclature_id: string;
  nomenclature_code?: string | null;
  nomenclature_name?: string | null;
  characteristic_id?: string | null;
  series_id?: string | null;
  roll_number?: string | null;
  shade?: string | number | null;
  width_cm?: string | number | null;
  density_gsm?: string | number | null;
  qty?: string | null;
  unit?: string | null;
  unit_code?: string | null;
  bins?: unknown;
};
