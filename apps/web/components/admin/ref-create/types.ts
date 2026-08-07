/**
 * Типы контура «＋ Добавить…» в select-ах справочников (ref-create).
 *
 * Живут отдельно от `actions.ts`: файл с `'use server'` может
 * экспортировать ТОЛЬКО async-функции — любой другой рантайм-экспорт
 * роняет страницу (см. memory `feedback_use_server_only_async_exports`).
 * Интерфейсы/типы стираются при компиляции, но держим их здесь же,
 * рядом с registry, чтобы у контура была одна точка правды.
 */

import type { ClientDto } from '@sewing/shared/clients';
import type { CompanyDivisionDto } from '@sewing/shared/company-divisions';
import type { SupplierDetailDto } from '@sewing/shared/suppliers';
import type {
  CreateWarehouseLineResultDto,
  WarehouseDetailDto,
  WarehouseSummaryDto,
} from '@sewing/shared/warehouses';
import type { CashAccountDto, CashFlowItemDto } from '@sewing/shared/treasury';
import type { PatternCategoryDto } from '@sewing/shared/pattern-categories';
import type { PrinterDetailDto } from '@sewing/shared/printers';
import type { AppRoleDto } from '@sewing/shared/app-roles';
import type { EmployeeDetailDto } from '@sewing/shared/employees';
import type { RouteTemplateDetailDto } from '@sewing/shared/routes';
import type { TechCardTemplateDetailDto } from '@sewing/shared/tech-cards';

/**
 * Справочники, для которых CreatableSelect умеет открывать модалку
 * создания. Операция сюда сознательно не входит — у неё свой
 * creatable-режим внутри `GroupedOperationSelect` (optgroup-select).
 */
export type RefEntityKind =
  | 'client'
  | 'companyDivision'
  | 'supplier'
  | 'warehouse'
  | 'cashFlowItem'
  | 'cashAccount'
  | 'patternCategory'
  | 'printer'
  | 'appRole'
  | 'warehouseCell'
  | 'employee'
  | 'routeTemplate'
  | 'techCard';

/** Контекст создания для суб-сущностей (сейчас — только ячейки склада). */
export interface RefCreateContext {
  warehouseId?: string;
  warehouseName?: string;
  /** Склад зафиксирован хостом (select ячейки уже привязан к складу). */
  lockWarehouse?: boolean;
}

/**
 * Результат создания «ячеек»: линия создаётся пачкой
 * (`POST /warehouses/:id/lines`), автовыбирается первая ячейка.
 */
export interface CreatedWarehouseCells extends CreateWarehouseLineResultDto {
  warehouseId: string;
  warehouseName: string | null;
}

/** DTO, которые может вернуть модалка создания (по видам справочника). */
export interface RefCreatedDtoMap {
  client: ClientDto;
  companyDivision: CompanyDivisionDto;
  supplier: SupplierDetailDto;
  warehouse: WarehouseDetailDto;
  cashFlowItem: CashFlowItemDto;
  cashAccount: CashAccountDto;
  patternCategory: PatternCategoryDto;
  printer: PrinterDetailDto;
  appRole: AppRoleDto;
  warehouseCell: CreatedWarehouseCells;
  employee: EmployeeDetailDto;
  routeTemplate: RouteTemplateDetailDto;
  techCard: TechCardTemplateDetailDto;
}

export type RefCreatedDto = RefCreatedDtoMap[RefEntityKind];

/** Единый контракт модалок создания (см. registry.tsx). */
export interface RefCreateModalProps {
  context?: RefCreateContext;
  zIndex?: number;
  onCancel: () => void;
  onCreated: (dto: RefCreatedDto) => void;
}

/**
 * Единый результат inline-actions: `{ok, dto}` при успехе,
 * `{error}` — человекочитаемый текст (Zod-issue или ответ backend).
 */
export interface RefActionResult<T> {
  ok?: boolean;
  dto?: T;
  error?: string;
}

export type LoadWarehousesResult = RefActionResult<WarehouseSummaryDto[]>;
