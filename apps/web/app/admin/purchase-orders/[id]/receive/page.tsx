/**
 * Страница «Принять поступление» по `PurchaseOrder`
 * (`/admin/purchase-orders/[id]/receive`).
 *
 * Этап 7А «Приёмка поставок». Серверный компонент: загружает PO,
 * список ячеек (`/api/cells`) и уже принятые суммы по каждой
 * строке (`/api/purchase-orders/:id/receipts`). Если PO в
 * `DRAFT`/`CANCELLED`/`RECEIVED` (полностью закрыт) — показываем
 * заглушку и не даём открыть форму.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowLeft,
  ClipboardCheck,
  ShoppingCart,
} from 'lucide-react';
import {
  PURCHASE_ORDER_RECEIVABLE_STATUSES,
  PURCHASE_ORDER_STATUS_LABELS,
  type PurchaseOrderDetailDto,
  type PurchaseOrderStatus,
} from '@sewing/shared/purchase-orders';
import type { PurchaseReceiptListItemDto } from '@sewing/shared/purchase-receipts';
import type { CellDetailDto } from '@sewing/shared/passports';
import { ApiRequestError } from '@/lib/api';
import { getPurchaseOrder } from '@/lib/purchase-orders-api';
import {
  getPurchaseOrderReceipts,
  getPurchaseReceipt,
} from '@/lib/purchase-receipts-api';
import { listCells } from '@/lib/passports-api';
import {
  AdminCard,
  AdminPageShell,
  AdminSectionHeader,
  AdminStatusBadge,
} from '@/components/admin';
import type { AdminStatusTone } from '@/lib/admin-labels';
import { ReceivePurchaseOrderForm } from './receive-form';

export const dynamic = 'force-dynamic';

interface Params {
  params: { id: string };
}

function statusTone(status: string): AdminStatusTone {
  switch (status as PurchaseOrderStatus) {
    case 'DRAFT':
      return 'info';
    case 'SENT':
      return 'warning';
    case 'CONFIRMED':
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
  return (
    PURCHASE_ORDER_STATUS_LABELS[status as PurchaseOrderStatus] ?? status
  );
}

export default async function AdminPurchaseOrderReceivePage({
  params,
}: Params) {
  let po: PurchaseOrderDetailDto;
  try {
    po = await getPurchaseOrder(params.id);
  } catch (e) {
    if (e instanceof ApiRequestError && e.statusCode === 404) notFound();
    throw e;
  }

  // Принимать можно только из SENT/CONFIRMED/PARTIALLY_RECEIVED.
  // RECEIVED тоже не принимаем — формально «всё уже получено», но
  // если backend всё-таки разрешит (например, частичная отмена и
  // повторная приёмка), можно зайти повторно через action; на UI
  // же на этом MVP мы блокируем.
  const canReceive = (
    PURCHASE_ORDER_RECEIVABLE_STATUSES as readonly string[]
  ).includes(po.status);

  // Загружаем уже принятые суммы по каждой строке PO. Если backend
  // упал — не валим страницу, просто не показываем «уже принято».
  let posted: PurchaseReceiptListItemDto[] = [];
  try {
    posted = await getPurchaseOrderReceipts(po.id);
  } catch {
    posted = [];
  }
  // Считаем суммы. Чтобы не дёргать N+1 на каждую строку, грузим
  // detail-DTO каждой POSTED-приёмки и суммируем по lineId.
  const receivedByLineId: Record<string, { receivedSum: string | null }> = {};
  if (canReceive && posted.length > 0) {
    const detailPromises = posted
      .filter((p) => p.status === 'POSTED')
      .map((p) => getPurchaseReceipt(p.id).catch(() => null));
    const details = await Promise.all(detailPromises);
    for (const detail of details) {
      if (!detail) continue;
      for (const line of detail.lines) {
        if (line.status !== 'POSTED') continue;
        if (!line.purchaseOrderLineId) continue;
        const entry = receivedByLineId[line.purchaseOrderLineId] ?? {
          receivedSum: null,
        };
        const prev = entry.receivedSum
          ? Number.parseFloat(entry.receivedSum)
          : 0;
        const cur = Number.parseFloat(line.receivedQty);
        if (Number.isFinite(prev + cur)) {
          // Простое сложение по float — это только для отображения
          // подсказки «уже принято». Backend всё равно использует
          // Decimal-арифметику.
          entry.receivedSum = String(prev + cur);
        }
        receivedByLineId[line.purchaseOrderLineId] = entry;
      }
    }
  }

  // Загружаем активные ячейки. Ошибка чтения не валит страницу —
  // селект просто будет пустым.
  let cells: CellDetailDto[] = [];
  if (canReceive) {
    try {
      cells = await listCells();
    } catch {
      cells = [];
    }
  }
  const cellOptions = cells
    .filter((c) => c.active)
    .map((c) => ({
      id: c.id,
      code: c.code,
      warehouseName: c.warehouse?.name ?? null,
    }))
    .sort((a, b) => a.code.localeCompare(b.code, 'ru'));

  return (
    <AdminPageShell
      icon={<ClipboardCheck size={22} strokeWidth={1.6} aria-hidden />}
      title={`Принять поступление по ${po.number}`}
      subtitle={po.supplierNameSnapshot}
      actions={
        <>
          <Link
            href={`/admin/purchase-orders/${po.id}`}
            className="admin-btn admin-btn--ghost"
          >
            <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />К заказу
          </Link>
          <AdminStatusBadge tone={statusTone(po.status)}>
            {formatStatus(po.status)}
          </AdminStatusBadge>
        </>
      }
    >
      {!canReceive ? (
        <AdminCard>
          <AdminSectionHeader title="Приёмка недоступна" />
          <p className="admin-muted" style={{ marginTop: 4 }}>
            Принимать можно только заказ поставщику в статусе SENT,
            CONFIRMED или PARTIALLY_RECEIVED. Текущий статус:{' '}
            <strong>{formatStatus(po.status)}</strong>.
          </p>
          <div className="admin-actions-row" style={{ marginTop: 12 }}>
            <Link
              href={`/admin/purchase-orders/${po.id}`}
              className="admin-btn"
            >
              <ShoppingCart size={16} strokeWidth={1.6} aria-hidden />
              Открыть заказ поставщику
            </Link>
          </div>
        </AdminCard>
      ) : (
        <AdminCard>
          <AdminSectionHeader
            title="Документ приёмки"
            hint={`Строк к приёмке: ${po.lines.filter((l) => l.status !== 'CANCELLED').length}`}
          />
          <ReceivePurchaseOrderForm
            po={po}
            cells={cellOptions}
            receivedByLineId={receivedByLineId}
          />
        </AdminCard>
      )}
    </AdminPageShell>
  );
}
