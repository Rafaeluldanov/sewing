'use client';

/**
 * Клиентское представление «Документа производства по заказу» — план → факт
 * построчно (материалы + операции) с подсветкой расхождений и проваливанием
 * (раскрытием строки) в разбивку по размерам/цветам.
 *
 * Данные — `OrderProductionDocumentDto` (`GET /api/admin/production-cost/
 * order/:orderId/document`). Подсветка Δ: перерасход (факт > план) —
 * красным, экономия — зелёным. На незавершённом заказе факт частичный
 * (см. плашку готовности в шапке).
 */
import { Fragment, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import {
  PRODUCTION_DOC_MATERIAL_PLAN_SOURCE_LABELS,
  PRODUCTION_DOC_WARNING_LABELS,
  type OrderProductionBreakdownDto,
  type OrderProductionDocumentDto,
  type OrderProductionMaterialRowDto,
  type OrderProductionOperationRowDto,
} from '@sewing/shared/order-production-document';
import { AdminCard, AdminSectionHeader } from '@/components/admin';

function fmtRub(value: string | null): string {
  if (value == null) return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return (
    new Intl.NumberFormat('ru-RU', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n) + ' ₽'
  );
}

function fmtQty(value: string | null): string {
  if (value == null) return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  // до 3 знаков, без лишних нулей
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 }).format(n);
}

function fmtInt(n: number): string {
  return new Intl.NumberFormat('ru-RU').format(n);
}

function fmtDuration(sec: number | null): string {
  if (sec == null) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h > 0) return `${h} ч ${m} мин`;
  return `${m} мин`;
}

function varianceColor(value: string | null): string | undefined {
  if (value == null) return undefined;
  const n = Number(value);
  if (n > 0) return 'var(--admin-danger, #b91c1c)'; // перерасход
  if (n < 0) return 'var(--admin-success, #15803d)'; // экономия
  return undefined;
}

function Variance({ value }: { value: string | null }) {
  if (value == null) return <span className="admin-muted">—</span>;
  const n = Number(value);
  return (
    <span
      style={{
        color: varianceColor(value),
        fontVariantNumeric: 'tabular-nums',
        fontWeight: n !== 0 ? 600 : undefined,
      }}
    >
      {n > 0 ? '+' : ''}
      {fmtRub(value)}
    </span>
  );
}

function BreakdownRows({
  breakdown,
  colSpan,
  kind,
}: {
  breakdown: OrderProductionBreakdownDto[];
  colSpan: number;
  kind: 'material' | 'operation';
}) {
  if (breakdown.length === 0) {
    return (
      <tr>
        <td colSpan={colSpan} style={{ background: 'var(--admin-subtle, #f8f9fb)' }}>
          <span className="admin-muted" style={{ fontSize: 12 }}>
            Нет разбивки по размерам/цветам (факт не разнесён).
          </span>
        </td>
      </tr>
    );
  }
  return (
    <tr>
      <td colSpan={colSpan} style={{ background: 'var(--admin-subtle, #f8f9fb)', padding: 0 }}>
        <table className="admin-table" style={{ margin: 0 }}>
          <thead>
            <tr>
              <th style={{ paddingLeft: 40 }}>Размер</th>
              <th>Цвет</th>
              {kind === 'operation' && (
                <th style={{ textAlign: 'right' }}>План, шт</th>
              )}
              <th style={{ textAlign: 'right' }}>
                {kind === 'operation' ? 'Факт, шт' : 'Списано'}
              </th>
              <th style={{ textAlign: 'right' }}>Факт, ₽</th>
            </tr>
          </thead>
          <tbody>
            {breakdown.map((b, i) => (
              <tr key={i}>
                <td style={{ paddingLeft: 40 }}>{b.sizeCode ?? '—'}</td>
                <td>{b.color ?? '—'}</td>
                {kind === 'operation' && (
                  <td style={{ textAlign: 'right' }}>
                    {b.planQty != null ? fmtInt(b.planQty) : '—'}
                  </td>
                )}
                <td style={{ textAlign: 'right' }}>{fmtQty(b.factQty)}</td>
                <td style={{ textAlign: 'right' }}>{fmtRub(b.factRub)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </td>
    </tr>
  );
}

function ExpandCell({ open }: { open: boolean }) {
  return (
    <td style={{ width: 28, cursor: 'pointer', color: 'var(--admin-muted)' }}>
      {open ? (
        <ChevronDown size={16} strokeWidth={1.8} aria-hidden />
      ) : (
        <ChevronRight size={16} strokeWidth={1.8} aria-hidden />
      )}
    </td>
  );
}

function MaterialsTable({ rows }: { rows: OrderProductionMaterialRowDto[] }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (k: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  const COLS = 9;
  if (rows.length === 0) {
    return <p className="admin-muted">По заказу нет материалов.</p>;
  }
  return (
    <div className="admin-table-wrap">
      <table className="admin-table">
        <thead>
          <tr>
            <th />
            <th>Материал</th>
            <th style={{ textAlign: 'right' }}>План, кол-во</th>
            <th style={{ textAlign: 'right' }}>План, ₽</th>
            <th style={{ textAlign: 'right' }}>Списано, кол-во</th>
            <th style={{ textAlign: 'right' }}>Списано, ₽</th>
            <th style={{ textAlign: 'right' }}>Принято, ₽</th>
            <th style={{ textAlign: 'right' }}>Δ (списано − план)</th>
            <th>Источник плана</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const isOpen = open.has(r.key);
            return (
              <Fragment key={r.key}>
                <tr onClick={() => toggle(r.key)} style={{ cursor: 'pointer' }}>
                  <ExpandCell open={isOpen} />
                  <td>
                    <strong>{r.name}</strong>
                    {r.materialRole && (
                      <span
                        className="admin-muted"
                        style={{ marginLeft: 6, fontSize: 12 }}
                      >
                        {r.materialRole}
                      </span>
                    )}
                    {r.warnings.length > 0 && (
                      <span
                        title={r.warnings
                          .map((w) => PRODUCTION_DOC_WARNING_LABELS[w] ?? w)
                          .join('; ')}
                        style={{ marginLeft: 6, fontSize: 12 }}
                      >
                        ⚠
                      </span>
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {fmtQty(r.planQty)}
                    {r.planQty != null && (
                      <span className="admin-muted" style={{ marginLeft: 4 }}>
                        {r.unit}
                      </span>
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>{fmtRub(r.planRub)}</td>
                  <td style={{ textAlign: 'right' }}>
                    {fmtQty(r.issuedQty)}
                    <span className="admin-muted" style={{ marginLeft: 4 }}>
                      {r.unit}
                    </span>
                  </td>
                  <td style={{ textAlign: 'right' }}>{fmtRub(r.issuedRub)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtRub(r.receivedRub)}</td>
                  <td style={{ textAlign: 'right' }}>
                    <Variance value={r.varianceRub} />
                  </td>
                  <td>
                    <span className="admin-muted" style={{ fontSize: 12 }}>
                      {PRODUCTION_DOC_MATERIAL_PLAN_SOURCE_LABELS[r.planSource]}
                    </span>
                  </td>
                </tr>
                {isOpen && (
                  <BreakdownRows
                    breakdown={r.breakdown}
                    colSpan={COLS}
                    kind="material"
                  />
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function OperationsTable({ rows }: { rows: OrderProductionOperationRowDto[] }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (k: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  const COLS = 9;
  if (rows.length === 0) {
    return <p className="admin-muted">По заказу нет операций.</p>;
  }
  return (
    <div className="admin-table-wrap">
      <table className="admin-table">
        <thead>
          <tr>
            <th />
            <th>Операция</th>
            <th style={{ textAlign: 'right' }}>План, шт</th>
            <th style={{ textAlign: 'right' }}>Факт, шт</th>
            <th style={{ textAlign: 'right' }}>План, ₽</th>
            <th style={{ textAlign: 'right' }}>Факт, ₽</th>
            <th style={{ textAlign: 'right' }}>Δ (факт − план)</th>
            <th style={{ textAlign: 'right' }}>План, время</th>
            <th style={{ textAlign: 'right' }}>Подтв., ₽</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const isOpen = open.has(r.key);
            const pendingRub = Number(r.factRub) - Number(r.factApprovedRub);
            return (
              <Fragment key={r.key}>
                <tr onClick={() => toggle(r.key)} style={{ cursor: 'pointer' }}>
                  <ExpandCell open={isOpen} />
                  <td>
                    <strong>{r.operationName}</strong>
                    <span
                      className="admin-muted"
                      style={{ marginLeft: 6, fontSize: 12 }}
                    >
                      {r.operationCode}
                    </span>
                    {/* Пометки строки читала только таблица материалов —
                        из-за этого «факт без плана» в операциях был
                        неотличим от законно свёрнутой замены. */}
                    {r.warnings.length > 0 && (
                      <span
                        title={r.warnings
                          .map((w) => PRODUCTION_DOC_WARNING_LABELS[w] ?? w)
                          .join('; ')}
                        style={{ marginLeft: 6, fontSize: 12 }}
                      >
                        {r.warnings.includes('WORK_OUTSIDE_ROUTE') ? '🚫' : '⚠'}
                      </span>
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {r.planQty != null ? fmtInt(r.planQty) : '—'}
                  </td>
                  <td style={{ textAlign: 'right' }}>{fmtInt(r.factQty)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtRub(r.planRub)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtRub(r.factRub)}</td>
                  <td style={{ textAlign: 'right' }}>
                    <Variance value={r.varianceRub} />
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <span className="admin-muted">
                      {fmtDuration(r.planTimeSec)}
                    </span>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {fmtRub(r.factApprovedRub)}
                    {pendingRub > 0.004 && (
                      <span
                        className="admin-muted"
                        style={{ display: 'block', fontSize: 11 }}
                        title="Ещё не подтверждено (до упаковки)"
                      >
                        +{fmtRub(String(pendingRub))} в работе
                      </span>
                    )}
                  </td>
                </tr>
                {isOpen && (
                  <BreakdownRows
                    breakdown={r.breakdown}
                    colSpan={COLS}
                    kind="operation"
                  />
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function TotalRow({
  label,
  plan,
  fact,
  variance,
  strong,
}: {
  label: string;
  plan: string | null;
  fact: string | null;
  variance: string | null;
  strong?: boolean;
}) {
  return (
    <tr>
      <td style={{ fontWeight: strong ? 700 : undefined }}>{label}</td>
      <td style={{ textAlign: 'right' }}>{fmtRub(plan)}</td>
      <td style={{ textAlign: 'right', fontWeight: strong ? 700 : undefined }}>
        {fmtRub(fact)}
      </td>
      <td style={{ textAlign: 'right' }}>
        <Variance value={variance} />
      </td>
    </tr>
  );
}

export function ProductionDocumentView({
  document,
}: {
  document: OrderProductionDocumentDto;
}) {
  const t = document.totals;
  return (
    <>
      {document.warnings.length > 0 && (
        <AdminCard>
          <div
            className="admin-muted"
            style={{ fontSize: 13 }}
            role="note"
          >
            {document.warnings
              .map((w) => PRODUCTION_DOC_WARNING_LABELS[w] ?? w)
              .join(' · ')}
          </div>
        </AdminCard>
      )}
      {document.warnings.length > 0 && <div style={{ height: 16 }} />}

      <AdminCard>
        <AdminSectionHeader title="Материалы" hint="план → списано / принято" />
        <div style={{ height: 8 }} />
        <MaterialsTable rows={document.materials} />
      </AdminCard>

      <div style={{ height: 16 }} />

      <AdminCard>
        <AdminSectionHeader title="Операции" hint="план → факт" />
        <div style={{ height: 8 }} />
        <OperationsTable rows={document.operations} />
      </AdminCard>

      <div style={{ height: 16 }} />

      <AdminCard>
        <AdminSectionHeader title="Итого" />
        <div style={{ height: 8 }} />
        <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Показатель</th>
              <th style={{ textAlign: 'right' }}>План, ₽</th>
              <th style={{ textAlign: 'right' }}>Факт, ₽</th>
              <th style={{ textAlign: 'right' }}>Δ (факт − план)</th>
            </tr>
          </thead>
          <tbody>
            <TotalRow
              label="Материалы (списано)"
              plan={t.planMaterialsRub}
              fact={t.issuedMaterialsRub}
              variance={t.varianceMaterialsRub}
            />
            <tr>
              <td className="admin-muted" style={{ fontSize: 12 }}>
                в т.ч. принято (приёмки)
              </td>
              <td />
              <td style={{ textAlign: 'right' }} className="admin-muted">
                {fmtRub(t.receivedMaterialsRub)}
              </td>
              <td />
            </tr>
            <TotalRow
              label="Операции"
              plan={t.planOperationsRub}
              fact={t.factOperationsRub}
              variance={t.varianceOperationsRub}
            />
            <TotalRow
              label="Прямая себестоимость"
              plan={t.planDirectRub}
              fact={t.factDirectRub}
              variance={t.varianceDirectRub}
              strong
            />
            {t.revenueRub != null && (
              <>
                <tr>
                  <td>Выручка</td>
                  <td />
                  <td style={{ textAlign: 'right' }}>{fmtRub(t.revenueRub)}</td>
                  <td />
                </tr>
                <tr>
                  <td style={{ fontWeight: 700 }}>Маржа</td>
                  <td />
                  <td
                    style={{
                      textAlign: 'right',
                      fontWeight: 700,
                      color:
                        t.marginRub != null && Number(t.marginRub) < 0
                          ? 'var(--admin-danger, #b91c1c)'
                          : 'var(--admin-success, #15803d)',
                    }}
                  >
                    {fmtRub(t.marginRub)}
                  </td>
                  <td />
                </tr>
              </>
            )}
          </tbody>
        </table>
        </div>
      </AdminCard>
    </>
  );
}
