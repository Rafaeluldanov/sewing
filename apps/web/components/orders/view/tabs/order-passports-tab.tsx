'use client';

/**
 * `OrderPassportsTab` — вкладка «Паспорта» управленческой карточки
 * `/admin/orders/[id]?tab=passports`.
 *
 * Показывает только список паспортов заказа (см. ТЗ «Вкладка
 * Паспорта»):
 *   - QR/номер паспорта;
 *   - размер;
 *   - текущий статус;
 *   - текущая ячейка;
 *   - текущий шаг маршрута (имя операции);
 *   - дата кроя / создания;
 *   - быстрая ссылка в карточку паспорта (`/passports/:id`);
 *   - фильтры по статусу и размеру (клиентские, без round-trip).
 *
 * Что СОЗНАТЕЛЬНО НЕ показываем:
 *   - production size-breakdown (он во вкладке «Производство»);
 *   - материалы/outsource (вкладка «Потребности»);
 *   - сводку KPI (это в шапке).
 *
 * Action-кнопок над паспортом сознательно нет: backend не даёт
 * управленческих действий «поменять статус паспорта» или «передвинуть
 * по маршруту» — паспорт двигается через `/work` / `/qc` / `/packing`.
 *
 * Backend / DTO / Prisma не задействованы — это presentation-слой.
 */
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { ClipboardList, Filter, Search } from 'lucide-react';
import {
  PASSPORT_STATUSES,
  type PassportListItemDto,
  type PassportStatus,
} from '@sewing/shared/passports';
import type { OrderRouteStepDto } from '@sewing/shared/orders';
import {
  AdminCard,
  AdminEmptyState,
  AdminSectionHeader,
  AdminStatusBadge,
  AdminTable,
  type AdminTableColumn,
} from '@/components/admin';
import { PASSPORT_STATUS_LABELS } from '@/lib/passport-status-labels';
import { statusTone } from '@/lib/admin-labels';

interface Props {
  orderId: string;
  passports: PassportListItemDto[];
  routeSteps: OrderRouteStepDto[];
  /** `true`, если у заказа можно выпустить паспорт (status = IN_PRODUCTION). */
  canIssuePassport: boolean;
}

interface SizeOption {
  id: string;
  code: string;
  sortOrder: number;
}

function uniqueSizes(passports: PassportListItemDto[]): SizeOption[] {
  const map = new Map<string, SizeOption>();
  for (const p of passports) {
    if (!map.has(p.sizeId)) {
      map.set(p.sizeId, {
        id: p.sizeId,
        code: p.sizeCode,
        sortOrder: p.sizeSortOrder,
      });
    }
  }
  return Array.from(map.values()).sort((a, b) => a.sortOrder - b.sortOrder);
}

export function OrderPassportsTab({
  orderId,
  passports,
  routeSteps,
  canIssuePassport,
}: Props) {
  const [statusFilter, setStatusFilter] = useState<PassportStatus | ''>('');
  const [sizeFilter, setSizeFilter] = useState<string>('');
  const [search, setSearch] = useState<string>('');

  const sizeOptions = useMemo(() => uniqueSizes(passports), [passports]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return passports.filter((p) => {
      if (statusFilter && p.status !== statusFilter) return false;
      if (sizeFilter && p.sizeId !== sizeFilter) return false;
      if (q && !p.number.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [passports, statusFilter, sizeFilter, search]);

  const stepNameByIndex = useMemo(() => {
    const map = new Map<number, string>();
    for (const s of routeSteps) {
      map.set(s.index, s.operationName);
    }
    return map;
  }, [routeSteps]);

  function currentOpLabel(p: PassportListItemDto): string {
    if (p.currentRouteStepIndex == null) return '—';
    return stepNameByIndex.get(p.currentRouteStepIndex) ?? '—';
  }

  const columns: AdminTableColumn<PassportListItemDto>[] = [
    {
      key: 'number',
      header: 'Номер',
      render: (p) => (
        <Link
          href={`/passports/${p.id}`}
          className="admin-table__action-link"
          prefetch={false}
        >
          <strong>{p.number}</strong>
        </Link>
      ),
    },
    {
      key: 'size',
      header: 'Размер',
      render: (p) => <strong>{p.sizeCode}</strong>,
    },
    {
      key: 'qty',
      header: 'Кол-во',
      align: 'right',
      render: (p) => p.qtyCut.toLocaleString('ru-RU'),
    },
    {
      key: 'good',
      header: 'Годных',
      align: 'right',
      render: (p) =>
        p.status === 'PACKED'
          ? p.qtyGood.toLocaleString('ru-RU')
          : '—',
    },
    {
      key: 'defect',
      header: 'Брак',
      align: 'right',
      render: (p) =>
        p.qtyDefect > 0 ? (
          <span style={{ color: '#b91c1c' }}>
            {p.qtyDefect.toLocaleString('ru-RU')}
          </span>
        ) : (
          '—'
        ),
    },
    {
      key: 'roll',
      header: 'Рулон',
      render: (p) => p.rollNumber || '—',
    },
    {
      key: 'status',
      header: 'Статус',
      render: (p) => (
        <AdminStatusBadge tone={statusTone(p.status)}>
          {PASSPORT_STATUS_LABELS[p.status]}
        </AdminStatusBadge>
      ),
    },
    {
      key: 'cell',
      header: 'Ячейка',
      render: (p) =>
        p.currentCell ? p.currentCell.code : <span className="admin-muted">—</span>,
    },
    {
      key: 'op',
      header: 'Текущая операция',
      render: (p) => (
        <span className="admin-muted" style={{ fontSize: '0.88rem' }}>
          {currentOpLabel(p)}
        </span>
      ),
    },
    {
      key: 'cutDate',
      header: 'Крой',
      render: (p) => formatDate(p.cutDate),
    },
  ];

  return (
    <div className="order-passports-tab">
      <AdminCard>
        <AdminSectionHeader
          icon={<ClipboardList size={18} strokeWidth={1.7} aria-hidden />}
          title="Паспорта изделия"
          hint={
            passports.length > 0
              ? `Всего: ${passports.length.toLocaleString('ru-RU')}`
              : undefined
          }
          actions={
            canIssuePassport ? (
              <Link
                href={`/orders/${orderId}/passports/new`}
                className="admin-btn admin-btn--primary"
              >
                <ClipboardList size={16} strokeWidth={1.7} aria-hidden />
                Выпустить паспорт
              </Link>
            ) : null
          }
        />

        {passports.length === 0 ? (
          <AdminEmptyState
            icon={<ClipboardList size={26} strokeWidth={1.6} aria-hidden />}
            title="По заказу пока нет паспортов"
            hint={
              canIssuePassport
                ? 'Помощник раскройщика выпускает паспорта со страницы выпуска.'
                : 'Выпуск паспортов доступен только в статусе «В производстве».'
            }
          />
        ) : (
          <>
            <FiltersBar
              sizeOptions={sizeOptions}
              statusFilter={statusFilter}
              sizeFilter={sizeFilter}
              search={search}
              onStatusChange={setStatusFilter}
              onSizeChange={setSizeFilter}
              onSearchChange={setSearch}
              filteredCount={filtered.length}
              totalCount={passports.length}
            />
            {filtered.length === 0 ? (
              <AdminEmptyState
                icon={<Filter size={26} strokeWidth={1.6} aria-hidden />}
                title="Ничего не найдено"
                hint="Попробуйте сбросить фильтры или изменить поисковую строку."
              />
            ) : (
              <AdminTable
                rows={filtered}
                columns={columns}
                rowKey={(p) => p.id}
              />
            )}
          </>
        )}
      </AdminCard>
    </div>
  );
}

function FiltersBar(props: {
  sizeOptions: SizeOption[];
  statusFilter: PassportStatus | '';
  sizeFilter: string;
  search: string;
  onStatusChange: (v: PassportStatus | '') => void;
  onSizeChange: (v: string) => void;
  onSearchChange: (v: string) => void;
  filteredCount: number;
  totalCount: number;
}) {
  const {
    sizeOptions,
    statusFilter,
    sizeFilter,
    search,
    onStatusChange,
    onSizeChange,
    onSearchChange,
    filteredCount,
    totalCount,
  } = props;
  return (
    <div className="order-passports-tab__filters">
      <div className="admin-field">
        <label htmlFor="passports-search">Поиск по номеру</label>
        <div className="order-passports-tab__search">
          <Search size={14} strokeWidth={1.7} aria-hidden />
          <input
            id="passports-search"
            type="search"
            placeholder="P-…"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </div>
      </div>
      <div className="admin-field">
        <label htmlFor="passports-status">Статус</label>
        <select
          id="passports-status"
          value={statusFilter}
          onChange={(e) =>
            onStatusChange(e.target.value as PassportStatus | '')
          }
        >
          <option value="">Все статусы</option>
          {PASSPORT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {PASSPORT_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </div>
      <div className="admin-field">
        <label htmlFor="passports-size">Размер</label>
        <select
          id="passports-size"
          value={sizeFilter}
          onChange={(e) => onSizeChange(e.target.value)}
        >
          <option value="">Все размеры</option>
          {sizeOptions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.code}
            </option>
          ))}
        </select>
      </div>
      <div
        className="admin-muted"
        style={{ alignSelf: 'end', fontSize: '0.85rem' }}
      >
        Показано {filteredCount.toLocaleString('ru-RU')} из{' '}
        {totalCount.toLocaleString('ru-RU')}
      </div>
    </div>
  );
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('ru-RU');
  } catch {
    return '—';
  }
}
