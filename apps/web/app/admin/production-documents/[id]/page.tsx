/**
 * Карточка ДОКУМЕНТА ВЫПУСКА по заказу (`/admin/production-documents/[id]`).
 *
 * Данные — `getProductionDocument(id)` → `GET /api/admin/production-documents/:id`
 * (`ProductionDocumentDto` из `@sewing/shared/production-documents`).
 *
 * Доменное правило, которое держит этот экран: документ выпуска НИКТО НЕ ВЕДЁТ.
 * Его не заводят, не проводят, не пересчитывают и не согласовывают — он собирается
 * сам из фактов цеха, поэтому здесь нет ни одной кнопки действия и не должно
 * появиться. Состояний ровно два, и оба наступают без человека: `FORMING` —
 * факты ещё идут (причины лежат в `pendingReasons`), `READY` — лёг последний
 * факт (`lastFactKind`) и себестоимость зафиксирована снимком. ERP документ
 * только читает: никакого «ответа ERP» на экране нет.
 *
 * ⛔ `cost.pieceworkPendingRub` не входит в `totalRub` и не должен подмешиваться
 * в итог: незакрытая коробка — это обещание, а не трата. Показываем отдельной
 * предупреждающей строкой.
 *
 * ⛔ Не путать с `/admin/production-cost/order/[orderId]` — там read-модель
 * «план → факт», которая ничего не хранит. Здесь — документ со снимком.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  AlertTriangle,
  ArrowLeft,
  ExternalLink,
  Hourglass,
  Layers,
  PackageCheck,
  RefreshCcw,
  Wallet,
} from 'lucide-react';
import {
  PRODUCTION_DOCUMENT_FACT_KIND_LABELS,
  PRODUCTION_DOCUMENT_STATUS_LABELS,
  type ProductionDocumentCostDto,
  type ProductionDocumentDto,
} from '@sewing/shared/production-documents';
import { ApiRequestError, errorText } from '@/lib/api';
import { getProductionDocument } from '@/lib/production-documents-api';
import {
  AdminCard,
  AdminPageShell,
  AdminSectionHeader,
  AdminStatusBadge,
  AdminTable,
  type AdminTableColumn,
} from '@/components/admin';
import type { AdminStatusTone } from '@/lib/admin-labels';
import { ProductionDocumentSyncButton } from '@/components/orders/view/production-document-sync-button.client';
import { ProductionDocumentLines } from './production-document-lines.client';

export const dynamic = 'force-dynamic';

/* ------------------------------------------------------------------ */
/* Форматирование                                                      */
/* ------------------------------------------------------------------ */

/**
 * Даты форматируем в `Europe/Moscow` явно: страница серверная, и без
 * фиксированной зоны RSC и браузер печатают разное время — hydration
 * расходится (см. feedback про timezone).
 */
function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function fmtRub(value: number): string {
  return `${value.toLocaleString('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ₽`;
}

/** Отклонение всегда со знаком: «+» читается как перерасход. */
function fmtSignedRub(value: number): string {
  const prefix = value > 0 ? '+' : '';
  return `${prefix}${fmtRub(value)}`;
}

function fmtInt(value: number): string {
  return value.toLocaleString('ru-RU');
}

function statusTone(status: ProductionDocumentDto['status']): AdminStatusTone {
  // FORMING — не ошибка и не «черновик»: это «ждём последний факт»,
  // поэтому предупреждающий тон, а не muted.
  return status === 'READY' ? 'success' : 'warning';
}

/**
 * Расшифровка `cost.warnings`. Коды приходят с бэка и в интерфейс
 * просачиваться не должны; незнакомый код показываем как есть — молча
 * прятать предупреждение о себестоимости хуже, чем показать код.
 */
const COST_WARNING_LABELS: Record<string, string> = {
  NO_MATERIAL_FACT: 'по заказу нет ни одного факта расхода материала',
  PIECEWORK_PENDING: 'часть сдельной ещё не подтверждена',
  EXTRA_COSTS_NON_RUB_SKIPPED: 'прочие расходы в валюте не вошли: конвертации нет',
  MATERIALS_EXCLUDED_BY_POLICY: 'материалы исключены политикой заказа',
  SALARY_APPORTION_FAILED: 'оклад разнести не удалось',
  NO_PRODUCTION_WINDOW: 'нет окна производства: оклад не разнесён',
  ORDER_NOT_FOUND: 'заказ не найден',
};

/* ------------------------------------------------------------------ */
/* Себестоимость — строки таблицы компонентов                          */
/* ------------------------------------------------------------------ */

interface CostRow {
  key: string;
  label: string;
  hint?: string;
  value: string;
  strong?: boolean;
  tone?: 'danger' | 'success';
}

/**
 * Себестоимость показываем КОМПОНЕНТАМИ и все сразу: что из них считать
 * себестоимостью заказа, решает владелец, и решать он будет на живых числах.
 */
function buildCostRows(cost: ProductionDocumentCostDto): CostRow[] {
  const rows: CostRow[] = [
    { key: 'materialsOwn', label: 'Свой материал', value: fmtRub(cost.materialsOwnRub) },
    { key: 'materialsErp', label: 'Материал ЕРП', value: fmtRub(cost.materialsErpRub) },
    { key: 'piecework', label: 'Сдельная', value: fmtRub(cost.pieceworkRub) },
    { key: 'recut', label: 'Подкрой', value: fmtRub(cost.recutRub) },
    {
      key: 'salary',
      label: 'Оклад',
      hint: 'разнесённый на выпуск',
      value: fmtRub(cost.salaryRub),
    },
    { key: 'other', label: 'Прочие расходы', value: fmtRub(cost.otherRub) },
    {
      key: 'total',
      label: 'ИТОГО',
      value: fmtRub(cost.totalRub),
      strong: true,
    },
    {
      key: 'perUnit',
      label: 'За единицу',
      value: fmtRub(cost.perUnitRub),
    },
  ];

  if (cost.planTotalRub != null) {
    const variance = cost.totalRub - cost.planTotalRub;
    rows.push({
      key: 'plan',
      label: 'План',
      hint:
        cost.planPerUnitRub != null
          ? `${fmtRub(cost.planPerUnitRub)} за единицу`
          : undefined,
      value: fmtRub(cost.planTotalRub),
    });
    rows.push({
      key: 'variance',
      label: 'Отклонение от плана',
      hint: variance > 0 ? 'перерасход' : variance < 0 ? 'экономия' : undefined,
      value: fmtSignedRub(variance),
      tone: variance > 0 ? 'danger' : variance < 0 ? 'success' : undefined,
    });
  }

  return rows;
}

const COST_COLUMNS: AdminTableColumn<CostRow>[] = [
  {
    key: 'label',
    header: 'Статья',
    // Сортировку выключаем осознанно: порядок статей — это и есть смысл
    // (компоненты → ИТОГО → план → отклонение), клик по заголовку его ломает.
    sortable: false,
    render: (row) => (
      <>
        <span style={{ fontWeight: row.strong ? 700 : undefined }}>
          {row.label}
        </span>
        {row.hint && (
          <span className="admin-muted" style={{ marginLeft: 6, fontSize: 12 }}>
            {row.hint}
          </span>
        )}
      </>
    ),
  },
  {
    key: 'value',
    header: 'Сумма',
    align: 'right',
    sortable: false,
    render: (row) => (
      <span
        style={{
          fontWeight: row.strong ? 700 : undefined,
          fontVariantNumeric: 'tabular-nums',
          color:
            row.tone === 'danger'
              ? 'var(--admin-danger, #d23b3b)'
              : row.tone === 'success'
                ? 'var(--admin-success, #2e9e4a)'
                : undefined,
        }}
      >
        {row.value}
      </span>
    ),
  },
];

/* ------------------------------------------------------------------ */
/* Страница                                                            */
/* ------------------------------------------------------------------ */

export default async function AdminProductionDocumentDetailPage({
  params,
}: {
  params: { id: string };
}) {
  let doc: ProductionDocumentDto | null = null;
  let error: string | null = null;
  try {
    doc = await getProductionDocument(params.id);
  } catch (e) {
    // 404 — документа нет (заказ не закрыт или чужой id): честный notFound.
    // Остальные ошибки не роняют экран: показываем плашку, а не белый лист.
    if (e instanceof ApiRequestError && e.statusCode === 404) notFound();
    error =
      e instanceof ApiRequestError
        ? errorText(e)
        : 'Не удалось загрузить документ выпуска. Попробуйте обновить страницу.';
  }

  if (!doc) {
    return (
      <AdminPageShell
        icon={<PackageCheck size={22} strokeWidth={1.6} aria-hidden />}
        title="Документ выпуска"
        actions={
          <Link
            href="/admin/production-documents"
            className="admin-btn admin-btn--ghost"
          >
            <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />К списку
          </Link>
        }
      >
        <div className="error-box" role="alert">
          {error}
        </div>
      </AdminPageShell>
    );
  }

  const cost = doc.cost;
  const variance =
    cost.planTotalRub != null ? cost.totalRub - cost.planTotalRub : null;
  const isForming = doc.status === 'FORMING';

  return (
    <AdminPageShell
      icon={<PackageCheck size={22} strokeWidth={1.6} aria-hidden />}
      title={doc.number}
      subtitle={
        doc.customer
          ? `Выпуск по заказу ${doc.orderNumber} · ${doc.customer}`
          : `Выпуск по заказу ${doc.orderNumber}`
      }
      actions={
        <>
          <Link
            href="/admin/production-documents"
            className="admin-btn admin-btn--ghost"
          >
            <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />К списку
          </Link>
          <Link href={`/admin/orders/${doc.orderId}`} className="admin-btn">
            <ExternalLink size={16} strokeWidth={1.6} aria-hidden />
            Открыть заказ
          </Link>
          {/*
            Пересборка по требованию. Обычно документ обновляется сам — на закрытии коробки и
            при чтении, если факты изменились, — но человеку, который смотрит на цифры прямо
            сейчас, нужна возможность подтянуть их, не дожидаясь события. Ничего не проводит и
            не подтверждает: провести выпуск нельзя.
          */}
          <ProductionDocumentSyncButton
            orderId={doc.orderId}
            mode="refresh"
            subtle
          />
          <AdminStatusBadge tone={statusTone(doc.status)} withDot>
            {PRODUCTION_DOCUMENT_STATUS_LABELS[doc.status]}
          </AdminStatusBadge>
        </>
      }
    >
      {/* 1. Сдача — чем закрылся выпуск и когда */}
      <AdminCard>
        <AdminSectionHeader title="Сдача" hint="что цех сдал и когда" />
        <dl className="admin-deflist">
          <dt>Заказ</dt>
          <dd>
            <Link href={`/admin/orders/${doc.orderId}`}>{doc.orderNumber}</Link>
          </dd>
          <dt>Клиент</dt>
          <dd>{doc.customer ?? <span className="admin-muted">—</span>}</dd>
          <dt>Лекало</dt>
          <dd>{doc.patternName ?? <span className="admin-muted">—</span>}</dd>
          <dt>Заказ покупателя ERP</dt>
          <dd>
            {doc.erpCustomerOrderNumber ?? (
              <span className="admin-muted">—</span>
            )}
          </dd>
          <dt>Закрыт</dt>
          <dd>{fmtDateTime(doc.closedAt)}</dd>
          <dt>Окончателен с</dt>
          <dd>
            {doc.readyAt ? (
              fmtDateTime(doc.readyAt)
            ) : (
              // Не «—»: пустота здесь означает не «нет данных», а «факты ещё идут».
              <span className="admin-muted">ещё нет</span>
            )}
          </dd>
          <dt>Последний факт</dt>
          <dd>
            {doc.lastFactAt ? (
              <>
                {fmtDateTime(doc.lastFactAt)}
                {doc.lastFactKind && (
                  <span
                    className="admin-muted"
                    style={{ marginLeft: 6, fontSize: 12 }}
                  >
                    {PRODUCTION_DOCUMENT_FACT_KIND_LABELS[doc.lastFactKind]}
                  </span>
                )}
              </>
            ) : (
              <span className="admin-muted">—</span>
            )}
          </dd>
        </dl>
      </AdminCard>

      {/* 2. Итоги плитками */}
      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-card__head">Годных</div>
          <div className="kpi-card__value">{fmtInt(doc.qtyGood)}</div>
          <div className="kpi-card__sub">из {fmtInt(doc.qtyPlan)} по плану</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-card__head">Раскроено</div>
          <div className="kpi-card__value">{fmtInt(doc.qtyCut)}</div>
        </div>
        <div className={doc.qtyDefect > 0 ? 'kpi-card kpi-card--danger' : 'kpi-card'}>
          <div className="kpi-card__head">Брак</div>
          <div className="kpi-card__value">{fmtInt(doc.qtyDefect)}</div>
        </div>
        <div className="kpi-card kpi-card--accent">
          <div className="kpi-card__head">Себестоимость</div>
          <div className="kpi-card__value">{fmtRub(cost.totalRub)}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-card__head">За единицу</div>
          <div className="kpi-card__value">{fmtRub(cost.perUnitRub)}</div>
        </div>
        {variance != null && (
          <div
            className={
              variance > 0
                ? 'kpi-card kpi-card--danger'
                : variance < 0
                  ? 'kpi-card kpi-card--ok'
                  : 'kpi-card'
            }
          >
            <div className="kpi-card__head">Отклонение от плана</div>
            <div className="kpi-card__value">{fmtSignedRub(variance)}</div>
            <div className="kpi-card__sub">
              {variance > 0
                ? 'перерасход'
                : variance < 0
                  ? 'экономия'
                  : 'ровно по плану'}
              {cost.planTotalRub != null && ` · план ${fmtRub(cost.planTotalRub)}`}
            </div>
          </div>
        )}
      </div>

      {/* 3. Почему документ ещё формируется. Никаких кнопок: ждать — это
             и есть правильное действие. */}
      {isForming && (
        <AdminCard>
          <AdminSectionHeader
            icon={<Hourglass size={18} strokeWidth={1.6} aria-hidden />}
            title="Документ ещё дособирается"
            hint="факты по заказу продолжают приходить"
          />
          {doc.pendingReasons.length > 0 ? (
            <ul className="alert-stack" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {doc.pendingReasons.map((reason) => (
                <li key={reason.code} className="alert-row alert-row--warn">
                  <span className="alert-row__icon">
                    <AlertTriangle size={16} strokeWidth={1.6} aria-hidden />
                  </span>
                  <span className="alert-row__msg">
                    {reason.text}
                    {reason.detail && (
                      <span
                        className="admin-muted"
                        style={{ display: 'block', fontSize: 12 }}
                      >
                        {reason.detail}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="admin-muted">
              Последний факт по заказу ещё не лёг.
            </p>
          )}
          <div className="warning-box" role="note" style={{ marginTop: '0.85rem', marginBottom: 0 }}>
            <div className="warning-box__msg">Делать ничего не нужно.</div>
            <p style={{ margin: '0.35rem 0 0' }}>
              Документ выпуска никто не заводит и не проводит: он дособерётся
              сам, когда упаковщик закроет коробку и начисления будут
              подтверждены. Тогда себестоимость зафиксируется снимком, и статус
              станет «{PRODUCTION_DOCUMENT_STATUS_LABELS.READY}».
            </p>
          </div>
        </AdminCard>
      )}

      {/* 6. Пересборка после фиксации — почему числа могли поехать */}
      {doc.recalculatedAt != null && (
        <AdminCard compact>
          <p className="admin-note">
            <RefreshCcw size={16} strokeWidth={1.6} aria-hidden />
            <span>
              Документ пересобран {fmtDateTime(doc.recalculatedAt)}: факт пришёл
              уже после фиксации
              {doc.recalcReason ? ` — ${doc.recalcReason}` : ''}. Снимок
              себестоимости заменён на новый.
            </span>
          </p>
        </AdminCard>
      )}

      {/* 4. Состав выпуска */}
      <AdminCard>
        <AdminSectionHeader
          icon={<Layers size={18} strokeWidth={1.6} aria-hidden />}
          title="Состав выпуска"
          hint={`${fmtInt(doc.lines.length)} строк · раскройте строку, чтобы увидеть паспорта`}
        />
        <ProductionDocumentLines lines={doc.lines} />
      </AdminCard>

      {/* 5. Себестоимость выпуска — компонентами */}
      <AdminCard>
        <AdminSectionHeader
          icon={<Wallet size={18} strokeWidth={1.6} aria-hidden />}
          title="Себестоимость выпуска"
          hint={
            doc.status === 'READY'
              ? 'снимок на момент фиксации'
              : 'предварительно: факты ещё идут'
          }
        />
        <AdminTable
          rows={buildCostRows(cost)}
          columns={COST_COLUMNS}
          rowKey={(row) => row.key}
        />

        {/* ⛔ Ключевое правило экрана: «не подтверждено» НЕ входит в ИТОГО.
            Незакрытая коробка — обещание, а не трата, поэтому строка живёт
            вне таблицы и предупреждающим тоном. */}
        {cost.pieceworkPendingRub > 0 && (
          <div
            className="warning-box"
            role="note"
            style={{ marginTop: '0.85rem', marginBottom: 0 }}
          >
            <div className="warning-box__msg">
              Не подтверждено: {fmtRub(cost.pieceworkPendingRub)}
            </div>
            <p style={{ margin: '0.35rem 0 0' }}>
              Сдельная по незакрытой коробке — в сумму не входит.
            </p>
          </div>
        )}

        {cost.warnings.length > 0 && (
          <ul
            className="alert-stack"
            style={{ listStyle: 'none', padding: 0, margin: '0.85rem 0 0' }}
          >
            {cost.warnings.map((code) => (
              <li key={code} className="admin-note">
                <AlertTriangle size={14} strokeWidth={1.6} aria-hidden />
                <span>{COST_WARNING_LABELS[code] ?? code}</span>
              </li>
            ))}
          </ul>
        )}
      </AdminCard>
    </AdminPageShell>
  );
}
