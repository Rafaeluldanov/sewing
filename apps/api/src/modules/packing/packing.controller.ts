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
  type AddPassportToBoxDto,
  type CloseBoxDto,
  type CreateBoxDto,
  type ListBoxesQuery,
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
   */
  @Public()
  @Get(':id/label')
  @Header('content-type', 'text/html; charset=utf-8')
  async label(@Param('id') id: string): Promise<string> {
    const box = await this.packing.getOne(id);
    const qrDataUrl = await QRCode.toDataURL(`box:${id}`, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 280,
    });
    const summary = box.summary
      ? `${box.summary.productName} · ${box.summary.color} · ${box.summary.sizeCode}`
      : '—';
    return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"/>
<title>Этикетка ${box.number}</title>
<style>
  body { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; padding: 24px; color: #0f172a; }
  .label { width: 360px; border: 1px solid #cbd5e1; border-radius: 12px; padding: 16px; }
  .label__num { font-size: 22px; font-weight: 700; margin-bottom: 6px; }
  .label__row { font-size: 14px; margin-bottom: 4px; color: #334155; }
  .label__row strong { color: #0f172a; }
  .label__qr { margin-top: 12px; text-align: center; }
  .label__qr img { width: 220px; height: 220px; }
  .label__caption { font-size: 12px; color: #64748b; text-align: center; margin-top: 4px; word-break: break-all; }
  @media print { @page { size: 80mm 120mm; margin: 4mm; } body { padding: 0; } }
</style>
</head><body>
<div class="label">
  <div class="label__num">${escapeHtml(box.number)}</div>
  <div class="label__row"><strong>Содержимое:</strong> ${escapeHtml(summary)}</div>
  <div class="label__row"><strong>Кол-во:</strong> ${box.totalQty} / ${box.maxQty}</div>
  <div class="label__row"><strong>Статус:</strong> ${box.status === 'CLOSED' ? 'закрыта' : 'открыта'}</div>
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
