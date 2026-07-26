'use client';

import { useFormState, useFormStatus } from 'react-dom';
import {
  Archive,
  CheckCircle,
  Plus,
  Save,
  XCircle,
} from 'lucide-react';
import {
  SUPPLIER_CATALOG_ITEM_STATUSES,
  SUPPLIER_CATALOG_ITEM_STATUS_LABELS,
  type SupplierCatalogItemDto,
  type SupplierCatalogItemStatus,
} from '@sewing/shared/suppliers';
import {
  archiveSupplierCatalogItemAction,
  createSupplierCatalogItemAction,
  updateSupplierCatalogItemAction,
} from '../actions';
import {
  initialSupplierCatalogItemFormState,
  type SupplierCatalogItemFormState,
} from '../form-state';

/**
 * Блок номенклатуры поставщика. Каждая позиция — отдельная inline-форма;
 * новая создаётся формой ниже списка.
 *
 * Удаление soft-archive (status = INACTIVE), физического delete нет
 * (см. ТЗ §5: позиция могла быть выбрана в `WorkshopNeed`, и мы хотим
 * сохранять историю).
 */
export function CatalogSection({
  supplierId,
  items,
}: {
  supplierId: string;
  items: SupplierCatalogItemDto[];
}) {
  return (
    <div className="admin-stack">
      <ul
        className="admin-summary-list"
        style={{ display: 'grid', gap: 8, padding: 0, margin: 0 }}
      >
        {items.length === 0 && (
          <li className="admin-muted" style={{ padding: '8px 0' }}>
            Каталог пуст — добавьте первую позицию ниже.
          </li>
        )}
        {items.map((item) => (
          <li
            key={item.id}
            style={{
              borderTop: '1px solid rgba(0,0,0,0.06)',
              paddingTop: 12,
            }}
          >
            <CatalogEditForm supplierId={supplierId} item={item} />
          </li>
        ))}
      </ul>

      <div
        style={{
          borderTop: '1px solid rgba(0,0,0,0.08)',
          paddingTop: 12,
          marginTop: 8,
        }}
      >
        <h4 style={{ margin: '0 0 8px' }}>
          Добавить позицию
        </h4>
        <CatalogCreateForm supplierId={supplierId} />
      </div>
    </div>
  );
}

function CreateButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending}
    >
      <Plus size={14} strokeWidth={1.6} aria-hidden />
      {pending ? 'Создаём…' : 'Добавить'}
    </button>
  );
}

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="admin-btn" disabled={pending}>
      <Save size={14} strokeWidth={1.6} aria-hidden />
      {pending ? 'Сохраняем…' : 'Сохранить'}
    </button>
  );
}

function ArchiveButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--ghost"
      disabled={pending}
      title="Перевести позицию в архив (status = INACTIVE)"
    >
      <Archive size={14} strokeWidth={1.6} aria-hidden />
      {pending ? 'Архивируем…' : 'В архив'}
    </button>
  );
}

function CatalogCreateForm({ supplierId }: { supplierId: string }) {
  const [state, formAction] = useFormState<
    SupplierCatalogItemFormState,
    FormData
  >(
    createSupplierCatalogItemAction.bind(null, supplierId),
    initialSupplierCatalogItemFormState,
  );
  return (
    <form action={formAction} className="admin-form">
      <div className="admin-form-grid">
        <div className="admin-field">
          <label htmlFor={`catalog-new-name-${supplierId}`}>Название</label>
          <input
            id={`catalog-new-name-${supplierId}`}
            name="name"
            type="text"
            required
            maxLength={300}
            placeholder="Например: Кулирка BLACK 180"
          />
        </div>
        <div className="admin-field">
          <label htmlFor={`catalog-new-article-${supplierId}`}>Артикул</label>
          <input
            id={`catalog-new-article-${supplierId}`}
            name="supplierArticle"
            type="text"
            maxLength={200}
            placeholder="KT-180-BLK"
          />
        </div>
        <div className="admin-field">
          <label htmlFor={`catalog-new-unit-${supplierId}`}>Единица</label>
          <input
            id={`catalog-new-unit-${supplierId}`}
            name="unit"
            type="text"
            required
            maxLength={32}
            placeholder="кг / м / шт"
          />
        </div>
        <div className="admin-field">
          <label htmlFor={`catalog-new-category-${supplierId}`}>
            Категория
          </label>
          <input
            id={`catalog-new-category-${supplierId}`}
            name="category"
            type="text"
            maxLength={200}
          />
        </div>
        <div className="admin-field">
          <label htmlFor={`catalog-new-fabric-${supplierId}`}>
            Тип материала
          </label>
          <input
            id={`catalog-new-fabric-${supplierId}`}
            name="fabricType"
            type="text"
            maxLength={200}
            placeholder="кулирка / двунитка / …"
          />
        </div>
        <div className="admin-field">
          <label htmlFor={`catalog-new-density-${supplierId}`}>
            Плотность, г/м²
          </label>
          <input
            id={`catalog-new-density-${supplierId}`}
            name="densityGsm"
            type="number"
            min={1}
            inputMode="numeric"
          />
        </div>
        <div className="admin-field">
          <label htmlFor={`catalog-new-color-${supplierId}`}>Цвет</label>
          <input
            id={`catalog-new-color-${supplierId}`}
            name="colorText"
            type="text"
            maxLength={200}
          />
        </div>
        <div className="admin-field">
          <label htmlFor={`catalog-new-price-${supplierId}`}>Цена</label>
          <input
            id={`catalog-new-price-${supplierId}`}
            name="lastPrice"
            type="text"
            inputMode="decimal"
            placeholder="0.00"
          />
        </div>
        <div className="admin-field">
          <label htmlFor={`catalog-new-currency-${supplierId}`}>Валюта</label>
          <input
            id={`catalog-new-currency-${supplierId}`}
            name="currency"
            type="text"
            maxLength={16}
            placeholder="RUB"
          />
        </div>
        <div className="admin-field">
          <label htmlFor={`catalog-new-minorder-${supplierId}`}>
            Мин. партия
          </label>
          <input
            id={`catalog-new-minorder-${supplierId}`}
            name="minOrderQty"
            type="text"
            inputMode="decimal"
          />
        </div>
        <div className="admin-field">
          <label htmlFor={`catalog-new-delivery-${supplierId}`}>
            Срок поставки, дней
          </label>
          <input
            id={`catalog-new-delivery-${supplierId}`}
            name="deliveryDays"
            type="number"
            min={0}
            inputMode="numeric"
          />
        </div>
      </div>
      <div className="admin-field">
        <label htmlFor={`catalog-new-comment-${supplierId}`}>Комментарий</label>
        <textarea
          id={`catalog-new-comment-${supplierId}`}
          name="comment"
          rows={2}
          maxLength={2000}
        />
      </div>
      {state.error && (
        <div className="error-box" role="alert">
          <XCircle size={14} strokeWidth={1.6} aria-hidden /> {state.error}
        </div>
      )}
      {state.ok && state.successMessage && (
        <div className="success-box" role="status">
          <CheckCircle size={14} strokeWidth={1.6} aria-hidden />{' '}
          {state.successMessage}
        </div>
      )}
      <div className="admin-actions-row">
        <CreateButton />
      </div>
    </form>
  );
}

function CatalogEditForm({
  supplierId,
  item,
}: {
  supplierId: string;
  item: SupplierCatalogItemDto;
}) {
  const [updateState, updateAction] = useFormState<
    SupplierCatalogItemFormState,
    FormData
  >(
    updateSupplierCatalogItemAction.bind(null, supplierId, item.id),
    initialSupplierCatalogItemFormState,
  );
  const [archiveState, archiveAction] = useFormState<
    SupplierCatalogItemFormState,
    FormData
  >(
    archiveSupplierCatalogItemAction.bind(null, supplierId, item.id),
    initialSupplierCatalogItemFormState,
  );

  const isInactive = item.status !== 'ACTIVE';

  return (
    <div style={isInactive ? { opacity: 0.7 } : undefined}>
      <form action={updateAction} className="admin-form">
        <div className="admin-form-grid">
          <div className="admin-field">
            <label htmlFor={`cat-name-${item.id}`}>Название</label>
            <input
              id={`cat-name-${item.id}`}
              name="name"
              type="text"
              required
              maxLength={300}
              defaultValue={item.name}
            />
          </div>
          <div className="admin-field">
            <label htmlFor={`cat-article-${item.id}`}>Артикул</label>
            <input
              id={`cat-article-${item.id}`}
              name="supplierArticle"
              type="text"
              maxLength={200}
              defaultValue={item.supplierArticle ?? ''}
            />
          </div>
          <div className="admin-field">
            <label htmlFor={`cat-unit-${item.id}`}>Единица</label>
            <input
              id={`cat-unit-${item.id}`}
              name="unit"
              type="text"
              required
              maxLength={32}
              defaultValue={item.unit}
            />
          </div>
          <div className="admin-field">
            <label htmlFor={`cat-status-${item.id}`}>Статус</label>
            <select
              id={`cat-status-${item.id}`}
              name="status"
              defaultValue={item.status}
            >
              {SUPPLIER_CATALOG_ITEM_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {SUPPLIER_CATALOG_ITEM_STATUS_LABELS[
                    s as SupplierCatalogItemStatus
                  ]}
                </option>
              ))}
            </select>
          </div>
          <div className="admin-field">
            <label htmlFor={`cat-category-${item.id}`}>Категория</label>
            <input
              id={`cat-category-${item.id}`}
              name="category"
              type="text"
              maxLength={200}
              defaultValue={item.category ?? ''}
            />
          </div>
          <div className="admin-field">
            <label htmlFor={`cat-fabric-${item.id}`}>Тип материала</label>
            <input
              id={`cat-fabric-${item.id}`}
              name="fabricType"
              type="text"
              maxLength={200}
              defaultValue={item.fabricType ?? ''}
            />
          </div>
          <div className="admin-field">
            <label htmlFor={`cat-density-${item.id}`}>Плотность, г/м²</label>
            <input
              id={`cat-density-${item.id}`}
              name="densityGsm"
              type="number"
              min={1}
              inputMode="numeric"
              defaultValue={item.densityGsm ?? ''}
            />
          </div>
          <div className="admin-field">
            <label htmlFor={`cat-color-${item.id}`}>Цвет</label>
            <input
              id={`cat-color-${item.id}`}
              name="colorText"
              type="text"
              maxLength={200}
              defaultValue={item.colorText ?? ''}
            />
          </div>
          <div className="admin-field">
            <label htmlFor={`cat-price-${item.id}`}>Цена</label>
            <input
              id={`cat-price-${item.id}`}
              name="lastPrice"
              type="text"
              inputMode="decimal"
              defaultValue={item.lastPrice ?? ''}
            />
          </div>
          <div className="admin-field">
            <label htmlFor={`cat-currency-${item.id}`}>Валюта</label>
            <input
              id={`cat-currency-${item.id}`}
              name="currency"
              type="text"
              maxLength={16}
              defaultValue={item.currency ?? ''}
            />
          </div>
          <div className="admin-field">
            <label htmlFor={`cat-minorder-${item.id}`}>Мин. партия</label>
            <input
              id={`cat-minorder-${item.id}`}
              name="minOrderQty"
              type="text"
              inputMode="decimal"
              defaultValue={item.minOrderQty ?? ''}
            />
          </div>
          <div className="admin-field">
            <label htmlFor={`cat-delivery-${item.id}`}>
              Срок поставки, дней
            </label>
            <input
              id={`cat-delivery-${item.id}`}
              name="deliveryDays"
              type="number"
              min={0}
              inputMode="numeric"
              defaultValue={item.deliveryDays ?? ''}
            />
          </div>
        </div>
        <div className="admin-field">
          <label htmlFor={`cat-comment-${item.id}`}>Комментарий</label>
          <textarea
            id={`cat-comment-${item.id}`}
            name="comment"
            rows={2}
            maxLength={2000}
            defaultValue={item.comment ?? ''}
          />
        </div>
        {updateState.error && (
          <div className="error-box" role="alert">
            <XCircle size={14} strokeWidth={1.6} aria-hidden />{' '}
            {updateState.error}
          </div>
        )}
        {updateState.ok && updateState.successMessage && (
          <div className="success-box" role="status">
            <CheckCircle size={14} strokeWidth={1.6} aria-hidden />{' '}
            {updateState.successMessage}
          </div>
        )}
        <div className="admin-actions-row">
          <SaveButton />
        </div>
      </form>

      {!isInactive && (
        <form action={archiveAction} style={{ marginTop: 6 }}>
          {archiveState.error && (
            <div className="error-box" role="alert" style={{ marginBottom: 6 }}>
              <XCircle size={14} strokeWidth={1.6} aria-hidden />{' '}
              {archiveState.error}
            </div>
          )}
          <ArchiveButton />
        </form>
      )}
    </div>
  );
}
