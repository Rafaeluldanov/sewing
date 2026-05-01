import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowLeft,
  LayoutGrid,
  Printer,
  Warehouse as WarehouseIcon,
} from 'lucide-react';
import { ApiRequestError } from '@/lib/api';
import { listCells } from '@/lib/passports-api';
import { listPrinters } from '@/lib/printers-api';
import { getWarehouse } from '@/lib/warehouses-api';
import type { CellDetailDto } from '@sewing/shared/passports';
import type { PrinterSummaryDto } from '@sewing/shared/printers';
import {
  AdminCard,
  AdminEmptyState,
  AdminPageShell,
  AdminSectionHeader,
  AdminStatusBadge,
  AdminTable,
  AdminTechInfo,
  type AdminTableColumn,
} from '@/components/admin';
import { formatStatus, statusTone } from '@/lib/admin-labels';
import { WarehouseBulkPrintPanel } from './bulk-print-panel';
import {
  AssignCellForm,
  CreateLineForm,
  DetachCellButton,
  WarehouseEditForm,
} from './edit-form';

export const dynamic = 'force-dynamic';

interface Params {
  params: { id: string };
}

interface CellRow {
  id: string;
  code: string;
  qrCode: string;
  active: boolean;
  printUrl: string;
  warehouseId: string;
}

/**
 * Карточка склада (Admin UI 2.5, см. ADR-0019).
 *
 * Backend / DTO не меняем. Структура — единый стандарт detail-pages:
 *   - AdminPageShell сверху;
 *   - карточка «Реквизиты», карточки «Линии» и «Ячейки» с AdminTable;
 *   - привязка ячейки + создание линии — отдельные компактные
 *     карточки;
 *   - технические id/code/qr спрятаны в AdminTechInfo.
 */
export default async function AdminWarehouseDetailPage({ params }: Params) {
  let warehouse;
  try {
    warehouse = await getWarehouse(params.id);
  } catch (e) {
    if (e instanceof ApiRequestError && e.statusCode === 404) {
      notFound();
    }
    throw e;
  }

  let allCells: CellDetailDto[] = [];
  try {
    allCells = await listCells();
  } catch {
    allCells = [];
  }
  const attachedIds = new Set(warehouse.cells.map((c) => c.id));
  const availableCells = allCells.filter((c) => !attachedIds.has(c.id));

  let printers: PrinterSummaryDto[] = [];
  try {
    printers = await listPrinters();
  } catch {
    printers = [];
  }

  const lineColumns: AdminTableColumn<{
    id: string;
    code: string;
    cellsCount: number;
    createdAt: string;
  }>[] = [
    {
      key: 'code',
      header: 'Код линии',
      render: (l) => <span className="admin-table__primary">{l.code}</span>,
    },
    {
      key: 'cells',
      header: 'Ячеек',
      align: 'right',
      render: (l) => l.cellsCount,
    },
    {
      key: 'createdAt',
      header: 'Создана',
      render: (l) => (
        <span className="admin-muted" style={{ fontSize: '0.85rem' }}>
          {new Date(l.createdAt).toLocaleString('ru-RU')}
        </span>
      ),
    },
  ];

  const cellColumns: AdminTableColumn<CellRow>[] = [
    {
      key: 'code',
      header: 'Код',
      render: (c) => <span className="admin-table__primary">{c.code}</span>,
    },
    {
      key: 'status',
      header: 'Статус',
      render: (c) => (
        <AdminStatusBadge tone={statusTone(c.active)}>
          {formatStatus(c.active)}
        </AdminStatusBadge>
      ),
    },
    {
      key: 'actions',
      header: '',
      isAction: true,
      render: (c) => (
        <div style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          <a
            href={c.printUrl}
            className="admin-btn"
            target="_blank"
            rel="noopener noreferrer"
            title="Открыть печатную форму QR-этикетки"
          >
            <Printer size={14} strokeWidth={1.6} aria-hidden />
            Печать
          </a>
          <DetachCellButton warehouseId={c.warehouseId} cellId={c.id} />
        </div>
      ),
    },
  ];

  const cellRows: CellRow[] = warehouse.cells.map((c) => ({
    id: c.id,
    code: c.code,
    qrCode: c.qrCode,
    active: c.active,
    printUrl: c.printUrl,
    warehouseId: warehouse.id,
  }));

  return (
    <AdminPageShell
      icon={<WarehouseIcon size={22} strokeWidth={1.6} aria-hidden />}
      title={warehouse.name}
      subtitle={`${warehouse.lines.length} линий · ${warehouse.cellsCount} ячеек`}
      actions={
        <>
          <Link href="/admin/warehouses" className="admin-btn admin-btn--ghost">
            <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />
            К списку
          </Link>
          <AdminStatusBadge tone={statusTone(warehouse.isActive)}>
            {formatStatus(warehouse.isActive)}
          </AdminStatusBadge>
        </>
      }
    >
      <div className="admin-grid-2">
        <div className="admin-stack">
          <AdminCard>
            <AdminSectionHeader title="Реквизиты склада" />
            <WarehouseEditForm warehouse={warehouse} />
          </AdminCard>

          <AdminCard>
            <AdminSectionHeader
              title="Линии склада"
              hint={
                warehouse.lines.length > 0
                  ? `${warehouse.lines.length}`
                  : undefined
              }
            />
            {warehouse.lines.length === 0 ? (
              <AdminEmptyState
                icon={<LayoutGrid size={26} strokeWidth={1.6} aria-hidden />}
                title="Линий ещё нет"
                hint="Создайте первую — это удобный способ массово развернуть ячейки одной серии."
              />
            ) : (
              <AdminTable
                rows={warehouse.lines}
                columns={lineColumns}
                rowKey={(l) => l.id}
              />
            )}
          </AdminCard>

          <AdminCard>
            <AdminSectionHeader title="Ячейки склада" />
            <div className="admin-actions-row admin-actions-row--split" style={{ marginTop: -8 }}>
              <span className="admin-muted" style={{ fontSize: '0.88rem' }}>
                Всего: {warehouse.cells.length}
              </span>
              <WarehouseBulkPrintPanel
                warehouse={warehouse}
                printers={printers}
              />
            </div>
            {warehouse.cells.length === 0 ? (
              <AdminEmptyState
                icon={<WarehouseIcon size={26} strokeWidth={1.6} aria-hidden />}
                title="Ячеек пока нет"
                hint="Создайте линию выше или привяжите существующую ячейку."
              />
            ) : (
              <AdminTable
                rows={cellRows}
                columns={cellColumns}
                rowKey={(c) => c.id}
              />
            )}
          </AdminCard>
        </div>

        <div className="admin-stack">
          <AdminCard>
            <AdminSectionHeader title="Создать линию" />
            <p className="admin-muted" style={{ margin: 0, fontSize: '0.88rem' }}>
              Шаблон <code>A1..A20</code>: укажите код линии и количество.
            </p>
            <CreateLineForm warehouseId={warehouse.id} />
          </AdminCard>

          <AdminCard>
            <AdminSectionHeader title="Привязать ячейку" />
            <p className="admin-muted" style={{ margin: 0, fontSize: '0.88rem' }}>
              Существующая ячейка из общего списка. Перевяжется явно
              даже если уже была привязана к другому складу.
            </p>
            <AssignCellForm
              warehouseId={warehouse.id}
              availableCells={availableCells}
            />
          </AdminCard>

          <AdminTechInfo
            items={[
              { label: 'ID', value: <code>{warehouse.id}</code> },
              {
                label: 'Код',
                value: warehouse.code ? <code>{warehouse.code}</code> : '—',
              },
              { label: 'Линий', value: warehouse.lines.length },
              { label: 'Ячеек', value: warehouse.cellsCount },
            ]}
          />
        </div>
      </div>
    </AdminPageShell>
  );
}
