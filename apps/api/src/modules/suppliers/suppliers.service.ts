import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  CreateSupplierContactDto,
  CreateSupplierCatalogItemDto,
  CreateSupplierDto,
  ListSupplierCatalogQuery,
  ListSuppliersQuery,
  SupplierCatalogItemDto,
  SupplierContactDto,
  SupplierDetailDto,
  SupplierListItemDto,
  UpdateSupplierContactDto,
  UpdateSupplierCatalogItemDto,
  UpdateSupplierDto,
} from '@sewing/shared/suppliers';

import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import {
  CashFlowItemNotFoundException,
  SupplierCatalogItemNotFoundException,
  SupplierContactNotFoundException,
  SupplierHasPurchaseOrdersException,
  SupplierNotFoundException,
} from '../../common/errors.js';

/**
 * Сервис «Поставщики» — управленческий справочник контрагентов и их
 * закупочной номенклатуры (Этап 5).
 *
 * Дизайн:
 *   - физического удаления `Supplier` нет: «убрать» = PATCH
 *     `status = INACTIVE`. Уже выбранные `WorkshopNeed.selectedSupplierId`
 *     остаются связанными — UI просто помечает их «Неактивен».
 *   - `SupplierContact` можно удалять физически: контакт менеджера
 *     не упоминается в других модулях, его удаление безопасно.
 *   - `SupplierCatalogItem.delete` = soft-archive (status = INACTIVE),
 *     чтобы уже выбранные позиции не «терялись» в `WorkshopNeed`.
 *   - Аудит — события `SUPPLIER_*` через `AuditService`. `entityType =
 *     SUPPLIER`, для контактов и каталога `entityId = Supplier.id` +
 *     `payload.contactId`/`payload.itemId` (см.
 *     `audit.service.ts::AuditEntityType`).
 *
 * Этот модуль НЕ создаёт PurchaseOrder, НЕ ведёт приёмку и НЕ
 * связывается со складскими ячейками — это сознательная граница MVP
 * (см. ТЗ Этапа 5).
 */
@Injectable()
export class SuppliersService {
  private readonly logger = new Logger(SuppliersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ===========================================================================
  // Suppliers — list / get / create / update
  // ===========================================================================

  async list(query: ListSuppliersQuery): Promise<SupplierListItemDto[]> {
    const where: Prisma.SupplierWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.search) {
      const s = query.search;
      where.OR = [
        { name: { contains: s, mode: 'insensitive' } },
        { phone: { contains: s, mode: 'insensitive' } },
        { website: { contains: s, mode: 'insensitive' } },
      ];
    }

    const rows = await this.prisma.supplier.findMany({
      where,
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
      include: {
        defaultCashFlowItem: { select: { id: true, name: true } },
        _count: { select: { contacts: true, catalogItems: true } },
      },
    });
    return rows.map((row) => this.toListItemDto(row));
  }

  async get(id: string): Promise<SupplierDetailDto> {
    const row = await this.prisma.supplier.findUnique({
      where: { id },
      include: {
        defaultCashFlowItem: { select: { id: true, name: true } },
        contacts: {
          orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }],
        },
        catalogItems: {
          orderBy: [{ status: 'asc' }, { name: 'asc' }],
        },
        _count: { select: { contacts: true, catalogItems: true } },
      },
    });
    if (!row) throw new SupplierNotFoundException();
    return this.toDetailDto(row);
  }

  async create(
    dto: CreateSupplierDto,
    actorEmployeeId?: string | null,
  ): Promise<SupplierDetailDto> {
    await this.assertCashFlowItemExists(dto.defaultCashFlowItemId ?? null);
    const created = await this.prisma.supplier.create({
      data: {
        name: dto.name,
        phone: dto.phone ?? null,
        website: dto.website ?? null,
        address: dto.address ?? null,
        comment: dto.comment ?? null,
        legalName: dto.legalName ?? null,
        inn: dto.inn ?? null,
        kpp: dto.kpp ?? null,
        bankName: dto.bankName ?? null,
        bankAccount: dto.bankAccount ?? null,
        bankBik: dto.bankBik ?? null,
        bankCorrAccount: dto.bankCorrAccount ?? null,
        defaultCashFlowItemId: dto.defaultCashFlowItemId ?? null,
        status: dto.status ?? 'ACTIVE',
      },
    });
    this.logger.log(
      `event=supplier.create id=${created.id} name="${created.name}"`,
    );
    await this.audit.log({
      event: 'SUPPLIER_CREATED',
      entityType: 'SUPPLIER',
      entityId: created.id,
      payload: {
        name: created.name,
        phone: created.phone,
        website: created.website,
        status: created.status,
      },
      employeeId: actorEmployeeId ?? null,
    });
    return this.get(created.id);
  }

  async update(
    id: string,
    dto: UpdateSupplierDto,
    actorEmployeeId?: string | null,
  ): Promise<SupplierDetailDto> {
    const current = await this.prisma.supplier.findUnique({ where: { id } });
    if (!current) throw new SupplierNotFoundException();

    const data: Prisma.SupplierUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.phone !== undefined) data.phone = dto.phone;
    if (dto.website !== undefined) data.website = dto.website;
    if (dto.address !== undefined) data.address = dto.address;
    if (dto.comment !== undefined) data.comment = dto.comment;
    if (dto.legalName !== undefined) data.legalName = dto.legalName;
    if (dto.inn !== undefined) data.inn = dto.inn;
    if (dto.kpp !== undefined) data.kpp = dto.kpp;
    if (dto.bankName !== undefined) data.bankName = dto.bankName;
    if (dto.bankAccount !== undefined) data.bankAccount = dto.bankAccount;
    if (dto.bankBik !== undefined) data.bankBik = dto.bankBik;
    if (dto.bankCorrAccount !== undefined) {
      data.bankCorrAccount = dto.bankCorrAccount;
    }
    if (dto.defaultCashFlowItemId !== undefined) {
      await this.assertCashFlowItemExists(dto.defaultCashFlowItemId);
      data.defaultCashFlowItem =
        dto.defaultCashFlowItemId === null
          ? { disconnect: true }
          : { connect: { id: dto.defaultCashFlowItemId } };
    }
    if (dto.status !== undefined) data.status = dto.status;

    if (Object.keys(data).length === 0) return this.get(id);

    const updated = await this.prisma.supplier.update({
      where: { id },
      data,
    });
    this.logger.log(
      `event=supplier.update id=${updated.id} name="${updated.name}" status=${updated.status}`,
    );
    await this.audit.log({
      event: 'SUPPLIER_UPDATED',
      entityType: 'SUPPLIER',
      entityId: updated.id,
      payload: {
        before: {
          name: current.name,
          phone: current.phone,
          website: current.website,
          address: current.address,
          status: current.status,
        },
        after: {
          name: updated.name,
          phone: updated.phone,
          website: updated.website,
          address: updated.address,
          status: updated.status,
        },
      },
      employeeId: actorEmployeeId ?? null,
    });
    return this.get(updated.id);
  }

  /**
   * Физическое удаление поставщика. Каскадом уходят контакты и каталог
   * (`onDelete: Cascade`), у `WorkshopNeed`/`PurchaseReceipt` ссылка
   * обнуляется (`SetNull`). Удаление блокируется, если на поставщика
   * выписаны заказы поставщику (`PurchaseOrder`, `onDelete: Restrict`) —
   * тогда предлагаем архивировать карточку (`status = INACTIVE`).
   */
  async delete(id: string, actorEmployeeId?: string | null): Promise<void> {
    const current = await this.prisma.supplier.findUnique({
      where: { id },
      include: { _count: { select: { purchaseOrders: true } } },
    });
    if (!current) throw new SupplierNotFoundException();
    if (current._count.purchaseOrders > 0) {
      throw new SupplierHasPurchaseOrdersException(
        current._count.purchaseOrders,
      );
    }

    await this.prisma.supplier.delete({ where: { id } });
    this.logger.log(
      `event=supplier.delete id=${id} name="${current.name}"`,
    );
    await this.audit.log({
      event: 'SUPPLIER_DELETED',
      entityType: 'SUPPLIER',
      entityId: id,
      payload: {
        name: current.name,
        status: current.status,
      },
      employeeId: actorEmployeeId ?? null,
    });
  }

  // ===========================================================================
  // Contacts
  // ===========================================================================

  async createContact(
    supplierId: string,
    dto: CreateSupplierContactDto,
    actorEmployeeId?: string | null,
  ): Promise<SupplierContactDto> {
    await this.assertSupplierExists(supplierId);
    const created = await this.prisma.supplierContact.create({
      data: {
        supplierId,
        name: dto.name,
        position: dto.position ?? null,
        phone: dto.phone ?? null,
        email: dto.email ?? null,
        messenger: dto.messenger ?? null,
        isPrimary: dto.isPrimary ?? false,
        comment: dto.comment ?? null,
      },
    });
    await this.audit.log({
      event: 'SUPPLIER_CONTACT_CREATED',
      entityType: 'SUPPLIER',
      entityId: supplierId,
      payload: {
        contactId: created.id,
        name: created.name,
        isPrimary: created.isPrimary,
      },
      employeeId: actorEmployeeId ?? null,
    });
    return contactToDto(created);
  }

  async updateContact(
    supplierId: string,
    contactId: string,
    dto: UpdateSupplierContactDto,
    actorEmployeeId?: string | null,
  ): Promise<SupplierContactDto> {
    await this.assertSupplierExists(supplierId);
    const current = await this.prisma.supplierContact.findUnique({
      where: { id: contactId },
    });
    if (!current || current.supplierId !== supplierId) {
      throw new SupplierContactNotFoundException();
    }

    const data: Prisma.SupplierContactUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.position !== undefined) data.position = dto.position;
    if (dto.phone !== undefined) data.phone = dto.phone;
    if (dto.email !== undefined) data.email = dto.email;
    if (dto.messenger !== undefined) data.messenger = dto.messenger;
    if (dto.isPrimary !== undefined) data.isPrimary = dto.isPrimary;
    if (dto.comment !== undefined) data.comment = dto.comment;

    if (Object.keys(data).length === 0) return contactToDto(current);

    const updated = await this.prisma.supplierContact.update({
      where: { id: contactId },
      data,
    });
    await this.audit.log({
      event: 'SUPPLIER_CONTACT_UPDATED',
      entityType: 'SUPPLIER',
      entityId: supplierId,
      payload: {
        contactId,
        before: {
          name: current.name,
          phone: current.phone,
          email: current.email,
          isPrimary: current.isPrimary,
        },
        after: {
          name: updated.name,
          phone: updated.phone,
          email: updated.email,
          isPrimary: updated.isPrimary,
        },
      },
      employeeId: actorEmployeeId ?? null,
    });
    return contactToDto(updated);
  }

  async deleteContact(
    supplierId: string,
    contactId: string,
    actorEmployeeId?: string | null,
  ): Promise<void> {
    await this.assertSupplierExists(supplierId);
    const current = await this.prisma.supplierContact.findUnique({
      where: { id: contactId },
    });
    if (!current || current.supplierId !== supplierId) {
      throw new SupplierContactNotFoundException();
    }
    await this.prisma.supplierContact.delete({ where: { id: contactId } });
    await this.audit.log({
      event: 'SUPPLIER_CONTACT_DELETED',
      entityType: 'SUPPLIER',
      entityId: supplierId,
      payload: {
        contactId,
        name: current.name,
      },
      employeeId: actorEmployeeId ?? null,
    });
  }

  // ===========================================================================
  // Catalog
  // ===========================================================================

  async listCatalog(
    supplierId: string,
    query: ListSupplierCatalogQuery,
  ): Promise<SupplierCatalogItemDto[]> {
    await this.assertSupplierExists(supplierId);
    const where: Prisma.SupplierCatalogItemWhereInput = { supplierId };
    if (query.status) where.status = query.status;
    if (query.search) {
      const s = query.search;
      where.OR = [
        { name: { contains: s, mode: 'insensitive' } },
        { supplierArticle: { contains: s, mode: 'insensitive' } },
        { fabricType: { contains: s, mode: 'insensitive' } },
        { colorText: { contains: s, mode: 'insensitive' } },
      ];
    }
    const rows = await this.prisma.supplierCatalogItem.findMany({
      where,
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
    });
    return rows.map(catalogItemToDto);
  }

  async createCatalogItem(
    supplierId: string,
    dto: CreateSupplierCatalogItemDto,
    actorEmployeeId?: string | null,
  ): Promise<SupplierCatalogItemDto> {
    await this.assertSupplierExists(supplierId);
    const created = await this.prisma.supplierCatalogItem.create({
      data: {
        supplierId,
        name: dto.name,
        supplierArticle: dto.supplierArticle ?? null,
        category: dto.category ?? null,
        fabricType: dto.fabricType ?? null,
        densityGsm: dto.densityGsm ?? null,
        colorText: dto.colorText ?? null,
        unit: dto.unit,
        lastPrice:
          dto.lastPrice == null
            ? null
            : new Prisma.Decimal(dto.lastPrice as string),
        currency: dto.currency ?? null,
        minOrderQty:
          dto.minOrderQty == null
            ? null
            : new Prisma.Decimal(dto.minOrderQty as string),
        deliveryDays: dto.deliveryDays ?? null,
        comment: dto.comment ?? null,
        status: dto.status ?? 'ACTIVE',
      },
    });
    await this.audit.log({
      event: 'SUPPLIER_CATALOG_ITEM_CREATED',
      entityType: 'SUPPLIER',
      entityId: supplierId,
      payload: {
        itemId: created.id,
        name: created.name,
        unit: created.unit,
        status: created.status,
      },
      employeeId: actorEmployeeId ?? null,
    });
    return catalogItemToDto(created);
  }

  async updateCatalogItem(
    supplierId: string,
    itemId: string,
    dto: UpdateSupplierCatalogItemDto,
    actorEmployeeId?: string | null,
  ): Promise<SupplierCatalogItemDto> {
    await this.assertSupplierExists(supplierId);
    const current = await this.prisma.supplierCatalogItem.findUnique({
      where: { id: itemId },
    });
    if (!current || current.supplierId !== supplierId) {
      throw new SupplierCatalogItemNotFoundException();
    }

    const data: Prisma.SupplierCatalogItemUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.supplierArticle !== undefined) {
      data.supplierArticle = dto.supplierArticle;
    }
    if (dto.category !== undefined) data.category = dto.category;
    if (dto.fabricType !== undefined) data.fabricType = dto.fabricType;
    if (dto.densityGsm !== undefined) data.densityGsm = dto.densityGsm;
    if (dto.colorText !== undefined) data.colorText = dto.colorText;
    if (dto.unit !== undefined) data.unit = dto.unit;
    if (dto.lastPrice !== undefined) {
      data.lastPrice =
        dto.lastPrice === null ? null : new Prisma.Decimal(dto.lastPrice);
    }
    if (dto.currency !== undefined) data.currency = dto.currency;
    if (dto.minOrderQty !== undefined) {
      data.minOrderQty =
        dto.minOrderQty === null
          ? null
          : new Prisma.Decimal(dto.minOrderQty);
    }
    if (dto.deliveryDays !== undefined) data.deliveryDays = dto.deliveryDays;
    if (dto.comment !== undefined) data.comment = dto.comment;
    if (dto.status !== undefined) data.status = dto.status;

    if (Object.keys(data).length === 0) return catalogItemToDto(current);

    const updated = await this.prisma.supplierCatalogItem.update({
      where: { id: itemId },
      data,
    });
    await this.audit.log({
      event: 'SUPPLIER_CATALOG_ITEM_UPDATED',
      entityType: 'SUPPLIER',
      entityId: supplierId,
      payload: {
        itemId,
        before: {
          name: current.name,
          supplierArticle: current.supplierArticle,
          unit: current.unit,
          lastPrice: current.lastPrice ? current.lastPrice.toString() : null,
          status: current.status,
        },
        after: {
          name: updated.name,
          supplierArticle: updated.supplierArticle,
          unit: updated.unit,
          lastPrice: updated.lastPrice ? updated.lastPrice.toString() : null,
          status: updated.status,
        },
      },
      employeeId: actorEmployeeId ?? null,
    });
    return catalogItemToDto(updated);
  }

  /**
   * Soft-archive позиции каталога (status = INACTIVE). Физического
   * удаления нет: уже выбранная в `WorkshopNeed` позиция должна
   * сохранить свою историю.
   */
  async archiveCatalogItem(
    supplierId: string,
    itemId: string,
    actorEmployeeId?: string | null,
  ): Promise<SupplierCatalogItemDto> {
    await this.assertSupplierExists(supplierId);
    const current = await this.prisma.supplierCatalogItem.findUnique({
      where: { id: itemId },
    });
    if (!current || current.supplierId !== supplierId) {
      throw new SupplierCatalogItemNotFoundException();
    }
    if (current.status === 'INACTIVE') {
      // Идемпотентность: повторная архивация не считается ошибкой.
      return catalogItemToDto(current);
    }
    const updated = await this.prisma.supplierCatalogItem.update({
      where: { id: itemId },
      data: { status: 'INACTIVE' },
    });
    await this.audit.log({
      event: 'SUPPLIER_CATALOG_ITEM_ARCHIVED',
      entityType: 'SUPPLIER',
      entityId: supplierId,
      payload: {
        itemId,
        previousStatus: current.status,
      },
      employeeId: actorEmployeeId ?? null,
    });
    return catalogItemToDto(updated);
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private async assertSupplierExists(id: string): Promise<void> {
    const row = await this.prisma.supplier.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!row) throw new SupplierNotFoundException();
  }

  /**
   * Проверяем, что выбранная статья ДДС существует (если задана).
   * Неактивные статьи разрешаем: дропдаун в UI предлагает только
   * активные, но уже привязанную и позже деактивированную статью не
   * заставляем менять при правке карточки. `null` — снятие дефолта.
   */
  private async assertCashFlowItemExists(
    itemId: string | null,
  ): Promise<void> {
    if (!itemId) return;
    const row = await this.prisma.cashFlowItem.findUnique({
      where: { id: itemId },
      select: { id: true },
    });
    if (!row) throw new CashFlowItemNotFoundException();
  }

  // ---------------------------------------------------------------------------
  // Mappers
  // ---------------------------------------------------------------------------

  private toListItemDto(
    row: Prisma.SupplierGetPayload<{
      include: {
        defaultCashFlowItem: { select: { id: true; name: true } };
        _count: { select: { contacts: true; catalogItems: true } };
      };
    }>,
  ): SupplierListItemDto {
    return {
      id: row.id,
      name: row.name,
      phone: row.phone,
      website: row.website,
      address: row.address,
      comment: row.comment,
      legalName: row.legalName,
      inn: row.inn,
      kpp: row.kpp,
      bankName: row.bankName,
      bankAccount: row.bankAccount,
      bankBik: row.bankBik,
      bankCorrAccount: row.bankCorrAccount,
      defaultCashFlowItemId: row.defaultCashFlowItemId,
      defaultCashFlowItemName: row.defaultCashFlowItem?.name ?? null,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      contactsCount: row._count.contacts,
      catalogItemsCount: row._count.catalogItems,
    };
  }

  private toDetailDto(
    row: Prisma.SupplierGetPayload<{
      include: {
        defaultCashFlowItem: { select: { id: true; name: true } };
        contacts: true;
        catalogItems: true;
        _count: { select: { contacts: true; catalogItems: true } };
      };
    }>,
  ): SupplierDetailDto {
    return {
      ...this.toListItemDto(row),
      contacts: row.contacts.map(contactToDto),
      catalogItems: row.catalogItems.map(catalogItemToDto),
    };
  }
}

// ---------------------------------------------------------------------------
// Stand-alone mappers (нужны и сервису, и WorkshopNeedsService)
// ---------------------------------------------------------------------------

function contactToDto(
  c: Prisma.SupplierContactGetPayload<{}>,
): SupplierContactDto {
  return {
    id: c.id,
    supplierId: c.supplierId,
    name: c.name,
    position: c.position,
    phone: c.phone,
    email: c.email,
    messenger: c.messenger,
    isPrimary: c.isPrimary,
    comment: c.comment,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

function catalogItemToDto(
  c: Prisma.SupplierCatalogItemGetPayload<{}>,
): SupplierCatalogItemDto {
  return {
    id: c.id,
    supplierId: c.supplierId,
    name: c.name,
    supplierArticle: c.supplierArticle,
    category: c.category,
    fabricType: c.fabricType,
    densityGsm: c.densityGsm,
    colorText: c.colorText,
    unit: c.unit,
    lastPrice: c.lastPrice ? c.lastPrice.toString() : null,
    currency: c.currency,
    minOrderQty: c.minOrderQty ? c.minOrderQty.toString() : null,
    deliveryDays: c.deliveryDays,
    comment: c.comment,
    status: c.status,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}
