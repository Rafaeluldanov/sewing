'use client';

/**
 * «Очередь выдачи кроя по размерам» — UI-блок в карточке заказа.
 *
 * Backend контракт (см.
 * `apps/api/src/modules/order-cut-issue-rules/*`,
 * `@sewing/shared/order-cut-issue-rules`,
 * `docs/api.md §«Очередь выдачи кроя»`,
 * `docs/order-flow.md §«Очередь выдачи кроя»`):
 *   - `GET /api/orders/:id/cut-issue-rules` — список + сводка;
 *   - `POST /api/orders/:id/cut-issue-rules` — bulk upsert;
 *   - `POST /api/orders/:id/cut-issue-rules/disable-all` — выключить.
 *
 * RBAC — менеджерская тройка (`SHOP_MANAGER` / `SHOPFLOOR_MASTER` /
 * `ADMIN`). Для остальных ролей `canManage = false` → блок остаётся
 * read-only (без формы / кнопок), но прогресс / статус / список
 * показываем (нужно цеху для диагностики «почему не выдаётся крой»).
 *
 * Дизайн UI намеренно «инлайновый», без отдельных стилей-ов —
 * соответствует стилистике остальных карточек на `/orders/[id]`
 * (см., например, `MaterialsSnapshotCard` / `RouteSnapshotCard`).
 *
 * Контракт формы — JSON-массив строк в hidden input `rows`. Это
 * проще, чем парсить десятки полей `requiredQty[<sizeId>]` на
 * стороне server action, а форма всё равно динамическая (добавление /
 * удаление строк).
 */
import { useEffect, useMemo, useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import type { OrderItemDto } from '@sewing/shared/orders';
import type {
  OrderCutIssueRuleDto,
  OrderCutIssueRulesSummaryDto,
  OrderCutIssueRuleStatus,
} from '@sewing/shared';
import {
  type OrderCutIssueRulesActionState,
  disableOrderCutIssueRulesAction,
  saveOrderCutIssueRulesAction,
} from '@/app/orders/actions';

interface Props {
  orderId: string;
  orderItems: OrderItemDto[];
  initialSummary: OrderCutIssueRulesSummaryDto;
  canManage: boolean;
}

interface DraftRow {
  sizeId: string;
  sizeCode: string;
  requiredQty: number;
  // Прогресс/выдача отдаём только для существующих строк — формы их
  // не редактируют, но рисуем рядом, чтобы менеджер видел контекст.
  issuedQty: number;
  remainingQty: number;
  progressPct: number;
  isExisting: boolean;
}

const STATUS_LABELS: Record<OrderCutIssueRuleStatus, string> = {
  OFF: 'Выключена',
  IN_PROGRESS: 'Активна',
  DONE: 'Выполнена',
};

const STATUS_COLORS: Record<OrderCutIssueRuleStatus, string> = {
  OFF: 'rgba(148, 163, 184, 0.18)',
  IN_PROGRESS: 'rgba(245, 158, 11, 0.18)',
  DONE: 'rgba(34, 197, 94, 0.20)',
};

const initialState: OrderCutIssueRulesActionState = {};

export function OrderCutIssueRulesCard({
  orderId,
  orderItems,
  initialSummary,
  canManage,
}: Props) {
  const [summary, setSummary] = useState(initialSummary);
  // Все размеры заказа — допустимый «справочник» для select-а
  // «добавить размер». Группируем `OrderItem` по `sizeId`, потому что
  // на одном размере может быть несколько строк (например, для разных
  // изделий внутри одного заказа), а в очередь размер кладётся один
  // раз.
  const orderSizesById = useMemo(() => {
    const m = new Map<
      string,
      { sizeId: string; sizeCode: string; sortOrder: number; qtyPlan: number }
    >();
    for (const it of orderItems) {
      const prev = m.get(it.sizeId);
      m.set(it.sizeId, {
        sizeId: it.sizeId,
        sizeCode: it.sizeCode,
        sortOrder: it.sizeSortOrder,
        qtyPlan: (prev?.qtyPlan ?? 0) + it.qtyPlan,
      });
    }
    return Array.from(m.values()).sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      return a.sizeCode.localeCompare(b.sizeCode);
    });
  }, [orderItems]);
  const planBySizeId = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of orderSizesById) m.set(s.sizeId, s.qtyPlan);
    return m;
  }, [orderSizesById]);

  const [draft, setDraft] = useState<DraftRow[]>(() =>
    summaryToDraft(summary),
  );
  // Если родитель вернул свежий summary (после revalidatePath /
  // navigation), синхронизируем форму. На MVP «грязный draft» терять
  // не страшно: пользователь либо нажал «Сохранить» (тогда summary
  // уже отражает его правки), либо ушёл со страницы.
  useEffect(() => {
    setSummary(initialSummary);
    setDraft(summaryToDraft(initialSummary));
  }, [initialSummary]);

  const saveAction = saveOrderCutIssueRulesAction.bind(null, orderId);
  const [saveState, saveFormAction] = useFormState(saveAction, initialState);
  const disableAction = disableOrderCutIssueRulesAction.bind(null, orderId);
  const [disableState, disableFormAction] = useFormState(
    disableAction,
    initialState,
  );

  // После успеха action сервер вернёт свежий summary; сразу обновим
  // локальный state, чтобы форма не моргала «старыми» данными между
  // ответом action и следующим server-rendered обновлением.
  useEffect(() => {
    if (saveState.ok && saveState.summary) {
      setSummary(saveState.summary);
      setDraft(summaryToDraft(saveState.summary));
    }
  }, [saveState]);
  useEffect(() => {
    if (disableState.ok && disableState.summary) {
      setSummary(disableState.summary);
      setDraft(summaryToDraft(disableState.summary));
    }
  }, [disableState]);

  function addRow(sizeId: string) {
    if (!sizeId) return;
    if (draft.some((r) => r.sizeId === sizeId)) return;
    const sz = orderSizesById.find((s) => s.sizeId === sizeId);
    if (!sz) return;
    setDraft((prev) => [
      ...prev,
      {
        sizeId,
        sizeCode: sz.sizeCode,
        requiredQty: sz.qtyPlan,
        issuedQty: 0,
        remainingQty: sz.qtyPlan,
        progressPct: 0,
        isExisting: false,
      },
    ]);
  }

  function removeRow(sizeId: string) {
    setDraft((prev) => prev.filter((r) => r.sizeId !== sizeId));
  }

  function updateQty(sizeId: string, value: string) {
    const n = Math.max(0, Math.trunc(Number(value) || 0));
    setDraft((prev) =>
      prev.map((r) => (r.sizeId === sizeId ? { ...r, requiredQty: n } : r)),
    );
  }

  const sizesNotInDraft = orderSizesById.filter(
    (s) => !draft.some((d) => d.sizeId === s.sizeId),
  );

  const formError = saveState.error ?? disableState.error;
  const status = summary.status;

  return (
    <div
      className="card"
      style={{ marginBottom: '1rem' }}
      data-testid="order-cut-issue-rules-card"
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: '0.5rem',
          marginBottom: '0.5rem',
        }}
      >
        <h2 style={{ margin: 0, fontSize: '1.05rem' }}>
          Очередь выдачи кроя
        </h2>
        <span
          style={{
            display: 'inline-block',
            padding: '2px 8px',
            borderRadius: 999,
            background: STATUS_COLORS[status],
            fontSize: '0.75rem',
          }}
          data-testid="order-cut-issue-rules-status"
        >
          {STATUS_LABELS[status]}
        </span>
      </div>

      <p className="meta-line" style={{ marginTop: 0 }}>
        Пока очередь активна, швея может получить только паспорта
        размеров из списка. Когда все строки выполнены, выдача
        остальных размеров становится свободной.
      </p>

      {summary.rules.length === 0 && draft.length === 0 ? (
        <div className="meta-line" style={{ marginBottom: '0.5rem' }}>
          Очередь выдачи кроя по заказу не задана.
        </div>
      ) : (
        <RulesProgressTable rules={summary.rules} />
      )}

      {canManage && (
        <form action={saveFormAction} style={{ marginTop: '0.75rem' }}>
          <input type="hidden" name="rows" value={draftToJson(draft)} />

          {draft.length > 0 && (
            <table className="data-table" style={{ marginBottom: '0.5rem' }}>
              <thead>
                <tr>
                  <th>Размер</th>
                  <th className="num">План</th>
                  <th className="num">Нужно выдать</th>
                  <th className="num">Уже выдано</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {draft.map((r) => {
                  const planQty = planBySizeId.get(r.sizeId) ?? 0;
                  const overPlan = r.requiredQty > planQty;
                  const belowIssued = r.requiredQty < r.issuedQty;
                  return (
                    <tr key={r.sizeId}>
                      <td>
                        <strong>{r.sizeCode}</strong>
                      </td>
                      <td className="num">{planQty}</td>
                      <td className="num">
                        <input
                          type="number"
                          min={0}
                          max={planQty}
                          value={r.requiredQty}
                          onChange={(e) =>
                            updateQty(r.sizeId, e.target.value)
                          }
                          style={{ width: 80, textAlign: 'right' }}
                          aria-invalid={overPlan || belowIssued}
                        />
                        {overPlan && (
                          <div
                            className="meta-line"
                            style={{ color: '#b91c1c', fontSize: '0.7rem' }}
                          >
                            Не больше {planQty}
                          </div>
                        )}
                        {belowIssued && (
                          <div
                            className="meta-line"
                            style={{ color: '#b91c1c', fontSize: '0.7rem' }}
                          >
                            Уже выдано {r.issuedQty}
                          </div>
                        )}
                      </td>
                      <td className="num">{r.issuedQty}</td>
                      <td>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => removeRow(r.sizeId)}
                          aria-label={`Удалить строку ${r.sizeCode}`}
                        >
                          Удалить
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {sizesNotInDraft.length > 0 && (
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '0.5rem',
                alignItems: 'center',
                marginBottom: '0.5rem',
              }}
            >
              <label className="meta-line" htmlFor="ocr-add-size">
                Добавить размер:
              </label>
              <select
                id="ocr-add-size"
                defaultValue=""
                onChange={(e) => {
                  addRow(e.target.value);
                  e.target.value = '';
                }}
              >
                <option value="" disabled>
                  Выберите размер из заказа…
                </option>
                {sizesNotInDraft.map((s) => (
                  <option key={s.sizeId} value={s.sizeId}>
                    {s.sizeCode} (план {s.qtyPlan})
                  </option>
                ))}
              </select>
            </div>
          )}

          <div
            className="actions-row"
            style={{ margin: 0, display: 'flex', gap: '0.5rem' }}
          >
            <SaveButton hasRows={draft.length > 0} />
          </div>
          {saveState.ok && (
            <div
              className="meta-line"
              role="status"
              style={{ color: '#1f7a1f', marginTop: 4 }}
            >
              Очередь сохранена.
            </div>
          )}
        </form>
      )}

      {canManage && summary.rules.some((r) => r.isActive) && (
        <form action={disableFormAction} style={{ marginTop: '0.5rem' }}>
          <DisableButton />
          {disableState.ok && (
            <span
              className="meta-line"
              role="status"
              style={{ marginLeft: 8, color: '#1f7a1f' }}
            >
              Очередь отключена.
            </span>
          )}
        </form>
      )}

      {formError && (
        <div
          className="error-box"
          role="alert"
          style={{ marginTop: '0.5rem' }}
        >
          {formError}
        </div>
      )}

      {!canManage && (
        <div className="meta-line" style={{ marginTop: '0.5rem' }}>
          Редактирование доступно только менеджеру цеха.
        </div>
      )}
    </div>
  );
}

function RulesProgressTable({ rules }: { rules: OrderCutIssueRuleDto[] }) {
  if (rules.length === 0) return null;
  return (
    <table className="data-table" style={{ marginBottom: '0.5rem' }}>
      <thead>
        <tr>
          <th>Размер</th>
          <th className="num">Нужно</th>
          <th className="num">Выдано</th>
          <th className="num">Осталось</th>
          <th>Прогресс</th>
          <th>Активна</th>
        </tr>
      </thead>
      <tbody>
        {rules.map((r) => (
          <tr key={r.id}>
            <td>
              <strong>{r.sizeCode}</strong>
            </td>
            <td className="num">{r.requiredQty}</td>
            <td className="num">{r.issuedQty}</td>
            <td className="num">{r.remainingQty}</td>
            <td>
              <div
                aria-label={`Прогресс ${r.progressPct}%`}
                style={{
                  width: 120,
                  height: 8,
                  background: '#e5e7eb',
                  borderRadius: 4,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: `${Math.max(0, Math.min(100, r.progressPct))}%`,
                    height: '100%',
                    background: r.progressPct >= 100 ? '#16a34a' : '#f59e0b',
                  }}
                />
              </div>
              <span className="meta-line" style={{ fontSize: '0.7rem' }}>
                {r.progressPct}%
              </span>
            </td>
            <td>{r.isActive ? 'Да' : 'Нет'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SaveButton({ hasRows }: { hasRows: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="btn btn-primary"
      disabled={pending || !hasRows}
    >
      {pending ? 'Сохраняем…' : 'Сохранить очередь'}
    </button>
  );
}

function DisableButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-danger" disabled={pending}>
      {pending ? 'Отключаем…' : 'Отключить очередь'}
    </button>
  );
}

function summaryToDraft(s: OrderCutIssueRulesSummaryDto): DraftRow[] {
  return s.rules
    .filter((r) => r.isActive)
    .map((r) => ({
      sizeId: r.sizeId,
      sizeCode: r.sizeCode,
      requiredQty: r.requiredQty,
      issuedQty: r.issuedQty,
      remainingQty: r.remainingQty,
      progressPct: r.progressPct,
      isExisting: true,
    }));
}

function draftToJson(rows: DraftRow[]): string {
  return JSON.stringify(
    rows
      .filter((r) => r.requiredQty > 0)
      .map((r, idx) => ({
        sizeId: r.sizeId,
        requiredQty: r.requiredQty,
        sortOrder: idx,
      })),
  );
}
