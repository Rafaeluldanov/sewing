import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  CreateSupplierCatalogItemSchema,
  CreateSupplierContactSchema,
  CreateSupplierSchema,
  ListSupplierCatalogQuerySchema,
  ListSuppliersQuerySchema,
  UpdateSupplierCatalogItemSchema,
  UpdateSupplierContactSchema,
  UpdateSupplierSchema,
  type CreateSupplierCatalogItemDto,
  type CreateSupplierContactDto,
  type CreateSupplierDto,
  type ListSupplierCatalogQuery,
  type ListSuppliersQuery,
  type UpdateSupplierCatalogItemDto,
  type UpdateSupplierContactDto,
  type UpdateSupplierDto,
} from '@sewing/shared/suppliers';
import {
  BulkArchiveRequestSchema,
  type BulkArchiveRequestDto,
  type BulkArchiveResultDto,
} from '@sewing/shared/archive';

import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { SuppliersService } from './suppliers.service.js';

/**
 * Контроллер блока «Поставщики» (Этап 5).
 *
 * Endpoints:
 *   GET    /api/suppliers
 *   GET    /api/suppliers/:id
 *   POST   /api/suppliers
 *   PATCH  /api/suppliers/:id
 *   DELETE /api/suppliers/:id    (физическое удаление; блок при наличии PO)
 *
 *   POST   /api/suppliers/:id/contacts
 *   PATCH  /api/suppliers/:id/contacts/:contactId
 *   DELETE /api/suppliers/:id/contacts/:contactId
 *
 *   GET    /api/suppliers/:id/catalog
 *   POST   /api/suppliers/:id/catalog
 *   PATCH  /api/suppliers/:id/catalog/:itemId
 *   DELETE /api/suppliers/:id/catalog/:itemId    (soft-archive: status = INACTIVE)
 *
 * RBAC — `ADMIN` / `SHOP_MANAGER` (новые роли сознательно не вводим).
 *
 * Поставщика можно либо архивировать (`PATCH status = INACTIVE`), либо
 * удалить физически (`DELETE`). Удаление блокируется, если на карточку
 * выписаны заказы поставщику (`PurchaseOrder`, `onDelete: Restrict`).
 */
@Controller('suppliers')
@Roles('ADMIN', 'SHOP_MANAGER')
export class SuppliersController {
  constructor(private readonly suppliers: SuppliersService) {}

  // ---------------------------------------------------------------------------
  // Suppliers
  // ---------------------------------------------------------------------------

  @Get()
  list(
    @Query(new ZodValidationPipe(ListSuppliersQuerySchema))
    query: ListSuppliersQuery,
  ) {
    return this.suppliers.list(query);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.suppliers.get(id);
  }

  @Post()
  create(
    @Body(new ZodValidationPipe(CreateSupplierSchema))
    body: CreateSupplierDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.suppliers.create(body, user.employeeId);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateSupplierSchema))
    body: UpdateSupplierDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.suppliers.update(id, body, user.employeeId);
  }

  /**
   * Физическое удаление поставщика. Блокируется 409-кой
   * (`SUPPLIER_HAS_PURCHASE_ORDERS`), если на него выписаны заказы
   * поставщику — тогда карточку нужно архивировать (`status = INACTIVE`).
   * Контакты и каталог уходят каскадом.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<void> {
    await this.suppliers.delete(id, user.employeeId);
  }

  // ---------------------------------------------------------------------------
  // Contacts
  // ---------------------------------------------------------------------------

  /**
   * Массовые операции архива со списка `/admin/suppliers` (контракт —
   * `@sewing/shared/archive`): `status = INACTIVE` → обратно → удалить
   * навсегда (только из архива и только если нет заказов поставщикам).
   */
  @Post('archive')
  archiveMany(
    @Body(new ZodValidationPipe(BulkArchiveRequestSchema))
    dto: BulkArchiveRequestDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<BulkArchiveResultDto> {
    return this.suppliers.archiveMany(dto.ids, user.employeeId);
  }

  @Post('restore')
  restoreMany(
    @Body(new ZodValidationPipe(BulkArchiveRequestSchema))
    dto: BulkArchiveRequestDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<BulkArchiveResultDto> {
    return this.suppliers.restoreMany(dto.ids, user.employeeId);
  }

  @Post('purge')
  purgeMany(
    @Body(new ZodValidationPipe(BulkArchiveRequestSchema))
    dto: BulkArchiveRequestDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<BulkArchiveResultDto> {
    return this.suppliers.purgeMany(dto.ids, user.employeeId);
  }

  @Post(':id/contacts')
  createContact(
    @Param('id') supplierId: string,
    @Body(new ZodValidationPipe(CreateSupplierContactSchema))
    body: CreateSupplierContactDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.suppliers.createContact(supplierId, body, user.employeeId);
  }

  @Patch(':id/contacts/:contactId')
  updateContact(
    @Param('id') supplierId: string,
    @Param('contactId') contactId: string,
    @Body(new ZodValidationPipe(UpdateSupplierContactSchema))
    body: UpdateSupplierContactDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.suppliers.updateContact(
      supplierId,
      contactId,
      body,
      user.employeeId,
    );
  }

  @Delete(':id/contacts/:contactId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteContact(
    @Param('id') supplierId: string,
    @Param('contactId') contactId: string,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<void> {
    await this.suppliers.deleteContact(supplierId, contactId, user.employeeId);
  }

  // ---------------------------------------------------------------------------
  // Catalog
  // ---------------------------------------------------------------------------

  @Get(':id/catalog')
  listCatalog(
    @Param('id') supplierId: string,
    @Query(new ZodValidationPipe(ListSupplierCatalogQuerySchema))
    query: ListSupplierCatalogQuery,
  ) {
    return this.suppliers.listCatalog(supplierId, query);
  }

  @Post(':id/catalog')
  createCatalogItem(
    @Param('id') supplierId: string,
    @Body(new ZodValidationPipe(CreateSupplierCatalogItemSchema))
    body: CreateSupplierCatalogItemDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.suppliers.createCatalogItem(supplierId, body, user.employeeId);
  }

  @Patch(':id/catalog/:itemId')
  updateCatalogItem(
    @Param('id') supplierId: string,
    @Param('itemId') itemId: string,
    @Body(new ZodValidationPipe(UpdateSupplierCatalogItemSchema))
    body: UpdateSupplierCatalogItemDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.suppliers.updateCatalogItem(
      supplierId,
      itemId,
      body,
      user.employeeId,
    );
  }

  /**
   * Soft-archive — переводим позицию в `status = INACTIVE`. Физического
   * удаления НЕТ: уже выбранные позиции в `WorkshopNeed` должны
   * сохранять историю (см. `SuppliersService.archiveCatalogItem`).
   */
  @Delete(':id/catalog/:itemId')
  archiveCatalogItem(
    @Param('id') supplierId: string,
    @Param('itemId') itemId: string,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.suppliers.archiveCatalogItem(
      supplierId,
      itemId,
      user.employeeId,
    );
  }
}
