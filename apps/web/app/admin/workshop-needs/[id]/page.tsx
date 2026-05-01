/**
 * Карточка потребности цеха (`/admin/workshop-needs/[id]`).
 *
 * Этап 4А «Потребность цеха». Структура — стандартный admin
 * detail-page:
 *   - read-only блок с данными расчёта (description / role / fabricType
 *     / density / width / resolved color / totalAreaM2 / method /
 *     calculatedQty / calculationNote);
 *   - блок редактирования (purchaseQty / supplier / item / price /
 *     currency / ETA / status / comment);
 *   - tech-info справа (id / orderId / sourceType / sourceId / даты).
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowLeft,
  ClipboardList,
  ExternalLink,
} from 'lucide-react';
import {
  MATERIAL_ROLE_LABELS,
  WORKSHOP_NEED_CALCULATION_METHOD_LABELS,
  WORKSHOP_NEED_STATUS_LABELS,
  type MaterialRole,
  type WorkshopNeedCalculationMethod,
  type WorkshopNeedStatus,
} from '@sewing/shared/workshop-needs';
import type {
  SupplierCatalogItemDto,
  SupplierListItemDto,
} from '@sewing/shared/suppliers';
import { ApiRequestError } from '@/lib/api';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { getWorkshopNeed } from '@/lib/workshop-needs-api';
import {
  listSupplierCatalog,
  listSuppliers,
} from '@/lib/suppliers-api';
import {
  AdminCard,
  AdminPageShell,
  AdminSectionHeader,
  AdminStatusBadge,
  AdminTechInfo,
} from '@/components/admin';
import type { AdminStatusTone } from '@/lib/admin-labels';
import { EditWorkshopNeedForm } from './edit-form';
import { CreatePoFromSingleNeed } from '../create-po-button';

/**
 * Feature-flag для модуля «Поставщики» (Этап 5). Server-side
 * `process.env.NEXT_PUBLIC_*` инлайнится Next.js-ом и работает
 * одинаково в RSC. Если флаг явно выключен (`=0`/`=false`/`=off`),
 * селекты supplier/catalog в UI не показываются — текстовые
 * `supplierNameText` / `purchaseItemNameText` остаются единственным
 * интерфейсом. Default-on (см. `isFeatureEnabled` /
 * `@/lib/feature-flags`).
 */
const FEATURE_SUPPLIERS_ENABLED = isFeatureEnabled(
  process.env.NEXT_PUBLIC_FEATURE_SUPPLIERS,
);

/**
 * Feature-flag для модуля «Заказы поставщикам» (Этап 6А, см.
 * `apps/api/src/modules/purchase-orders/*`). Гейтит только UI-блок
 * «Создать заказ поставщику» в карточке потребности; сам backend
 * `/api/purchase-orders` остаётся доступным под `ADMIN`/`SHOP_MANAGER`
 * в любом случае. Default-on (см. `isFeatureEnabled` /
 * `@/lib/feature-flags`).
 */
const FEATURE_PURCHASE_ORDERS_ENABLED = isFeatureEnabled(
  process.env.NEXT_PUBLIC_FEATURE_PURCHASE_ORDERS,
);

export const dynamic = 'force-dynamic';

interface Params {
  params: { id: string };
}

function statusTone(status: string): AdminStatusTone {
  switch (status as WorkshopNeedStatus) {
    case 'CALCULATED':
      return 'info';
    case 'REVIEWED':
      return 'muted';
    case 'PURCHASE_PLANNED':
      return 'success';
    case 'ORDERED':
      return 'success';
    case 'PARTIALLY_RECEIVED':
      return 'warning';
    case 'RECEIVED':
      return 'success';
    case 'CANCELLED':
      return 'danger';
    default:
      return 'muted';
  }
}

function formatStatus(status: string): string {
  return WORKSHOP_NEED_STATUS_LABELS[status as WorkshopNeedStatus] ?? status;
}

function formatMethod(method: string): string {
  return (
    WORKSHOP_NEED_CALCULATION_METHOD_LABELS[
      method as WorkshopNeedCalculationMethod
    ] ?? method
  );
}

function formatRole(role: string | null): string {
  if (!role) return '—';
  return MATERIAL_ROLE_LABELS[role as MaterialRole] ?? role;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ru-RU');
}

export default async function AdminWorkshopNeedDetailPage({ params }: Params) {
  let need;
  try {
    need = await getWorkshopNeed(params.id);
  } catch (e) {
    if (e instanceof ApiRequestError && e.statusCode === 404) notFound();
    throw e;
  }

  // Этап 5: подгружаем список активных поставщиков и каталог уже
  // выбранного. Грузим только при включённом feature-flag, чтобы
  // выключенный модуль вообще не дёргал /api/suppliers.
  //
  // Ошибки чтения справочника НЕ роняют страницу: показываем форму
  // без селектов и пишем warning-баннер вверху (по тем же принципам,
  // что блок «Заказы клиента» на /admin/clients/[id]).
  let suppliers: SupplierListItemDto[] = [];
  let catalog: SupplierCatalogItemDto[] = [];
  let suppliersError: string | null = null;
  if (FEATURE_SUPPLIERS_ENABLED) {
    try {
      suppliers = await listSuppliers({ status: 'ACTIVE' });
    } catch (e) {
      suppliersError =
        e instanceof ApiRequestError
          ? `Не удалось загрузить поставщиков: ${e.message}${
              e.code ? ` (${e.code})` : ''
            }`
          : 'Не удалось загрузить список поставщиков';
    }
    if (need.selectedSupplierId) {
      try {
        catalog = await listSupplierCatalog(need.selectedSupplierId, {
          status: 'ACTIVE',
        });
      } catch {
        // Поставщик мог быть деактивирован/удалён после привязки. UI
        // в этом случае покажет только селект «Поставщик», без
        // каталога — закупщик сможет очистить связь и выбрать заново.
        catalog = [];
      }
    }
  }

  return (
    <AdminPageShell
      icon={<ClipboardList size={22} strokeWidth={1.6} aria-hidden />}
      title={need.description}
      subtitle={
        need.orderNumber ? `Заказ ${need.orderNumber}` : undefined
      }
      actions={
        <>
          <Link
            href="/admin/workshop-needs"
            className="admin-btn admin-btn--ghost"
          >
            <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />К списку
          </Link>
          <Link
            href={`/admin/orders/${need.orderId}`}
            className="admin-btn"
          >
            <ExternalLink size={16} strokeWidth={1.6} aria-hidden />
            Открыть заказ
          </Link>
          <AdminStatusBadge tone={statusTone(need.status)}>
            {formatStatus(need.status)}
          </AdminStatusBadge>
        </>
      }
    >
      <div className="admin-grid-2">
        <div className="admin-stack">
          <AdminCard>
            <AdminSectionHeader title="Расчётные данные" hint="read-only" />
            <dl className="admin-deflist">
              <dt>Заказ</dt>
              <dd>
                {need.orderNumber ? (
                  <Link
                    href={`/admin/orders/${need.orderId}`}
                    className="admin-table__action-link"
                  >
                    <strong>{need.orderNumber}</strong>
                  </Link>
                ) : (
                  <span className="admin-muted">—</span>
                )}
              </dd>
              <dt>Описание</dt>
              <dd>
                <strong>{need.description}</strong>
              </dd>
              <dt>Роль материала</dt>
              <dd>{formatRole(need.materialRole)}</dd>
              <dt>Характеристика</dt>
              <dd>
                {need.fabricType ?? <span className="admin-muted">—</span>}
              </dd>
              <dt>Плотность</dt>
              <dd>
                {need.densityGsm != null ? (
                  `${need.densityGsm} г/м²`
                ) : (
                  <span className="admin-muted">—</span>
                )}
              </dd>
              <dt>Ширина рулона</dt>
              <dd>
                {need.plannedWidthCm != null ? (
                  `${need.plannedWidthCm} см`
                ) : (
                  <span className="admin-muted">—</span>
                )}
              </dd>
              <dt>Цвет (расчётный)</dt>
              <dd>
                {need.resolvedColorText ?? (
                  <span className="admin-muted">—</span>
                )}
              </dd>
              <dt>Площадь итого</dt>
              <dd>
                {need.totalAreaM2 ? (
                  `${need.totalAreaM2} м²`
                ) : (
                  <span className="admin-muted">—</span>
                )}
              </dd>
              <dt>Поставщик</dt>
              <dd>
                {need.selectedSupplierId ? (
                  <Link
                    href={`/admin/suppliers/${need.selectedSupplierId}`}
                    className="admin-table__action-link"
                  >
                    <strong>{need.selectedSupplierName ?? '—'}</strong>
                  </Link>
                ) : need.supplierNameText ? (
                  <span>{need.supplierNameText}</span>
                ) : (
                  <span className="admin-muted">—</span>
                )}
              </dd>
              <dt>Номенклатура</dt>
              <dd>
                {need.selectedSupplierCatalogItemName ? (
                  <span>
                    <strong>{need.selectedSupplierCatalogItemName}</strong>
                    {need.selectedSupplierCatalogItemArticle && (
                      <>
                        {' '}
                        <code style={{ fontSize: '0.78rem' }}>
                          {need.selectedSupplierCatalogItemArticle}
                        </code>
                      </>
                    )}
                    {need.selectedSupplierCatalogItemLastPrice && (
                      <>
                        {' · '}
                        <span className="admin-muted">
                          {need.selectedSupplierCatalogItemLastPrice}
                          {need.selectedSupplierCatalogItemUnit
                            ? `/${need.selectedSupplierCatalogItemUnit}`
                            : ''}
                        </span>
                      </>
                    )}
                  </span>
                ) : need.purchaseItemNameText ? (
                  <span>{need.purchaseItemNameText}</span>
                ) : (
                  <span className="admin-muted">—</span>
                )}
              </dd>
              <dt>Метод расчёта</dt>
              <dd>{formatMethod(need.calculationMethod)}</dd>
              <dt>Чистая потребность</dt>
              <dd>
                <strong>
                  {need.calculatedQty} {need.unit}
                </strong>
              </dd>
              <dt>Примечание расчёта</dt>
              <dd>
                {need.calculationNote ? (
                  <span>{need.calculationNote}</span>
                ) : (
                  <span className="admin-muted">—</span>
                )}
              </dd>
            </dl>
          </AdminCard>

          <AdminCard>
            <AdminSectionHeader title="Закупка" />
            {suppliersError && (
              <div
                className="error-box"
                role="alert"
                style={{ marginBottom: 8 }}
              >
                {suppliersError}
              </div>
            )}
            <EditWorkshopNeedForm
              need={need}
              suppliersEnabled={FEATURE_SUPPLIERS_ENABLED}
              suppliers={suppliers}
              selectedSupplierCatalog={catalog}
            />
          </AdminCard>

          {FEATURE_PURCHASE_ORDERS_ENABLED && (
            <AdminCard>
              <AdminSectionHeader
                title="Заказ поставщику"
                hint="Этап 6А"
              />
              <p
                className="admin-muted"
                style={{ marginTop: 0, marginBottom: 12, fontSize: '0.85rem' }}
              >
                По строке потребности можно сформировать закупочный
                документ. Этап 6А — без приёмки и без склада.
              </p>
              <CreatePoFromSingleNeed need={need} />
            </AdminCard>
          )}
        </div>

        <div className="admin-stack">
          <AdminTechInfo
            items={[
              { label: 'ID', value: <code>{need.id}</code> },
              { label: 'Заказ ID', value: <code>{need.orderId}</code> },
              {
                label: 'Источник',
                value: need.sourceType ? (
                  <code>{need.sourceType}</code>
                ) : (
                  '—'
                ),
              },
              {
                label: 'Источник ID',
                value: need.sourceId ? <code>{need.sourceId}</code> : '—',
              },
              {
                label: 'Рассчитано',
                value: formatDateTime(need.calculatedAt),
              },
              { label: 'Создано', value: formatDateTime(need.createdAt) },
              { label: 'Обновлено', value: formatDateTime(need.updatedAt) },
            ]}
          />
        </div>
      </div>
    </AdminPageShell>
  );
}
