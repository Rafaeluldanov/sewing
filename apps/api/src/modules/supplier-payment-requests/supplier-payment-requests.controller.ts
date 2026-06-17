import { FilesInterceptor } from '@nestjs/platform-express';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { memoryStorage } from 'multer';
import {
  CreateSupplierPaymentRequestSchema,
  SUPPLIER_PAYMENT_REQUEST_FILE_FIELD,
  SUPPLIER_PAYMENT_REQUEST_FILE_MAX_COUNT,
  SUPPLIER_PAYMENT_REQUEST_FILE_MAX_SIZE_BYTES,
  type SupplierPaymentRequestDetailDto,
  type SupplierPaymentRequestListItemDto,
} from '@sewing/shared/supplier-payment-requests';

import { SupplierPaymentRequestFileInvalidException } from '../../common/errors.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import type { UploadedFileLike } from '../patterns/patterns-storage.service.js';
import { SupplierPaymentRequestsService } from './supplier-payment-requests.service.js';

/**
 * Заявки на оплату поставщику (см.
 * `prisma/schema.prisma::SupplierPaymentRequest`).
 *
 *   GET  /api/purchase-orders/:purchaseOrderId/payment-requests — список
 *        заявок по заказу поставщику;
 *   POST /api/purchase-orders/:purchaseOrderId/payment-requests — создать
 *        заявку (multipart: `payload` JSON + `files[]` вложения);
 *   GET  /api/supplier-payment-requests/:id — детальная карточка заявки.
 *
 * Без класс-префикса: первые два маршрута живут под `/purchase-orders`,
 * третий — под `/supplier-payment-requests`. Коллизии с
 * `PurchaseOrdersController` нет (его `:id` короче нашего
 * `:purchaseOrderId/payment-requests`).
 *
 * RBAC — `ADMIN`/`SHOP_MANAGER` (как у закупочного контура).
 */
@Controller()
@Roles('ADMIN', 'SHOP_MANAGER')
export class SupplierPaymentRequestsController {
  constructor(private readonly requests: SupplierPaymentRequestsService) {}

  @Get('purchase-orders/:purchaseOrderId/payment-requests')
  listForPurchaseOrder(
    @Param('purchaseOrderId') purchaseOrderId: string,
  ): Promise<SupplierPaymentRequestListItemDto[]> {
    return this.requests.listForPurchaseOrder(purchaseOrderId);
  }

  @Get('supplier-payment-requests/:id')
  get(@Param('id') id: string): Promise<SupplierPaymentRequestDetailDto> {
    return this.requests.get(id);
  }

  /**
   * Создать заявку на оплату по заказу поставщику.
   *
   * Запрос `multipart/form-data`:
   *   - `payload` (string) — JSON `CreateSupplierPaymentRequestDto`
   *     (сумма, реквизиты, этапы);
   *   - `files` (file[]) — счёт/инвойс и доп. документы (0..N, любой
   *     формат, лимит по размеру; см. shared-константы).
   *
   * Multipart выбран по тем же причинам, что в `ConstructorTasksController`:
   * не base64-кодировать файлы в JSON.
   */
  @Post('purchase-orders/:purchaseOrderId/payment-requests')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    FilesInterceptor(
      SUPPLIER_PAYMENT_REQUEST_FILE_FIELD,
      SUPPLIER_PAYMENT_REQUEST_FILE_MAX_COUNT,
      {
        storage: memoryStorage(),
        limits: { fileSize: SUPPLIER_PAYMENT_REQUEST_FILE_MAX_SIZE_BYTES },
      },
    ),
  )
  async create(
    @Param('purchaseOrderId') purchaseOrderId: string,
    @Body('payload') payloadRaw: string | undefined,
    @UploadedFiles() files: UploadedFileLike[] | undefined,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<SupplierPaymentRequestDetailDto> {
    if (typeof payloadRaw !== 'string' || payloadRaw.trim() === '') {
      throw new SupplierPaymentRequestFileInvalidException(
        'Поле payload обязательно — передайте JSON с суммой и этапами.',
      );
    }
    let payloadJson: unknown;
    try {
      payloadJson = JSON.parse(payloadRaw);
    } catch {
      throw new SupplierPaymentRequestFileInvalidException(
        'Поле payload содержит невалидный JSON.',
      );
    }
    const parsed = CreateSupplierPaymentRequestSchema.safeParse(payloadJson);
    if (!parsed.success) {
      throw new SupplierPaymentRequestFileInvalidException(
        parsed.error.issues
          .map((i) => i.message)
          .filter(Boolean)
          .join('; ') || 'Невалидный payload.',
      );
    }
    return this.requests.create(
      purchaseOrderId,
      parsed.data,
      Array.isArray(files) ? files : [],
      user.employeeId ?? null,
    );
  }
}
