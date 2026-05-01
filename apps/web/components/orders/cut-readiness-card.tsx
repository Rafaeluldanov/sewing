/**
 * `CutReadinessCard` — блок «Готовность к крою» в карточке заказа
 * (Этап 8А, см. `apps/api/src/modules/cut-readiness/*`,
 * `docs/recon-soft-integration.md §«Этап 8А»`).
 *
 * Серверный компонент: грузит сводку по заказу через
 * `getOrderCutReadiness(orderId)`. Если backend упал — показывает
 * error-box и не валит карточку заказа (по тем же принципам, что
 * `WorkshopNeedsCard` / `PurchaseReceiptsCard`).
 *
 * Управляющие действия:
 *   - кнопка «Материал поступил» (этап «Ручная отметка поступления
 *     материала», см. `MaterialArrivedButton` и
 *     `apps/api/src/modules/order-material-arrivals/*`). Показывается,
 *     если у заказа есть material blockers и заказ ещё в работе
 *     (статус не `DONE`/`CANCELLED`). Backend сам защитит RBAC —
 *     неавторизованные вызовы вернут 403.
 *
 * Содержание:
 *   1. Заголовок + общий статус (`READY` / `WARNING_ONLY` / `NOT_READY`);
 *   2. Сводка `blockersCount` / `warningsCount` / `checkedAt` —
 *      компактные стат-боксы (`.cut-readiness-stats`), сворачиваются
 *      на узкой ширине через `repeat(auto-fit, minmax(120px, 1fr))`;
 *   3. Блокеры (плоский список из всех секций + материалов);
 *   4. Материалы (таблица: роль / описание / нужно / принято /
 *      в ячейке / ячейки / статус) — обёрнута в
 *      `.cut-readiness-materials-scroll` с `overflow-x: auto`,
 *      сама таблица имеет `min-width: 720px` (см. `globals.css`),
 *      чтобы скроллиться внутри карточки и не выталкивать
 *      grid-сетку страницы. Для строк с `manuallyUnblocked = true`
 *      рендерится бейдж «Материал поступил вручную» с
 *      пояснением «Складская приёмка не создана» и кнопкой
 *      «Отменить отметку»;
 *   5. Предупреждения (плоский список);
 *   6. Кнопка «Материал поступил» (см. выше).
 */
import { PackageOpen, ShieldCheck } from 'lucide-react';
import {
  CUT_READINESS_STATUS_LABELS,
  type CutMaterialArrivalOverrideRefDto,
  type CutMaterialReadinessDto,
  type CutReadinessCheckDto,
  type CutReadinessCheckStatus,
  type CutReadinessDto,
  type CutReadinessStatus,
} from '@sewing/shared/cut-readiness';
import type { OrderStatus } from '@sewing/shared/orders';
import {
  AdminCard,
  AdminSectionHeader,
  AdminStatusBadge,
  AdminTable,
  type AdminTableColumn,
} from '@/components/admin';
import { ApiRequestError } from '@/lib/api';
import { getOrderCutReadiness } from '@/lib/cut-readiness-api';
import type { AdminStatusTone } from '@/lib/admin-labels';
import { MaterialArrivedButton } from './material-arrived-button';
import { RevokeMaterialArrivalButton } from './revoke-material-arrival-button';

interface Props {
  orderId: string;
  /**
   * Опциональный статус заказа — нужен, чтобы скрыть кнопку
   * «Материал поступил» для терминальных статусов (`DONE`/`CANCELLED`).
   * Если родитель не передал, кнопка показывается в зависимости от
   * наличия blockers — backend всё равно защитит mutation.
   */
  orderStatus?: OrderStatus;
}

function overallTone(status: CutReadinessStatus): AdminStatusTone {
  switch (status) {
    case 'READY':
      return 'success';
    case 'WARNING_ONLY':
      return 'warning';
    case 'NOT_READY':
      return 'danger';
    default:
      return 'muted';
  }
}

function checkTone(status: CutReadinessCheckStatus): AdminStatusTone {
  switch (status) {
    case 'OK':
      return 'success';
    case 'BLOCKER':
      return 'danger';
    case 'WARNING':
      return 'warning';
    case 'INFO':
      return 'info';
    default:
      return 'muted';
  }
}

function checkLabel(status: CutReadinessCheckStatus): string {
  switch (status) {
    case 'OK':
      return 'Готов';
    case 'BLOCKER':
      return 'Не готов';
    case 'WARNING':
      return 'Внимание';
    case 'INFO':
      return 'Инфо';
    default:
      return status;
  }
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ru-RU');
}

export async function CutReadinessCard({ orderId, orderStatus }: Props) {
  let data: CutReadinessDto | null = null;
  let loadError: string | null = null;
  try {
    data = await getOrderCutReadiness(orderId);
  } catch (e) {
    loadError =
      e instanceof ApiRequestError
        ? `${e.message}${e.code ? ` (${e.code})` : ''}`
        : 'Не удалось загрузить готовность к крою';
  }

  if (!data) {
    return (
      <AdminCard className="cut-readiness-card">
        <AdminSectionHeader
          icon={<ShieldCheck size={18} strokeWidth={1.7} aria-hidden />}
          title="Готовность к крою"
        />
        {loadError && (
          <div className="error-box" role="alert">
            {loadError}
          </div>
        )}
      </AdminCard>
    );
  }

  const overallLabel = CUT_READINESS_STATUS_LABELS[data.status];

  // Кнопка «Материал поступил» — показываем, только если у заказа
  // есть нерешённые material-блокеры (хоть одна material-строка в
  // статусе BLOCKER) и заказ ещё в работе. Backend сам защитит
  // RBAC, но фронт не предлагает действие, для которого ничего не
  // изменит.
  const hasMaterialBlockers = data.sections.materials.some(
    (m) => m.status === 'BLOCKER',
  );
  const orderIsTerminal =
    orderStatus === 'DONE' || orderStatus === 'CANCELLED';
  const showMaterialArrivedButton =
    hasMaterialBlockers && !orderIsTerminal;

  return (
    <AdminCard className="cut-readiness-card">
      <AdminSectionHeader
        icon={<ShieldCheck size={18} strokeWidth={1.7} aria-hidden />}
        title="Готовность к крою"
        actions={
          <AdminStatusBadge tone={overallTone(data.status)}>
            {overallLabel}
          </AdminStatusBadge>
        }
      />

      {loadError && (
        <div className="error-box" role="alert" style={{ marginBottom: 8 }}>
          {loadError}
        </div>
      )}

      {/* Стат-боксы вместо `dl`: на узкой grid-area колонки `dl`
          разъезжались (label/value переносились вразнобой). Здесь —
          `auto-fit, minmax(120px, 1fr)`, поэтому контент сам
          сворачивается в одну/две/три колонки в зависимости от
          ширины. */}
      <div className="cut-readiness-stats">
        <div className="cut-readiness-stats__item">
          <span className="cut-readiness-stats__label">Блокеров</span>
          <span className="cut-readiness-stats__value">
            {data.blockersCount}
          </span>
        </div>
        <div className="cut-readiness-stats__item">
          <span className="cut-readiness-stats__label">Предупреждений</span>
          <span className="cut-readiness-stats__value">
            {data.warningsCount}
          </span>
        </div>
        <div className="cut-readiness-stats__item">
          <span className="cut-readiness-stats__label">Проверено</span>
          <span className="cut-readiness-stats__value">
            {formatDateTime(data.checkedAt)}
          </span>
        </div>
      </div>

      {/* ============== Блокеры ============== */}
      <div className="cut-readiness-section">
        <h4 className="cut-readiness-section__title">
          Блокеры ({data.blockersCount})
        </h4>
        {data.blockers.length === 0 ? (
          <div className="admin-muted" style={{ fontSize: '0.85rem' }}>
            Блокеров нет.
          </div>
        ) : (
          <ul className="cut-readiness-list">
            {data.blockers.map((c) => (
              <CheckListItem key={c.key} check={c} />
            ))}
          </ul>
        )}
      </div>

      {/* ============== Материалы ==============
          `.cut-readiness-materials-scroll` даёт горизонтальный
          скролл, а внутри `min-width: 720px` у самой таблицы (см.
          `globals.css`). Это исправляет «разъезжающиеся» колонки
          и выезд блока за границу карточки на узких grid-area. */}
      <div className="cut-readiness-section">
        <h4 className="cut-readiness-section__title">
          Материалы ({data.sections.materials.length})
        </h4>
        {data.sections.materials.length === 0 ? (
          <div className="admin-muted" style={{ fontSize: '0.85rem' }}>
            Материальные потребности ещё не рассчитаны.
          </div>
        ) : (
          <div className="cut-readiness-materials-scroll">
            <MaterialsTable rows={data.sections.materials} orderId={orderId} />
          </div>
        )}
      </div>

      {/* ============== Предупреждения ============== */}
      <div className="cut-readiness-section">
        <h4 className="cut-readiness-section__title">
          Предупреждения ({data.warningsCount})
        </h4>
        {data.warnings.length === 0 ? (
          <div className="admin-muted" style={{ fontSize: '0.85rem' }}>
            Предупреждений нет.
          </div>
        ) : (
          <ul className="cut-readiness-list">
            {data.warnings.map((c) => (
              <CheckListItem key={c.key} check={c} />
            ))}
          </ul>
        )}
      </div>

      {/* ============== Действие: «Материал поступил» ==============
          Показываем, только если есть material-блокеры и заказ ещё
          в работе. Кнопка открывает inline-форму с обязательным
          комментарием — это сознательная ручная разблокировка
          кроя без создания складской приёмки (см. JSDoc выше и
          `apps/api/src/modules/order-material-arrivals/*`). */}
      {showMaterialArrivedButton && (
        <div className="cut-readiness-section">
          <h4 className="cut-readiness-section__title">
            <PackageOpen size={14} strokeWidth={1.6} aria-hidden />
            {' '}
            Ручная разблокировка кроя
          </h4>
          <MaterialArrivedButton orderId={orderId} />
        </div>
      )}
    </AdminCard>
  );
}

function CheckListItem({ check }: { check: CutReadinessCheckDto }) {
  return (
    <li className="cut-readiness-list__item">
      <div className="cut-readiness-list__body">
        <div className="cut-readiness-list__title">{check.title}</div>
        {check.message && (
          <div className="admin-muted cut-readiness-list__msg">
            {check.message}
          </div>
        )}
      </div>
      <AdminStatusBadge tone={checkTone(check.status)}>
        {checkLabel(check.status)}
      </AdminStatusBadge>
    </li>
  );
}

function MaterialsTable({
  rows,
  orderId,
}: {
  rows: CutMaterialReadinessDto[];
  orderId: string;
}) {
  const columns: AdminTableColumn<CutMaterialReadinessDto>[] = [
    {
      key: 'role',
      header: 'Роль',
      render: (m) => (
        <div>
          <div style={{ fontWeight: 500 }}>
            {m.roleLabel ?? m.materialRole}
          </div>
          <div
            className="admin-muted"
            style={{ fontSize: '0.75rem', marginTop: 1 }}
          >
            {m.materialRole}
          </div>
        </div>
      ),
    },
    {
      key: 'description',
      header: 'Описание',
      render: (m) => (
        <div style={{ minWidth: 0 }}>
          <div>{m.description}</div>
          {m.message && (
            <div
              className="admin-muted"
              style={{ fontSize: '0.75rem', marginTop: 2 }}
            >
              {m.message}
            </div>
          )}
          {m.manuallyUnblocked && (
            <ManualOverrideBlock
              orderId={orderId}
              overrides={m.manualArrivalOverrides ?? []}
            />
          )}
        </div>
      ),
    },
    {
      key: 'target',
      header: 'Нужно',
      align: 'right',
      render: (m) => (
        <span>
          {String(m.targetQty)} {m.unit}
        </span>
      ),
    },
    {
      key: 'received',
      header: 'Принято',
      align: 'right',
      render: (m) => (
        <span>
          {String(m.receivedQty)} {m.unit}
        </span>
      ),
    },
    {
      key: 'placed',
      header: 'В ячейке',
      align: 'right',
      render: (m) => (
        <span>
          {String(m.placedQty)} {m.unit}
        </span>
      ),
    },
    {
      key: 'cells',
      header: 'Ячейки',
      render: (m) =>
        m.cells.length === 0 ? (
          <span className="admin-muted">—</span>
        ) : (
          <ul
            style={{
              margin: 0,
              padding: 0,
              listStyle: 'none',
              fontSize: '0.78rem',
            }}
          >
            {m.cells.map((c) => (
              <li key={c.cellId} style={{ marginBottom: 2 }}>
                <strong>{c.cellCode}</strong>
                {c.lineName ? ` · ${c.lineName}` : ''}
                {c.warehouseName ? ` · ${c.warehouseName}` : ''}
                <span className="admin-muted">
                  {' — '}
                  {String(c.qty)} {c.unit}
                </span>
              </li>
            ))}
          </ul>
        ),
    },
    {
      key: 'status',
      header: 'Статус',
      render: (m) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <AdminStatusBadge tone={checkTone(m.status)}>
            {checkLabel(m.status)}
          </AdminStatusBadge>
          {m.manuallyUnblocked && (
            <AdminStatusBadge tone="warning">
              Материал поступил вручную
            </AdminStatusBadge>
          )}
        </div>
      ),
    },
  ];
  return (
    <AdminTable
      rows={rows}
      columns={columns}
      rowKey={(m) => m.workshopNeedId ?? `${m.materialRole}-${m.description}`}
    />
  );
}

/**
 * Блок «Материал поступил вручную» внутри строки `MaterialsTable`.
 * Рендерится, если `CutMaterialReadinessDto.manuallyUnblocked = true`.
 *
 * Содержит:
 *   - пояснение «Крой разблокирован ручной отметкой. Складская
 *     приёмка не создана»;
 *   - для каждой ACTIVE-override строки: «кто отметил · когда»,
 *     комментарий и кнопку «Отменить отметку»
 *     (см. `RevokeMaterialArrivalButton`).
 */
function ManualOverrideBlock({
  orderId,
  overrides,
}: {
  orderId: string;
  overrides: CutMaterialArrivalOverrideRefDto[];
}) {
  return (
    <div
      style={{
        marginTop: 6,
        padding: '6px 8px',
        background: 'var(--admin-warning-bg, #fff7ed)',
        border: '1px solid var(--admin-warning-border, #fed7aa)',
        borderRadius: 4,
        fontSize: '0.78rem',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <div style={{ fontWeight: 500 }}>
        Крой разблокирован ручной отметкой. Складская приёмка не создана.
      </div>
      {overrides.map((ov) => (
        <div
          key={ov.id}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            paddingTop: 4,
            borderTop: '1px dashed var(--admin-warning-border, #fed7aa)',
          }}
        >
          <div className="admin-muted" style={{ fontSize: '0.72rem' }}>
            {ov.createdByName ?? 'Не указано'} ·{' '}
            {new Date(ov.createdAt).toLocaleString('ru-RU')}
            {ov.qty !== null && ov.qty !== undefined ? (
              <>
                {' · '}
                {String(ov.qty)} {ov.unit ?? ''}
              </>
            ) : null}
          </div>
          {ov.comment && (
            <div style={{ fontSize: '0.78rem' }}>«{ov.comment}»</div>
          )}
          <div>
            <RevokeMaterialArrivalButton
              orderId={orderId}
              overrideId={ov.id}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
