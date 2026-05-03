/**
 * `MaterialIssuesTable` — таблица документов «Фактический расход
 * материалов» в карточке заказа (вкладка «Потребности»,
 * `MaterialIssuesSection`).
 *
 * Колонки:
 *   - дата создания;
 *   - статус (DRAFT / POSTED / CANCELLED);
 *   - паспорт (если привязан);
 *   - кол-во строк;
 *   - сумма документа (decimal-as-string → RUB);
 *   - дата проведения (`postedAt`, `—` для DRAFT/CANCELLED);
 *   - действия:
 *       DRAFT     → «Провести» + «Отменить» (только для ADMIN/SHOP_MANAGER);
 *       POSTED    → read-only;
 *       CANCELLED → read-only.
 *
 * Preview строк (описание / кол-во / цена / сумма / ячейка) живёт в
 * компоненте `MaterialIssueLinesPreview` и рендерится под строкой —
 * родитель (`MaterialIssuesSection`) передаёт `issueDetails` (мапу
 * `id → MaterialIssueDetailDto`), потому что list-endpoint не
 * возвращает строки (только `linesCount`).
 *
 * Компонент server-safe: никаких `useState` / `useEffect`; action-
 * кнопки — отдельные client-компоненты.
 */
import type {
  MaterialIssueDetailDto,
  MaterialIssueListItemDto,
} from '@sewing/shared/material-issues';
import {
  AdminTable,
  type AdminTableColumn,
} from '@/components/admin';
import { formatDateRu } from '@/lib/date-format';
import { CancelMaterialIssueButton } from './cancel-material-issue-button';
import { MaterialIssueLinesPreview } from './material-issue-lines-preview';
import { MaterialIssueStatusBadge } from './material-issue-status-badge';
import { PostMaterialIssueButton } from './post-material-issue-button';

interface Props {
  orderId: string;
  items: MaterialIssueListItemDto[];
  /**
   * Мапа id → детальный документ (для preview-строк). Родитель
   * загружает детали параллельно со списком. Если деталь не
   * подгрузилась — preview не рендерится, строка остаётся компактной.
   */
  issueDetails?: Record<string, MaterialIssueDetailDto | undefined>;
  /**
   * RBAC-флаг «пользователь может управлять» (ADMIN / SHOP_MANAGER).
   * Если `false`, таблица рендерится read-only — кнопки действий
   * отсутствуют и для DRAFT.
   */
  canManage: boolean;
}

const RUB_FORMATTER = new Intl.NumberFormat('ru-RU', {
  style: 'currency',
  currency: 'RUB',
  maximumFractionDigits: 2,
});

function formatRub(value: string | number | null | undefined): string {
  if (value == null || value === '') return '—';
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return '—';
  return RUB_FORMATTER.format(n);
}

export function MaterialIssuesTable({
  orderId,
  items,
  issueDetails,
  canManage,
}: Props) {
  const columns: AdminTableColumn<MaterialIssueListItemDto>[] = [
    {
      key: 'createdAt',
      header: 'Создан',
      render: (row) => <span>{formatDateRu(row.createdAt)}</span>,
    },
    {
      key: 'status',
      header: 'Статус',
      render: (row) => <MaterialIssueStatusBadge status={row.status} />,
    },
    {
      key: 'passport',
      header: 'Паспорт',
      render: (row) => <span>{row.passportNumber ?? '—'}</span>,
    },
    {
      key: 'linesCount',
      header: 'Строк',
      align: 'right',
      render: (row) => <span>{row.linesCount}</span>,
    },
    {
      key: 'totalCost',
      header: 'Сумма',
      align: 'right',
      render: (row) => <span>{formatRub(row.totalCost)}</span>,
    },
    {
      key: 'postedAt',
      header: 'Проведён',
      render: (row) => <span>{formatDateRu(row.postedAt)}</span>,
    },
    {
      key: 'actions',
      header: '',
      isAction: true,
      render: (row) => {
        if (!canManage) return <span aria-hidden>—</span>;
        if (row.status === 'DRAFT') {
          return (
            <div
              style={{
                display: 'flex',
                gap: 6,
                flexWrap: 'wrap',
                justifyContent: 'flex-end',
              }}
            >
              <PostMaterialIssueButton orderId={orderId} id={row.id} />
              <CancelMaterialIssueButton orderId={orderId} id={row.id} />
            </div>
          );
        }
        return <span aria-hidden>—</span>;
      },
    },
  ];

  // Рендерим таблицу + preview строк в виде секций. `AdminTable`
  // не поддерживает row-expand из коробки, поэтому сборку делаем
  // вручную: таблица сверху + отдельные блоки с preview под ней.
  // Для MVP этого достаточно — документов на заказе мало.
  return (
    <div className="material-issues-table">
      <AdminTable
        rows={items}
        columns={columns}
        rowKey={(row) => row.id}
      />
      {items.length > 0 && (
        <div
          className="material-issues-table__previews"
          style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}
        >
          {items.map((row) => {
            const detail = issueDetails?.[row.id];
            if (!detail || detail.lines.length === 0) return null;
            return (
              <details
                key={`preview-${row.id}`}
                className="material-issues-table__preview"
                data-testid="material-issues-preview"
                style={{
                  border: '1px solid var(--admin-border, #d4d4d8)',
                  borderRadius: 4,
                  padding: 8,
                  background: 'rgba(0, 0, 0, 0.02)',
                }}
              >
                <summary
                  style={{
                    fontSize: '0.85rem',
                    fontWeight: 500,
                    cursor: 'pointer',
                  }}
                >
                  Состав документа от {formatDateRu(row.createdAt)} ·{' '}
                  {row.linesCount} стр. · {formatRub(row.totalCost)}
                </summary>
                <div style={{ marginTop: 8 }}>
                  <MaterialIssueLinesPreview lines={detail.lines} />
                  {detail.cancelReason && (
                    <div
                      className="admin-muted"
                      style={{ marginTop: 6, fontSize: '0.78rem' }}
                    >
                      Причина отмены: «{detail.cancelReason}»
                    </div>
                  )}
                </div>
              </details>
            );
          })}
        </div>
      )}
    </div>
  );
}
