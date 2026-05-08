import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  AddPassportToBoxSchema,
  CloseBoxSchema,
  CreateBoxSchema,
  ListBoxesQuerySchema,
  PlaceBoxSchema,
  type AddPassportToBoxDto,
  type CloseBoxDto,
  type CreateBoxDto,
  type ListBoxesQuery,
  type PlaceBoxDto,
} from '@sewing/shared/packing';
import * as QRCode from 'qrcode';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { PackingService } from './packing.service.js';
import { CurrentUser, Public, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';

/**
 * REST-контроллер упаковки. Контракты `docs/api.md §9`.
 *
 * RBAC. Раздел /packing — рабочее место упаковщика. Согласно матрице
 * ролей доступ к чтению и мутациям имеют только:
 *   - `PACKING` — основная роль раздела;
 *   - `SHOP_MANAGER` — обзор и управление;
 *   - `ADMIN` — глобальный доступ через `RolesGuard`.
 *
 * Печать этикетки и QR (`@Public()`) остаются доступны без сессии,
 * потому что используются с принтер-станции (см. ADR-0010).
 *
 * Дополнительно: все мутирующие маршруты на сервисном слое требуют у
 * текущего пользователя активной смены на операции категории `PACKING`.
 */
@Controller('packing/boxes')
@Roles('PACKING', 'SHOP_MANAGER')
export class PackingController {
  constructor(private readonly packing: PackingService) {}

  @Post()
  create(
    @Body(new ZodValidationPipe(CreateBoxSchema)) dto: CreateBoxDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.packing.create(dto, user.employeeId);
  }

  @Get()
  list(
    @Query(new ZodValidationPipe(ListBoxesQuerySchema)) query: ListBoxesQuery,
  ) {
    return this.packing.list(query);
  }

  @Get(':id')
  getOne(@Param('id') id: string) {
    return this.packing.getOne(id);
  }

  @Post(':id/add-passport')
  addPassport(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(AddPassportToBoxSchema))
    dto: AddPassportToBoxDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.packing.addPassport(id, dto, user.employeeId);
  }

  @Post(':id/close')
  close(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(CloseBoxSchema)) _dto: CloseBoxDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.packing.close(id, user.employeeId);
  }

  /**
   * Размещение закрытой коробки в ячейку склада. Принимает либо
   * `cellId` напрямую, либо `code` (QR `cell:<id>`/`Cell.qrCode`/`Cell.code`).
   * После успеха коробка пропадает из списка «ждут размещения» в
   * терминале упаковщика.
   */
  @Post(':id/place')
  place(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(PlaceBoxSchema)) dto: PlaceBoxDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.packing.place(id, dto, user.employeeId);
  }

  // Note: контроллерный @Roles не применяется к маршрутам с @Public()
  // ниже — `AuthGuard` коротко-замыкается на public ещё до проверки ролей.
  // Это нужно, чтобы `/qr` и `/label` оставались доступны принтер-станции
  // без сессии (см. ADR-0010, ADR-0008).

  /**
   * PNG QR-кода коробки в формате `box:{id}` (ADR-0008). Доступен без
   * сессии — этикетку могут печатать с принтер-станции.
   */
  @Public()
  @Get(':id/qr')
  async qr(@Param('id') id: string, @Res() res: Response): Promise<void> {
    await this.packing.getOne(id);
    const buf = await QRCode.toBuffer(`box:${id}`, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 320,
      type: 'png',
    });
    res
      .status(200)
      .setHeader('content-type', 'image/png')
      .setHeader('cache-control', 'public, max-age=300')
      .send(buf);
  }

  /**
   * Минимальная HTML-этикетка коробки (см. ADR-0010): печатаем через
   * браузер, без отдельного PDF-движка. Полноценный PDF — за рамками MVP.
   * Доступна без сессии (см. `/qr`).
   *
   * Состав (ТЗ упаковочного терминала):
   *   - крупный номер коробки + статус;
   *   - изделие / цвет / **размер** (размер выведен крупно — это
   *     то, что упаковщик ищет глазом на складе);
   *   - **количество** (`totalQty`) — основной параметр коробки;
   *   - **список паспортов** — что именно лежит внутри (номер + qty +
   *     заказ), чтобы при возврате/инвентаризации не вскрывать коробку;
   *   - QR `box:{id}` для скан-driven flow.
   */
  @Public()
  @Get(':id/label')
  @Header('content-type', 'text/html; charset=utf-8')
  async label(@Param('id') id: string): Promise<string> {
    const box = await this.packing.getOne(id);
    const qrDataUrl = await QRCode.toDataURL(`box:${id}`, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 240,
    });
    const productLine = box.summary
      ? `${box.summary.productName} · ${box.summary.color}`
      : '—';
    const sizeText = box.summary?.sizeCode ?? '—';
    const itemsRows = box.items.length
      ? box.items
          .map(
            (it) => `<tr>
      <td class="t-num">${escapeHtml(it.passportNumber)}</td>
      <td class="t-qty">${it.qty} шт.</td>
      <td class="t-order">${escapeHtml(it.orderNumber)}</td>
    </tr>`,
          )
          .join('')
      : `<tr><td colspan="3" class="t-empty">—</td></tr>`;
    return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"/>
<title>Этикетка ${escapeHtml(box.number)}</title>
<style>
  body { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; padding: 24px; color: #0f172a; }
  .label { width: 360px; border: 1px solid #cbd5e1; border-radius: 12px; padding: 16px; }
  .label__head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
  .label__num { font-size: 22px; font-weight: 700; }
  .label__status { font-size: 12px; padding: 2px 8px; border-radius: 999px; background: #ecfdf5; color: #047857; }
  .label__status--open { background: #fff7ed; color: #9a3412; }
  .label__row { font-size: 14px; margin-bottom: 4px; color: #334155; }
  .label__row strong { color: #0f172a; }
  .label__big { display: flex; gap: 12px; margin: 8px 0; }
  .label__big-cell { flex: 1; border: 1px solid #e2e8f0; border-radius: 8px; padding: 8px 10px; text-align: center; }
  .label__big-cell-label { font-size: 11px; color: #64748b; text-transform: uppercase; letter-spacing: 0.04em; }
  .label__big-cell-value { font-size: 26px; font-weight: 700; line-height: 1.1; margin-top: 2px; }
  .label__items { margin-top: 8px; }
  .label__items-title { font-size: 12px; color: #64748b; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 4px; }
  .label__items table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .label__items td { padding: 3px 4px; border-top: 1px dashed #e2e8f0; vertical-align: top; }
  .label__items tr:first-child td { border-top: none; }
  .label__items .t-num { font-weight: 600; }
  .label__items .t-qty { text-align: right; white-space: nowrap; color: #334155; }
  .label__items .t-order { text-align: right; color: #64748b; white-space: nowrap; }
  .label__items .t-empty { text-align: center; color: #94a3b8; font-style: italic; }
  .label__qr { margin-top: 10px; text-align: center; }
  .label__qr img { width: 200px; height: 200px; }
  .label__caption { font-size: 12px; color: #64748b; text-align: center; margin-top: 4px; word-break: break-all; }
  @media print { @page { size: 80mm 140mm; margin: 4mm; } body { padding: 0; } .label { border: none; padding: 0; width: auto; } }
</style>
</head><body>
<div class="label">
  <div class="label__head">
    <span class="label__num">${escapeHtml(box.number)}</span>
    <span class="label__status${box.status === 'CLOSED' ? '' : ' label__status--open'}">${box.status === 'CLOSED' ? 'закрыта' : 'открыта'}</span>
  </div>
  <div class="label__row"><strong>Изделие:</strong> ${escapeHtml(productLine)}</div>
  <div class="label__big">
    <div class="label__big-cell">
      <div class="label__big-cell-label">Размер</div>
      <div class="label__big-cell-value">${escapeHtml(sizeText)}</div>
    </div>
    <div class="label__big-cell">
      <div class="label__big-cell-label">Кол-во</div>
      <div class="label__big-cell-value">${box.totalQty}</div>
    </div>
  </div>
  <div class="label__items">
    <div class="label__items-title">Паспорта (${box.items.length})</div>
    <table>${itemsRows}</table>
  </div>
  <div class="label__qr"><img src="${qrDataUrl}" alt="QR ${escapeHtml(box.number)}"/></div>
  <div class="label__caption">${escapeHtml(box.qrCode)}</div>
</div>
</body></html>`;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
