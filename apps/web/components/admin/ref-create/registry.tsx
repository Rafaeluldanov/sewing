'use client';

/**
 * Registry контура ref-create: для каждого вида справочника — модалка
 * создания + маппинг созданного DTO в option(s) списка.
 *
 * Модалки подключены через `next/dynamic({ssr: false})`: CreatableSelect
 * рендерит модалку только после клика по «＋ Добавить…», поэтому чанк
 * модалки не попадает в первичный бандл тяжёлых форм (заказы и т.п.).
 */

import dynamic from 'next/dynamic';
import type { ComponentType } from 'react';
import type {
  RefCreateContext,
  RefCreatedDtoMap,
  RefEntityKind,
} from './types';

export interface RefOption {
  value: string;
  label: string;
}

interface RegistryEntry<K extends RefEntityKind> {
  Modal: ComponentType<{
    context?: RefCreateContext;
    zIndex?: number;
    onCancel: () => void;
    onCreated: (dto: RefCreatedDtoMap[K]) => void;
  }>;
  toOptions: (dto: RefCreatedDtoMap[K]) => RefOption[];
  createLabel: string;
}

export const REF_CREATE_REGISTRY: {
  [K in RefEntityKind]: RegistryEntry<K>;
} = {
  client: {
    Modal: dynamic(
      () => import('./create-client-modal').then((m) => m.CreateClientModal),
      { ssr: false },
    ),
    toOptions: (dto) => [{ value: dto.id, label: dto.name }],
    createLabel: '＋ Добавить клиента…',
  },
  companyDivision: {
    Modal: dynamic(
      () =>
        import('./create-company-division-modal').then(
          (m) => m.CreateCompanyDivisionModal,
        ),
      { ssr: false },
    ),
    toOptions: (dto) => [{ value: dto.id, label: dto.name }],
    createLabel: '＋ Добавить подразделение…',
  },
  supplier: {
    Modal: dynamic(
      () =>
        import('./create-supplier-modal').then((m) => m.CreateSupplierModal),
      { ssr: false },
    ),
    toOptions: (dto) => [{ value: dto.id, label: dto.name }],
    createLabel: '＋ Добавить поставщика…',
  },
  warehouse: {
    Modal: dynamic(
      () =>
        import('./create-warehouse-modal').then((m) => m.CreateWarehouseModal),
      { ssr: false },
    ),
    toOptions: (dto) => [{ value: dto.id, label: dto.name }],
    createLabel: '＋ Добавить склад…',
  },
  cashFlowItem: {
    Modal: dynamic(
      () =>
        import('./create-cash-flow-item-modal').then(
          (m) => m.CreateCashFlowItemModal,
        ),
      { ssr: false },
    ),
    toOptions: (dto) => [{ value: dto.id, label: dto.name }],
    createLabel: '＋ Добавить статью…',
  },
  cashAccount: {
    Modal: dynamic(
      () =>
        import('./create-cash-account-modal').then(
          (m) => m.CreateCashAccountModal,
        ),
      { ssr: false },
    ),
    toOptions: (dto) => [{ value: dto.id, label: dto.name }],
    createLabel: '＋ Добавить счёт…',
  },
  patternCategory: {
    Modal: dynamic(
      () =>
        import('./create-pattern-category-modal').then(
          (m) => m.CreatePatternCategoryModal,
        ),
      { ssr: false },
    ),
    toOptions: (dto) => [{ value: dto.id, label: dto.name }],
    createLabel: '＋ Добавить группу…',
  },
  printer: {
    Modal: dynamic(
      () => import('./create-printer-modal').then((m) => m.CreatePrinterModal),
      { ssr: false },
    ),
    toOptions: (dto) => [{ value: dto.id, label: dto.name }],
    createLabel: '＋ Добавить принтер…',
  },
  appRole: {
    Modal: dynamic(
      () =>
        import('./create-app-role-modal').then((m) => m.CreateAppRoleModal),
      { ssr: false },
    ),
    // Селекты ролей работают по КОДАМ (Employee.roles хранит коды).
    toOptions: (dto) => [{ value: dto.code, label: dto.name }],
    createLabel: '＋ Добавить роль…',
  },
  warehouseCell: {
    Modal: dynamic(
      () =>
        import('./create-warehouse-cells-modal').then(
          (m) => m.CreateWarehouseCellsModal,
        ),
      { ssr: false },
    ),
    toOptions: (dto) =>
      dto.cells.map((c) => ({
        value: c.id,
        label: dto.warehouseName ? `${c.code} · ${dto.warehouseName}` : c.code,
      })),
    createLabel: '＋ Добавить ячейки…',
  },
  employee: {
    Modal: dynamic(
      () =>
        import('@/components/employees/create-employee-modal').then(
          (m) => m.CreateEmployeeModal,
        ),
      { ssr: false },
    ),
    toOptions: (dto) => [{ value: dto.id, label: dto.fullName }],
    createLabel: '＋ Добавить сотрудника…',
  },
  routeTemplate: {
    Modal: dynamic(
      () =>
        import('@/components/orders/create-route-template-modal').then(
          (m) => m.CreateRouteTemplateModal,
        ),
      { ssr: false },
    ),
    toOptions: (dto) => [{ value: dto.id, label: `${dto.name} (${dto.code})` }],
    createLabel: '＋ Добавить маршрут…',
  },
};
