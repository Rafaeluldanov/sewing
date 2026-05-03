/**
 * `MaterialIssueLinesPreview` — компактный preview строк документа
 * «Фактический расход материалов» для раскрытого ряда в
 * `MaterialIssuesTable`.
 *
 * Умышленно не полноразмерная deep-view карточка: базовая таблица
 * `MaterialIssuesTable` держит itemized `linesCount`/`totalCost`,
 * а этот компонент разворачивает конкретику — описание / роль /
 * количество / цена / сумма / ячейка. Для MVP этого достаточно,
 * отдельный экран документа мы специально не делаем (UI-решение
 * владельца — весь блок живёт только в карточке заказа).
 *
 * Компонент server-safe: просто маппит DTO в таблицу, никаких
 * fetch / useState / useEffect — можно включать в async-контейнер.
 */
import {
  AdminTable,
  type AdminTableColumn,
} from '@/components/admin';
import type { MaterialIssueLineDto } from '@sewing/shared/material-issues';

interface Props {
  lines: MaterialIssueLineDto[];
}

function formatDecimal(value: string | null | undefined): string {
  if (value == null || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return n.toLocaleString('ru-RU', {
    maximumFractionDigits: 4,
    minimumFractionDigits: 0,
  });
}

function formatMoney(value: string | null | undefined): string {
  if (value == null || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return n.toLocaleString('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: 2,
  });
}

export function MaterialIssueLinesPreview({ lines }: Props) {
  const columns: AdminTableColumn<MaterialIssueLineDto>[] = [
    {
      key: 'description',
      header: 'Материал',
      render: (line) => (
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 500 }}>{line.description}</div>
          {line.materialRole && (
            <div
              className="admin-muted"
              style={{ fontSize: '0.75rem', marginTop: 2 }}
            >
              {line.materialRole}
            </div>
          )}
          {line.comment && (
            <div
              className="admin-muted"
              style={{ fontSize: '0.75rem', marginTop: 2 }}
            >
              «{line.comment}»
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'issuedQty',
      header: 'Выдано',
      align: 'right',
      render: (line) => (
        <span>
          {formatDecimal(line.issuedQty)} {line.unit}
        </span>
      ),
    },
    {
      key: 'unitCost',
      header: 'Цена за 1',
      align: 'right',
      render: (line) => <span>{formatMoney(line.unitCost)}</span>,
    },
    {
      key: 'totalCost',
      header: 'Сумма',
      align: 'right',
      render: (line) => <span>{formatMoney(line.totalCost)}</span>,
    },
    {
      key: 'cell',
      header: 'Ячейка',
      render: (line) => <span>{line.cellCode ?? '—'}</span>,
    },
  ];

  return (
    <AdminTable
      rows={lines}
      columns={columns}
      rowKey={(line) => line.id}
    />
  );
}
