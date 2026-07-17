/**
 * Сравнение потребностей по вариантам просчёта (фича
 * `FEATURE_ORDER_CALCULATIONS`, итерация 2 «потребности per вариант»).
 *
 * Строки `WorkshopNeed` сосуществуют для нескольких вариантов заказа
 * (`orderCalculationId`). Канонический вид материалов вкладки
 * («OrderMaterialsUnifiedTable») показывает только АКТИВНЫЙ вариант —
 * этот блок дополняет его компактным сравнением ВСЕХ вариантов:
 * секция на вариант (метка + Σ по строкам с ценой), read-only.
 *
 * Вариант без строк — ещё не рассчитан: расчёт варианта происходит при
 * его активации (клик по вкладке варианта) либо при «+ Вариант
 * просчёта» на заказе в статусе «Расчёт».
 *
 * Рендерится только когда у заказа >1 варианта. Server component,
 * падение fetch-а не валит вкладку.
 */
import { Layers } from 'lucide-react';
import {
  WORKSHOP_NEED_STATUS_LABELS,
  type WorkshopNeedListItemDto,
  type WorkshopNeedStatus,
} from '@sewing/shared/workshop-needs';
import { AdminCard, AdminSectionHeader } from '@/components/admin';
import { getOrderCalculations } from '@/lib/order-calculations-api';
import { getOrderWorkshopNeeds } from '@/lib/workshop-needs-api';

interface Props {
  orderId: string;
}

function fmtQty(value: string | null): string {
  if (value == null) return '—';
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return num.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
}

function fmtRub(value: number): string {
  return `${value.toLocaleString('ru-RU', { maximumFractionDigits: 0 })} ₽`;
}

/** Σ по строкам с ценой: (purchaseQty ?? calculatedQty) × quotedPrice, RUB. */
function sumRub(rows: WorkshopNeedListItemDto[]): {
  total: number;
  priced: number;
} {
  let total = 0;
  let priced = 0;
  for (const r of rows) {
    if (r.quotedPrice == null) continue;
    if ((r.quotedCurrency ?? 'RUB') !== 'RUB') continue;
    const qty = Number(r.purchaseQty ?? r.calculatedQty);
    const price = Number(r.quotedPrice);
    if (!Number.isFinite(qty) || !Number.isFinite(price)) continue;
    total += qty * price;
    priced += 1;
  }
  return { total, priced };
}

export async function OrderCalcNeedsComparison({ orderId }: Props) {
  let calculations;
  let needs: WorkshopNeedListItemDto[];
  try {
    [calculations, needs] = await Promise.all([
      getOrderCalculations(orderId),
      getOrderWorkshopNeeds(orderId, { calculationScope: 'ALL' }),
    ]);
  } catch {
    return null;
  }
  if (calculations.items.length <= 1) return null;

  const byCalc = new Map<string, WorkshopNeedListItemDto[]>();
  for (const n of needs) {
    if (!n.orderCalculationId) continue; // sample/legacy — вне сравнения
    const arr = byCalc.get(n.orderCalculationId) ?? [];
    arr.push(n);
    byCalc.set(n.orderCalculationId, arr);
  }

  return (
    <AdminCard>
      <AdminSectionHeader
        icon={<Layers size={18} strokeWidth={1.7} aria-hidden />}
        title="Потребности по вариантам просчёта"
        hint="каждый вариант считается отдельно; таблица выше и закупка — только активный"
      />
      <div className="calc-needs-compare">
        {calculations.items.map((calc) => {
          const rows = byCalc.get(calc.id) ?? [];
          const { total, priced } = sumRub(rows);
          return (
            <section key={calc.id} className="calc-needs-compare__section">
              <div className="calc-needs-compare__head">
                <span className="calc-needs-compare__title">
                  {calc.title}
                  {calc.isActive ? (
                    <span className="calc-needs-compare__badge">активный</span>
                  ) : null}
                </span>
                {rows.length > 0 ? (
                  <span className="calc-needs-compare__sum">
                    {priced > 0
                      ? `${fmtRub(total)} · строк с ценой: ${priced}/${rows.length}`
                      : `строк: ${rows.length}, цены не заполнены`}
                  </span>
                ) : null}
              </div>
              {rows.length === 0 ? (
                <p className="calc-needs-compare__hint">
                  Вариант ещё не отправлен на расчёт — переключитесь на его
                  вкладку и нажмите «Рассчитать вариант».
                </p>
              ) : (
                <div className="admin-table-wrap">
                  <table className="admin-table calc-needs-compare__table">
                    <thead>
                      <tr>
                        <th>Материал</th>
                        <th>Расцветка</th>
                        <th>Кол-во</th>
                        <th>Ед.</th>
                        <th>Цена</th>
                        <th>Статус</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.id}>
                          <td>{r.description}</td>
                          <td>{r.variantColor ?? '—'}</td>
                          <td>{fmtQty(r.purchaseQty ?? r.calculatedQty)}</td>
                          <td>{r.unit}</td>
                          <td>
                            {r.quotedPrice != null
                              ? `${fmtQty(r.quotedPrice)} ${r.quotedCurrency ?? 'RUB'}`
                              : '—'}
                          </td>
                          <td>
                            {WORKSHOP_NEED_STATUS_LABELS[
                              r.status as WorkshopNeedStatus
                            ] ?? r.status}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          );
        })}
      </div>
    </AdminCard>
  );
}
