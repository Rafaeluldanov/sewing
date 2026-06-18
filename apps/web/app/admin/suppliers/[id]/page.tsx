/**
 * Карточка поставщика (`/admin/suppliers/[id]`, Этап 5).
 *
 * Структура — стандартный admin detail-page:
 *   - две колонки на desktop, одна на mobile (`.admin-grid-2`):
 *     Левая: «Основное», «Контакты», «Номенклатура», форма
 *            редактирования основной карточки.
 *     Правая: «Техническая информация» (id/createdAt/updatedAt).
 *
 * Контакты и каталог управляются inline-формами (`ContactsSection` /
 * `CatalogSection`) — каждая позиция имеет собственный form action,
 * чтобы изменения одной строки не теряли изменений другой.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ContactRound, PackageSearch, Truck } from 'lucide-react';
import {
  SUPPLIER_STATUS_LABELS,
  type SupplierStatus,
} from '@sewing/shared/suppliers';
import type { CashFlowItemDto } from '@sewing/shared/treasury';
import { ApiRequestError } from '@/lib/api';
import { getSupplier } from '@/lib/suppliers-api';
import { listCashFlowItems } from '@/lib/treasury-api';
import {
  AdminCard,
  AdminPageShell,
  AdminSectionHeader,
  AdminStatusBadge,
  AdminTechInfo,
} from '@/components/admin';
import type { AdminStatusTone } from '@/lib/admin-labels';
import { CatalogSection } from './catalog-section';
import { ContactsSection } from './contacts-section';
import { DeleteSupplierCard } from './delete-supplier-card';
import { EditSupplierForm } from './edit-form';

export const dynamic = 'force-dynamic';

function statusTone(status: string): AdminStatusTone {
  switch (status as SupplierStatus) {
    case 'ACTIVE':
      return 'success';
    case 'INACTIVE':
      return 'muted';
    default:
      return 'muted';
  }
}

function formatStatus(status: string): string {
  return SUPPLIER_STATUS_LABELS[status as SupplierStatus] ?? status;
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('ru-RU');
}

export default async function AdminSupplierDetailPage({
  params,
}: {
  params: { id: string };
}) {
  let supplier;
  try {
    supplier = await getSupplier(params.id);
  } catch (e) {
    if (e instanceof ApiRequestError && e.statusCode === 404) {
      notFound();
    }
    throw e;
  }

  // Активные статьи ДДС для выпадающего списка в форме. Падение
  // казначейства не должно ронять карточку поставщика — деградируем
  // до пустого списка (поле просто покажет «— не выбрана —»).
  let cashFlowItems: CashFlowItemDto[] = [];
  try {
    cashFlowItems = await listCashFlowItems({ activeOnly: true });
  } catch {
    cashFlowItems = [];
  }

  return (
    <AdminPageShell
      icon={<Truck size={22} strokeWidth={1.6} aria-hidden />}
      title={supplier.name}
      subtitle="Управленческая карточка поставщика"
      actions={
        <>
          <Link href="/admin/suppliers" className="admin-btn admin-btn--ghost">
            <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />К списку
          </Link>
          <AdminStatusBadge tone={statusTone(supplier.status)}>
            {formatStatus(supplier.status)}
          </AdminStatusBadge>
        </>
      }
    >
      <div className="admin-grid-2">
        <div className="admin-stack">
          <AdminCard>
            <AdminSectionHeader title="Основное" />
            <dl className="admin-deflist">
              <dt>Название</dt>
              <dd>{supplier.name}</dd>
              <dt>Телефон</dt>
              <dd>
                {supplier.phone ?? <span className="admin-muted">—</span>}
              </dd>
              <dt>Сайт</dt>
              <dd>
                {supplier.website ?? <span className="admin-muted">—</span>}
              </dd>
              <dt>Адрес</dt>
              <dd>
                {supplier.address ?? <span className="admin-muted">—</span>}
              </dd>
              <dt>Комментарий</dt>
              <dd>
                {supplier.comment ?? <span className="admin-muted">—</span>}
              </dd>
              <dt>Статья ДДС</dt>
              <dd>
                {supplier.defaultCashFlowItemName ?? (
                  <span className="admin-muted">—</span>
                )}
              </dd>
              <dt>Статус</dt>
              <dd>
                <AdminStatusBadge tone={statusTone(supplier.status)}>
                  {formatStatus(supplier.status)}
                </AdminStatusBadge>
              </dd>
            </dl>
          </AdminCard>

          <AdminCard>
            <AdminSectionHeader
              icon={<ContactRound size={18} strokeWidth={1.7} aria-hidden />}
              title="Контакты менеджеров"
              hint={
                supplier.contacts.length > 0
                  ? `${supplier.contacts.length}`
                  : undefined
              }
            />
            <ContactsSection
              supplierId={supplier.id}
              contacts={supplier.contacts}
            />
          </AdminCard>

          <AdminCard>
            <AdminSectionHeader
              icon={<PackageSearch size={18} strokeWidth={1.7} aria-hidden />}
              title="Номенклатура"
              hint={
                supplier.catalogItems.length > 0
                  ? `${supplier.catalogItems.length}`
                  : undefined
              }
            />
            <CatalogSection
              supplierId={supplier.id}
              items={supplier.catalogItems}
            />
          </AdminCard>

          <AdminCard>
            <AdminSectionHeader title="Редактирование" />
            <EditSupplierForm
              supplier={supplier}
              cashFlowItems={cashFlowItems}
            />
          </AdminCard>

          <AdminCard>
            <AdminSectionHeader title="Удаление" />
            <DeleteSupplierCard
              supplierId={supplier.id}
              supplierName={supplier.name}
            />
          </AdminCard>
        </div>

        <div className="admin-stack">
          <AdminTechInfo
            items={[
              { label: 'ID', value: <code>{supplier.id}</code> },
              { label: 'Создан', value: formatDateTime(supplier.createdAt) },
              {
                label: 'Обновлён',
                value: formatDateTime(supplier.updatedAt),
              },
              {
                label: 'Контактов',
                value: String(supplier.contactsCount),
              },
              {
                label: 'Позиций каталога',
                value: String(supplier.catalogItemsCount),
              },
            ]}
          />
        </div>
      </div>
    </AdminPageShell>
  );
}
