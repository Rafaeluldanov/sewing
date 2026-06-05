/**
 * Карточка документа приёмки (`/admin/purchase-receipts/[id]`).
 *
 * Этап 7А «Приёмка поставок». Структура — стандартный admin
 * detail-page:
 *   - левая колонка:
 *       1. Шапка PR (snapshot поставщика, статус, receivedAt,
 *          receivedBy);
 *       2. Действия (Отменить, если POSTED);
 *       3. Таблица строк PR с qty/cell/batch/roll/actuals/comment.
 *   - правая колонка:
 *       4. AdminTechInfo (id, purchaseOrderId, customerOrderId,
 *          timestamps).
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowLeft,
  ClipboardCheck,
  ExternalLink,
} from 'lucide-react';
import {
  PURCHASE_RECEIPT_LINE_STATUS_LABELS,
  PURCHASE_RECEIPT_STATUS_LABELS,
  type PurchaseReceiptLineDto,
  type PurchaseReceiptLineStatus,
  type PurchaseReceiptStatus,
} from '@sewing/shared/purchase-receipts';
import type { CellDetailDto } from '@sewing/shared/passports';
import { ApiRequestError } from '@/lib/api';
import { getPurchaseReceipt } from '@/lib/purchase-receipts-api';
import { listCells } from '@/lib/passports-api';
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
import type { AdminStatusTone } from '@/lib/admin-labels';
import { CancelPurchaseReceiptForm } from './cancel-form';
import { PostPurchaseReceiptForm } from './post-form';
import { EditPurchaseReceiptLineForm } from './edit-line-form';

export const dynamic = 'force-dynamic';

interface Params {
  params: { id: string };
}

function statusTone(status: string): AdminStatusTone {
  switch (status as PurchaseReceiptStatus) {
    case 'DRAFT':
      return 'info';
    case 'POSTED':
      return 'success';
    case 'CANCELLED':
      return 'danger';
    default:
      return 'muted';
  }
}

function formatStatus(status: string): string {
  return (
    PURCHASE_RECEIPT_STATUS_LABELS[status as PurchaseReceiptStatus] ?? status
  );
}

function lineStatusTone(status: string): AdminStatusTone {
  switch (status as PurchaseReceiptLineStatus) {
    case 'DRAFT':
      return 'info';
    case 'POSTED':
      return 'success';
    case 'CANCELLED':
      return 'danger';
    default:
      return 'muted';
  }
}

function formatLineStatus(status: string): string {
  return (
    PURCHASE_RECEIPT_LINE_STATUS_LABELS[
      status as PurchaseReceiptLineStatus
    ] ?? status
  );
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ru-RU');
}

export default async function AdminPurchaseReceiptDetailPage({
  params,
}: Params) {
  let pr;
  try {
    pr = await getPurchaseReceipt(params.id);
  } catch (e) {
    if (e instanceof ApiRequestError && e.statusCode === 404) notFound();
    throw e;
  }

  const isDraft = pr.status === 'DRAFT';
  const isEditable = pr.status !== 'CANCELLED';

  // Ячейки нужны только для правки складских полей черновика.
  let cellOptions: { id: string; code: string; warehouseName: string | null }[] =
    [];
  if (isDraft) {
    let cells: CellDetailDto[] = [];
    try {
      cells = await listCells();
    } catch {
      cells = [];
    }
    cellOptions = cells
      .filter((c) => c.active)
      .map((c) => ({
        id: c.id,
        code: c.code,
        warehouseName: c.warehouse?.name ?? null,
      }))
      .sort((a, b) => a.code.localeCompare(b.code, 'ru'));
  }

  const activeLines = pr.lines.filter((l) => l.status !== 'CANCELLED');

  return (
    <AdminPageShell
      icon={<ClipboardCheck size={22} strokeWidth={1.6} aria-hidden />}
      title={`Приёмка ${pr.number}`}
      subtitle={pr.supplierNameSnapshot ?? undefined}
      actions={
        <>
          <Link
            href="/admin/purchase-receipts"
            className="admin-btn admin-btn--ghost"
          >
            <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />К списку
          </Link>
          <Link
            href={`/admin/purchase-orders/${pr.purchaseOrderId}`}
            className="admin-btn"
          >
            <ExternalLink size={16} strokeWidth={1.6} aria-hidden />
            Открыть заказ поставщику
          </Link>
          {pr.customerOrderId && (
            <Link
              href={`/admin/orders/${pr.customerOrderId}`}
              className="admin-btn"
            >
              <ExternalLink size={16} strokeWidth={1.6} aria-hidden />
              Заказ покупателя
            </Link>
          )}
          <AdminStatusBadge tone={statusTone(pr.status)}>
            {formatStatus(pr.status)}
          </AdminStatusBadge>
        </>
      }
    >
      <div className="admin-grid-2">
        <div className="admin-stack">
          <AdminCard>
            <AdminSectionHeader
              title="Шапка приёмки"
              hint="snapshot поставщика"
            />
            <dl className="admin-deflist">
              <dt>Номер</dt>
              <dd>
                <strong>{pr.number}</strong>
              </dd>
              <dt>Статус</dt>
              <dd>
                <AdminStatusBadge tone={statusTone(pr.status)}>
                  {formatStatus(pr.status)}
                </AdminStatusBadge>
              </dd>
              <dt>Заказ поставщику</dt>
              <dd>
                <Link
                  href={`/admin/purchase-orders/${pr.purchaseOrderId}`}
                  className="admin-table__action-link"
                >
                  <strong>{pr.purchaseOrderNumber}</strong>
                </Link>
              </dd>
              <dt>Поставщик</dt>
              <dd>
                {pr.supplierId && pr.supplierNameSnapshot ? (
                  <Link
                    href={`/admin/suppliers/${pr.supplierId}`}
                    className="admin-table__action-link"
                  >
                    <strong>{pr.supplierNameSnapshot}</strong>
                  </Link>
                ) : pr.supplierNameSnapshot ? (
                  <strong>{pr.supplierNameSnapshot}</strong>
                ) : (
                  <span className="admin-muted">—</span>
                )}
              </dd>
              <dt>Телефон</dt>
              <dd>
                {pr.supplierPhoneSnapshot ?? (
                  <span className="admin-muted">—</span>
                )}
              </dd>
              <dt>Сайт</dt>
              <dd>
                {pr.supplierWebsiteSnapshot ?? (
                  <span className="admin-muted">—</span>
                )}
              </dd>
              <dt>Адрес</dt>
              <dd>
                {pr.supplierAddressSnapshot ?? (
                  <span className="admin-muted">—</span>
                )}
              </dd>
              <dt>Заказ покупателя</dt>
              <dd>
                {pr.customerOrderId && pr.customerOrderNumber ? (
                  <Link
                    href={`/admin/orders/${pr.customerOrderId}`}
                    className="admin-table__action-link"
                  >
                    <strong>{pr.customerOrderNumber}</strong>
                  </Link>
                ) : (
                  <span className="admin-muted">—</span>
                )}
              </dd>
              <dt>Принято</dt>
              <dd>{formatDateTime(pr.receivedAt)}</dd>
              <dt>Кто принял</dt>
              <dd>
                {pr.receivedByName ?? (
                  <span className="admin-muted">—</span>
                )}
              </dd>
              <dt>Сумма принятого</dt>
              <dd>
                {pr.totalReceivedQty ? (
                  <strong>{pr.totalReceivedQty}</strong>
                ) : (
                  <span className="admin-muted">—</span>
                )}
              </dd>
              <dt>Отменено</dt>
              <dd>{formatDateTime(pr.cancelledAt)}</dd>
              <dt>Комментарий</dt>
              <dd>
                {pr.comment ? (
                  <span>{pr.comment}</span>
                ) : (
                  <span className="admin-muted">—</span>
                )}
              </dd>
            </dl>
          </AdminCard>

          {isEditable && (
            <AdminCard>
              <AdminSectionHeader
                title="Действия"
                hint={isDraft ? 'черновик' : undefined}
              />
              {isDraft && (
                <>
                  <p className="admin-muted" style={{ marginTop: 0 }}>
                    Черновик ещё не отражён на складе и не двигает
                    статусы заказа. Отредактируйте строки ниже и
                    проведите приёмку.
                  </p>
                  <div style={{ marginBottom: 12 }}>
                    <PostPurchaseReceiptForm id={pr.id} />
                  </div>
                </>
              )}
              <CancelPurchaseReceiptForm id={pr.id} />
            </AdminCard>
          )}

          <AdminCard>
            <AdminSectionHeader
              title="Строки приёмки"
              hint={`${pr.lines.length}`}
            />
            <PurchaseReceiptLinesTable lines={pr.lines} />
          </AdminCard>

          {isEditable && activeLines.length > 0 && (
            <AdminCard>
              <AdminSectionHeader
                title="Редактирование строк"
                hint={
                  isDraft
                    ? 'черновик: можно менять всё'
                    : 'проведено: только метаданные'
                }
              />
              {!isDraft && (
                <p className="admin-muted" style={{ marginTop: 0 }}>
                  Количество и ячейку у проведённой приёмки изменить
                  нельзя — они уже на складе. Чтобы их поправить,
                  отмените приёмку и оформите заново.
                </p>
              )}
              <div className="admin-stack">
                {activeLines.map((line) => (
                  <EditPurchaseReceiptLineForm
                    key={line.id}
                    receiptId={pr.id}
                    line={line}
                    editableStock={isDraft}
                    cells={cellOptions}
                  />
                ))}
              </div>
            </AdminCard>
          )}
        </div>

        <div className="admin-stack">
          <AdminTechInfo
            items={[
              { label: 'ID', value: <code>{pr.id}</code> },
              {
                label: 'PO ID',
                value: <code>{pr.purchaseOrderId}</code>,
              },
              {
                label: 'Поставщик ID',
                value: pr.supplierId ? <code>{pr.supplierId}</code> : '—',
              },
              {
                label: 'Заказ покупателя ID',
                value: pr.customerOrderId ? (
                  <code>{pr.customerOrderId}</code>
                ) : (
                  '—'
                ),
              },
              { label: 'Raw status', value: <code>{pr.status}</code> },
              { label: 'Создан', value: formatDateTime(pr.createdAt) },
              { label: 'Обновлён', value: formatDateTime(pr.updatedAt) },
            ]}
          />
        </div>
      </div>
    </AdminPageShell>
  );
}

function PurchaseReceiptLinesTable({
  lines,
}: {
  lines: PurchaseReceiptLineDto[];
}) {
  if (lines.length === 0) {
    return (
      <AdminEmptyState
        icon={<ClipboardCheck size={26} strokeWidth={1.6} aria-hidden />}
        title="В приёмке нет строк"
      />
    );
  }
  const columns: AdminTableColumn<PurchaseReceiptLineDto>[] = [
    {
      key: 'name',
      header: 'Позиция',
      render: (l) => (
        <div>
          <div>
            <strong>{l.itemNameSnapshot}</strong>
          </div>
          {l.supplierArticleSnapshot && (
            <div
              className="admin-muted"
              style={{ fontSize: '0.78rem', marginTop: 2 }}
            >
              арт. {l.supplierArticleSnapshot}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'qty',
      header: 'Принято',
      align: 'right',
      render: (l) => (
        <div>
          <strong>{l.receivedQty}</strong> {l.unit}
          {l.confirmedQtySnapshot || l.orderedQtySnapshot ? (
            <div
              className="admin-muted"
              style={{ fontSize: '0.78rem', marginTop: 2 }}
            >
              из{' '}
              {l.confirmedQtySnapshot ?? l.orderedQtySnapshot} {l.unitSnapshot}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      key: 'price',
      header: 'Цена',
      align: 'right',
      render: (l) =>
        l.priceSnapshot ? (
          <span>
            {l.priceSnapshot}
            {l.currencySnapshot ? ` ${l.currencySnapshot}` : ''}
          </span>
        ) : (
          <span className="admin-muted">—</span>
        ),
    },
    {
      key: 'cell',
      header: 'Ячейка',
      render: (l) => {
        if (!l.cellId) {
          return l.locationNote ? (
            <span className="admin-muted" style={{ fontSize: '0.85rem' }}>
              {l.locationNote}
            </span>
          ) : (
            <span className="admin-muted">—</span>
          );
        }
        return (
          <div>
            <div>
              <strong>{l.cellCode ?? l.cellId}</strong>
            </div>
            {(l.warehouseName || l.lineName) && (
              <div
                className="admin-muted"
                style={{ fontSize: '0.78rem', marginTop: 2 }}
              >
                {[l.warehouseName, l.lineName ? `линия ${l.lineName}` : null]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            )}
            {l.locationNote && (
              <div
                className="admin-muted"
                style={{ fontSize: '0.78rem', marginTop: 2 }}
              >
                {l.locationNote}
              </div>
            )}
          </div>
        );
      },
    },
    {
      key: 'batch',
      header: 'Партия / рулон',
      render: (l) => {
        const parts: string[] = [];
        if (l.batchNumber) parts.push(`партия ${l.batchNumber}`);
        if (l.rollNumber) parts.push(`рулон ${l.rollNumber}`);
        if (l.shade) parts.push(`оттенок ${l.shade}`);
        return parts.length === 0 ? (
          <span className="admin-muted">—</span>
        ) : (
          <span style={{ fontSize: '0.85rem' }}>{parts.join(' · ')}</span>
        );
      },
    },
    {
      key: 'actuals',
      header: 'Факт',
      render: (l) => {
        const parts: string[] = [];
        if (l.actualWidthCm != null)
          parts.push(`ширина ${l.actualWidthCm} см`);
        if (l.actualDensityGsm != null)
          parts.push(`${l.actualDensityGsm} г/м²`);
        return parts.length === 0 ? (
          <span className="admin-muted">—</span>
        ) : (
          <span style={{ fontSize: '0.85rem' }}>{parts.join(' · ')}</span>
        );
      },
    },
    {
      key: 'status',
      header: 'Статус',
      render: (l) => (
        <AdminStatusBadge tone={lineStatusTone(l.status)}>
          {formatLineStatus(l.status)}
        </AdminStatusBadge>
      ),
    },
    {
      key: 'comment',
      header: 'Комментарий',
      render: (l) =>
        l.comment ? (
          <span style={{ fontSize: '0.85rem' }}>{l.comment}</span>
        ) : (
          <span className="admin-muted">—</span>
        ),
    },
  ];
  return (
    <AdminTable rows={lines} columns={columns} rowKey={(l) => l.id} />
  );
}
