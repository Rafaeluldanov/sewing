'use client';

/**
 * Панель фильтров отчёта «Себестоимость» (`/admin/production-cost`).
 *
 * `method=get` форма: даты + выпадающие combobox-фильтры с поиском
 * (лекало / заказ / клиент / сотрудник / операция). Combobox кладёт в
 * форму `id`, показывая название — пользователю больше не нужно вводить
 * сырые ID. Справочники приходят из
 * `GET /api/admin/production-cost/v2/filter-options`.
 */
import Link from 'next/link';
import { Filter, RotateCcw } from 'lucide-react';
import type { ProductionCostFilterOptionsDto } from '@sewing/shared/production-cost';
import { AdminDateField } from '@/components/admin';
import { FilterCombobox } from './filter-combobox';

interface ProductionCostFiltersProps {
  tab: string;
  dateFrom?: string;
  dateTo?: string;
  patternItemId?: string;
  orderId?: string;
  clientId?: string;
  employeeId?: string;
  operationId?: string;
  hasFilters: boolean;
  options: ProductionCostFilterOptionsDto;
}

export function ProductionCostFilters({
  tab,
  dateFrom,
  dateTo,
  patternItemId,
  orderId,
  clientId,
  employeeId,
  operationId,
  hasFilters,
  options,
}: ProductionCostFiltersProps) {
  return (
    <form method="get" className="admin-form-grid">
      <input type="hidden" name="tab" value={tab} />
      <div className="admin-field">
        <label htmlFor="dateFrom">С даты</label>
        <AdminDateField id="dateFrom" name="dateFrom" defaultValue={dateFrom ?? ''} />
      </div>
      <div className="admin-field">
        <label htmlFor="dateTo">По дату</label>
        <AdminDateField id="dateTo" name="dateTo" defaultValue={dateTo ?? ''} />
      </div>
      <div className="admin-field">
        <label>Лекало</label>
        <FilterCombobox
          name="patternItemId"
          label="Лекало"
          placeholder="Все лекала"
          options={options.patterns}
          defaultValue={patternItemId}
        />
      </div>
      <div className="admin-field">
        <label>Заказ</label>
        <FilterCombobox
          name="orderId"
          label="Заказ"
          placeholder="Все заказы"
          options={options.orders}
          defaultValue={orderId}
        />
      </div>
      <div className="admin-field">
        <label>Клиент</label>
        <FilterCombobox
          name="clientId"
          label="Клиент"
          placeholder="Все клиенты"
          options={options.clients}
          defaultValue={clientId}
        />
      </div>
      <div className="admin-field">
        <label>Сотрудник</label>
        <FilterCombobox
          name="employeeId"
          label="Сотрудник"
          placeholder="Все сотрудники"
          options={options.employees}
          defaultValue={employeeId}
        />
      </div>
      <div className="admin-field">
        <label>Операция</label>
        <FilterCombobox
          name="operationId"
          label="Операция"
          placeholder="Все операции"
          options={options.operations}
          defaultValue={operationId}
        />
      </div>
      <div
        className="admin-field admin-field--inline"
        style={{ alignSelf: 'end' }}
      >
        <button type="submit" className="admin-btn admin-btn--primary">
          <Filter size={14} strokeWidth={1.6} aria-hidden />
          Применить
        </button>
        {hasFilters && (
          <Link href="/admin/production-cost" className="admin-btn admin-btn--ghost">
            <RotateCcw size={14} strokeWidth={1.6} aria-hidden />
            Сбросить
          </Link>
        )}
      </div>
    </form>
  );
}
