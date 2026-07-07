/**
 * Документ производства по заказу (`/admin/production-cost/order/[orderId]`).
 *
 * Провал из вкладки «По заказам» отчёта «Себестоимость производства».
 * План → факт построчно: материалы (план / списано / принято / Δ) и
 * операции (план / факт / Δ), с проваливанием в разбивку по размерам/цветам
 * и подсветкой расхождений.
 *
 * Backend: `GET /api/admin/production-cost/order/:orderId/document`
 * (`OrderProductionDocumentService`). Read-only, RBAC `ADMIN`/`SHOP_MANAGER`.
 * Себестоимость потребляет факт (расход, приёмки, выработка); проводок не пишет.
 */
import Link from 'next/link';
import { ArrowLeft, FileText } from 'lucide-react';
import { ApiRequestError, errorText } from '@/lib/api';
import { getOrderProductionDocument } from '@/lib/order-production-document-api';
import { AdminCard, AdminPageShell } from '@/components/admin';
import { ProductionDocumentView } from './production-document-view';

export const dynamic = 'force-dynamic';

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div style={{ minWidth: 110 }}>
      <div style={{ color: 'var(--admin-muted)', fontSize: 12 }}>{label}</div>
      <div
        style={{
          fontSize: 18,
          fontWeight: 700,
          color: accent,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </div>
    </div>
  );
}

function rub2(value: string | null): string {
  if (value == null) return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

/** Крупная плитка себестоимости за единицу (план / факт / разница). */
function UnitCostTile({
  label,
  value,
  accent,
  sign,
}: {
  label: string;
  value: string | null;
  accent?: string;
  sign?: boolean;
}) {
  const n = value != null ? Number(value) : null;
  const prefix = sign && n != null && n > 0 ? '+' : '';
  return (
    <div style={{ minWidth: 150 }}>
      <div style={{ color: 'var(--admin-muted)', fontSize: 12 }}>{label}</div>
      <div
        style={{
          fontSize: 24,
          fontWeight: 800,
          color: accent,
          fontVariantNumeric: 'tabular-nums',
          lineHeight: 1.2,
        }}
      >
        {value != null ? `${prefix}${rub2(value)} ₽` : '—'}
      </div>
    </div>
  );
}

export default async function OrderProductionDocumentPage({
  params,
}: {
  params: { orderId: string };
}) {
  let document: Awaited<
    ReturnType<typeof getOrderProductionDocument>
  > | null = null;
  let error: string | null = null;
  try {
    document = await getOrderProductionDocument(params.orderId);
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? errorText(e)
        : 'Не удалось загрузить документ производства';
  }

  const h = document?.header;
  const readinessAccent =
    h && h.readinessPct >= 100
      ? 'var(--admin-success, #15803d)'
      : undefined;
  const unitVar = h?.unitCostVarianceRub != null ? Number(h.unitCostVarianceRub) : null;
  const unitVarAccent =
    unitVar == null
      ? undefined
      : unitVar > 0
        ? 'var(--admin-danger, #b91c1c)' // дороже плана
        : unitVar < 0
          ? 'var(--admin-success, #15803d)' // дешевле плана
          : undefined;

  return (
    <AdminPageShell
      icon={<FileText size={22} strokeWidth={1.6} aria-hidden />}
      title={
        h ? `Документ производства · ${h.orderNumber}` : 'Документ производства'
      }
      subtitle={
        h
          ? [
              h.clientName,
              h.nomenclatureName,
              h.color,
              `готовность ${h.readinessPct}%`,
            ]
              .filter(Boolean)
              .join(' · ')
          : undefined
      }
      actions={
        <div style={{ display: 'flex', gap: 8 }}>
          {h && (
            <Link
              href={`/admin/orders/${h.orderId}`}
              className="admin-btn admin-btn--ghost"
            >
              Карточка заказа
            </Link>
          )}
          <Link
            href="/admin/production-cost?tab=orders"
            className="admin-btn admin-btn--ghost"
          >
            <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />К себестоимости
          </Link>
        </div>
      }
    >
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      {h && document && (
        <>
          <AdminCard>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 32,
                rowGap: 16,
                alignItems: 'flex-end',
                paddingBottom: 16,
                marginBottom: 16,
                borderBottom: '1px solid var(--admin-border, #e5e7eb)',
              }}
            >
              <UnitCostTile
                label="Плановая с/с за единицу"
                value={h.planUnitCostRub}
              />
              <UnitCostTile
                label="Фактическая с/с за единицу"
                value={h.factUnitCostRub}
                accent={unitVarAccent}
              />
              <UnitCostTile
                label="Разница на единицу"
                value={h.unitCostVarianceRub}
                accent={unitVarAccent}
                sign
              />
            </div>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 24,
                rowGap: 16,
              }}
            >
              <Stat label="Статус" value={h.status} />
              <Stat label="План, шт" value={new Intl.NumberFormat('ru-RU').format(h.qtyPlanTotal)} />
              <Stat label="Раскроено, шт" value={new Intl.NumberFormat('ru-RU').format(h.qtyCutTotal)} />
              <Stat
                label="Годных упаковано, шт"
                value={new Intl.NumberFormat('ru-RU').format(h.qtyGoodPackedTotal)}
              />
              <Stat label="Брак, шт" value={new Intl.NumberFormat('ru-RU').format(h.qtyDefectTotal)} />
              <Stat
                label="Готовность"
                value={`${h.readinessPct}%`}
                accent={readinessAccent}
              />
              {h.revenueRub != null && (
                <Stat
                  label="Выручка, ₽"
                  value={new Intl.NumberFormat('ru-RU', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  }).format(Number(h.revenueRub))}
                />
              )}
            </div>
            <p className="admin-muted" style={{ marginTop: 16, marginBottom: 0, fontSize: 13 }}>
              План зафиксирован при запуске заказа в работу. Факт — на текущий
              момент: списание материалов (нетто возвратов), приёмки и
              сдельная выработка (включая ещё не подтверждённую до упаковки).
              На незавершённом заказе факт частичный — красным подсвечен
              перерасход, зелёным экономия. Провалитесь в строку, чтобы увидеть
              разбивку по размерам/цветам.
            </p>
          </AdminCard>

          <div style={{ height: 16 }} />

          <ProductionDocumentView document={document} />
        </>
      )}
    </AdminPageShell>
  );
}
