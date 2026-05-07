'use client';

/**
 * «Очередь выдачи кроя по размерам» — UI-блок в карточке заказа.
 *
 * Backend контракт (см.
 * `apps/api/src/modules/order-cut-issue-rules/*`,
 * `@sewing/shared/order-cut-issue-rules`,
 * `docs/api.md §«Очередь выдачи кроя»`,
 * `docs/order-flow.md §«Очередь выдачи кроя»`):
 *   - `GET /api/orders/:id/cut-issue-rules` — список очередей + сводка;
 *   - `POST /api/orders/:id/cut-issue-rules` — bulk upsert одной очереди;
 *   - `POST /api/orders/:id/cut-issue-rules/disable-all` — выключить;
 *   - `DELETE /api/orders/:id/cut-issue-rules/queues/:queueIndex` —
 *     удалить пустую последнюю очередь.
 *
 * Multi-queue UX:
 *   - таблица очереди рендерится для каждой `summary.queues[*]`;
 *   - последняя колонка таблицы — «План» (исходный план размера в
 *     заказе, общий для всех очередей);
 *   - под каждой очередью кнопка «Редактировать очередь» —
 *     открывает форму редактирования ИМЕННО этой очереди;
 *   - под последней очередью — кнопка «Добавить очередь»; при клике
 *     создаётся черновик новой очереди (`queueIndex = maxIdx + 1`),
 *     поле «Нужно» автозаполняется как `план − Σ requiredQty по
 *     этому размеру в активных строках предыдущих очередей`;
 *   - под последней очередью без выдачи — кнопка «Удалить очередь».
 *
 * RBAC — менеджерская тройка (`SHOP_MANAGER` / `SHOPFLOOR_MASTER` /
 * `ADMIN`). Для остальных ролей `canManage = false` → блок остаётся
 * read-only (без формы / кнопок), но прогресс / статус / список
 * показываем (нужно цеху для диагностики «почему не выдаётся крой»).
 */
import { useEffect, useMemo, useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import type { OrderItemDto } from '@sewing/shared/orders';
import type {
  OrderCutIssueQueueDto,
  OrderCutIssueRuleDto,
  OrderCutIssueRulesSummaryDto,
  OrderCutIssueRuleStatus,
} from '@sewing/shared';
import {
  type OrderCutIssueRulesActionState,
  disableOrderCutIssueQueueAction,
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
  issuedQty: number;
  remainingQty: number;
  progressPct: number;
  isExisting: boolean;
}

interface EditState {
  queueIndex: number;
  /** `true` — это локально созданная новая очередь, ещё не сохранённая на сервере. */
  isNew: boolean;
  rows: DraftRow[];
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
  const [editing, setEditing] = useState<EditState | null>(null);

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

  // Σ requiredQty по активным строкам всех очередей (по sizeId) —
  // используется для расчёта «остатка плана» при создании новой
  // очереди и при редактировании существующей.
  const claimedBySizeAcrossQueues = useMemo(() => {
    const m = new Map<string, number>();
    for (const q of summary.queues) {
      for (const r of q.rules) {
        if (!r.isActive) continue;
        m.set(r.sizeId, (m.get(r.sizeId) ?? 0) + r.requiredQty);
      }
    }
    return m;
  }, [summary]);

  const maxQueueIndex = useMemo(
    () => summary.queues.reduce((m, q) => (q.queueIndex > m ? q.queueIndex : m), 0),
    [summary],
  );

  // Если родитель прислал свежий summary, синхронизируем; черновик
  // редактирования сбрасываем — пользователь либо сохранил, либо
  // ушёл со страницы.
  useEffect(() => {
    setSummary(initialSummary);
  }, [initialSummary]);

  const saveAction = saveOrderCutIssueRulesAction.bind(null, orderId);
  const [saveState, saveFormAction] = useFormState(saveAction, initialState);
  const disableQueueAction = disableOrderCutIssueQueueAction.bind(null, orderId);
  const [disableState, disableQueueFormAction] = useFormState(
    disableQueueAction,
    initialState,
  );

  // Любое успешное действие сервер вернёт свежий summary. Применяем его
  // и закрываем форму редактирования.
  useEffect(() => {
    if (saveState.ok && saveState.summary) {
      setSummary(saveState.summary);
      setEditing(null);
    }
  }, [saveState]);
  useEffect(() => {
    if (disableState.ok && disableState.summary) {
      setSummary(disableState.summary);
      setEditing(null);
    }
  }, [disableState]);

  /**
   * Σ requiredQty по активным строкам очередей с индексом меньше `queueIndex`.
   * Это «уже занятая планом часть» — её нельзя занимать в текущей очереди.
   */
  function claimedInPriorQueues(queueIndex: number): Map<string, number> {
    const m = new Map<string, number>();
    for (const q of summary.queues) {
      if (q.queueIndex >= queueIndex) continue;
      for (const r of q.rules) {
        if (!r.isActive) continue;
        m.set(r.sizeId, (m.get(r.sizeId) ?? 0) + r.requiredQty);
      }
    }
    return m;
  }

  /**
   * Остаток плана по размерам для очереди `queueIndex`. Используется
   * как:
   *   - автозаполнение «Нужно» при создании новой очереди;
   *   - верхний предел редактирования внутри окна (для уже
   *     существующей очереди — `план − Σ requiredQty в ДРУГИХ
   *     активных очередях`).
   */
  function remainderForQueue(queueIndex: number): Map<string, number> {
    const m = new Map<string, number>();
    const claimedOther = new Map<string, number>();
    for (const q of summary.queues) {
      if (q.queueIndex === queueIndex) continue;
      for (const r of q.rules) {
        if (!r.isActive) continue;
        claimedOther.set(
          r.sizeId,
          (claimedOther.get(r.sizeId) ?? 0) + r.requiredQty,
        );
      }
    }
    for (const s of orderSizesById) {
      const taken = claimedOther.get(s.sizeId) ?? 0;
      m.set(s.sizeId, Math.max(s.qtyPlan - taken, 0));
    }
    return m;
  }

  function queueToDraft(queue: OrderCutIssueQueueDto): DraftRow[] {
    return queue.rules
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

  function startEdit(queue: OrderCutIssueQueueDto) {
    setEditing({
      queueIndex: queue.queueIndex,
      isNew: false,
      rows: queueToDraft(queue),
    });
  }

  function startAddQueue() {
    const nextIdx = maxQueueIndex + 1;
    const claimed = claimedBySizeAcrossQueues;
    const rows: DraftRow[] = [];
    for (const s of orderSizesById) {
      const remainder = Math.max(
        s.qtyPlan - (claimed.get(s.sizeId) ?? 0),
        0,
      );
      if (remainder <= 0) continue;
      rows.push({
        sizeId: s.sizeId,
        sizeCode: s.sizeCode,
        requiredQty: remainder,
        issuedQty: 0,
        remainingQty: remainder,
        progressPct: 0,
        isExisting: false,
      });
    }
    setEditing({ queueIndex: nextIdx, isNew: true, rows });
  }

  function cancelEdit() {
    setEditing(null);
  }

  function updateDraftQty(sizeId: string, value: string) {
    if (!editing) return;
    const n = Math.max(0, Math.trunc(Number(value) || 0));
    setEditing({
      ...editing,
      rows: editing.rows.map((r) =>
        r.sizeId === sizeId ? { ...r, requiredQty: n } : r,
      ),
    });
  }

  function removeDraftRow(sizeId: string) {
    if (!editing) return;
    setEditing({
      ...editing,
      rows: editing.rows.filter((r) => r.sizeId !== sizeId),
    });
  }

  function addDraftRow(sizeId: string) {
    if (!editing) return;
    if (!sizeId) return;
    if (editing.rows.some((r) => r.sizeId === sizeId)) return;
    const sz = orderSizesById.find((s) => s.sizeId === sizeId);
    if (!sz) return;
    const remainder = remainderForQueue(editing.queueIndex);
    const upper = remainder.get(sizeId) ?? sz.qtyPlan;
    setEditing({
      ...editing,
      rows: [
        ...editing.rows,
        {
          sizeId,
          sizeCode: sz.sizeCode,
          requiredQty: upper,
          issuedQty: 0,
          remainingQty: upper,
          progressPct: 0,
          isExisting: false,
        },
      ],
    });
  }

  const formError = saveState.error ?? disableState.error;
  const status = summary.status;

  const hasAnyQueue = summary.queues.length > 0;

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
        Очередей может быть несколько: пока активна текущая, швея может
        получить только паспорта её размеров. Когда все строки текущей
        очереди выполнены, активной становится следующая.
      </p>

      {!hasAnyQueue && !editing && (
        <div className="meta-line" style={{ marginBottom: '0.5rem' }}>
          Очередь выдачи кроя по заказу не задана.
        </div>
      )}

      {summary.queues.map((queue) => {
        const isLast = queue.queueIndex === maxQueueIndex;
        const isEditingThis =
          editing !== null &&
          !editing.isNew &&
          editing.queueIndex === queue.queueIndex;
        const hasActiveRows = queue.rules.some((r) => r.isActive);
        return (
          <div
            key={queue.queueIndex}
            data-testid={`order-cut-issue-queue-${queue.queueIndex}`}
            style={{ marginBottom: '1rem' }}
          >
            <QueueHeader queue={queue} />
            <RulesProgressTable
              rules={queue.rules.filter((r) => r.isActive)}
              planBySizeId={planBySizeId}
            />
            {canManage && !isEditingThis && (
              <div
                className="actions-row"
                style={{
                  margin: 0,
                  display: 'flex',
                  gap: '0.5rem',
                  flexWrap: 'wrap',
                }}
              >
                <button
                  type="button"
                  className="btn"
                  onClick={() => startEdit(queue)}
                  disabled={editing !== null}
                  data-testid={`btn-edit-queue-${queue.queueIndex}`}
                >
                  Редактировать очередь
                </button>
                {isLast && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={startAddQueue}
                    disabled={editing !== null}
                    data-testid="btn-add-queue"
                  >
                    Добавить очередь
                  </button>
                )}
                {hasActiveRows && (
                  <DisableQueueButton
                    formAction={disableQueueFormAction}
                    queueIndex={queue.queueIndex}
                    disabled={editing !== null}
                  />
                )}
              </div>
            )}
            {isEditingThis && editing && (
              <EditQueueForm
                editing={editing}
                planBySizeId={planBySizeId}
                remainderForQueue={remainderForQueue}
                orderSizesById={orderSizesById}
                onChangeQty={updateDraftQty}
                onRemoveRow={removeDraftRow}
                onAddRow={addDraftRow}
                onCancel={cancelEdit}
                formAction={saveFormAction}
              />
            )}
          </div>
        );
      })}

      {/* Кнопка «Добавить очередь» под пустым списком (когда очередей нет вовсе). */}
      {canManage && !hasAnyQueue && !editing && (
        <div className="actions-row" style={{ margin: 0 }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={startAddQueue}
            data-testid="btn-add-queue-empty"
          >
            Добавить очередь
          </button>
        </div>
      )}

      {/* Форма для НОВОЙ очереди (рендерится отдельно после всех очередей). */}
      {canManage && editing && editing.isNew && (
        <div
          data-testid={`order-cut-issue-queue-${editing.queueIndex}-new`}
          style={{ marginTop: '0.75rem' }}
        >
          <h3 style={{ margin: '0 0 0.25rem 0', fontSize: '0.95rem' }}>
            Очередь №{editing.queueIndex} (новая)
          </h3>
          <EditQueueForm
            editing={editing}
            planBySizeId={planBySizeId}
            remainderForQueue={remainderForQueue}
            orderSizesById={orderSizesById}
            onChangeQty={updateDraftQty}
            onRemoveRow={removeDraftRow}
            onAddRow={addDraftRow}
            onCancel={cancelEdit}
            formAction={saveFormAction}
          />
        </div>
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

function QueueHeader({ queue }: { queue: OrderCutIssueQueueDto }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.5rem',
        marginBottom: '0.25rem',
      }}
    >
      <h3 style={{ margin: 0, fontSize: '0.95rem' }}>
        Очередь №{queue.queueIndex}
      </h3>
      <span
        style={{
          display: 'inline-block',
          padding: '1px 6px',
          borderRadius: 999,
          background: STATUS_COLORS[queue.status],
          fontSize: '0.7rem',
        }}
        data-testid={`queue-${queue.queueIndex}-status`}
      >
        {STATUS_LABELS[queue.status]}
      </span>
      {queue.isCurrent && (
        <span
          className="meta-line"
          style={{ fontSize: '0.7rem', color: '#b45309' }}
        >
          Текущая
        </span>
      )}
    </div>
  );
}

function RulesProgressTable({
  rules,
  planBySizeId,
}: {
  rules: OrderCutIssueRuleDto[];
  planBySizeId: Map<string, number>;
}) {
  if (rules.length === 0) {
    return (
      <div className="meta-line" style={{ marginBottom: '0.5rem' }}>
        В этой очереди нет активных строк.
      </div>
    );
  }
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
          <th className="num">План</th>
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
            <td className="num">{planBySizeId.get(r.sizeId) ?? 0}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function EditQueueForm({
  editing,
  planBySizeId,
  remainderForQueue,
  orderSizesById,
  onChangeQty,
  onRemoveRow,
  onAddRow,
  onCancel,
  formAction,
}: {
  editing: EditState;
  planBySizeId: Map<string, number>;
  remainderForQueue: (queueIndex: number) => Map<string, number>;
  orderSizesById: Array<{
    sizeId: string;
    sizeCode: string;
    sortOrder: number;
    qtyPlan: number;
  }>;
  onChangeQty: (sizeId: string, value: string) => void;
  onRemoveRow: (sizeId: string) => void;
  onAddRow: (sizeId: string) => void;
  onCancel: () => void;
  formAction: (form: FormData) => void;
}) {
  const remainder = useMemo(
    () => remainderForQueue(editing.queueIndex),
    [editing.queueIndex, remainderForQueue],
  );
  const sizesNotInDraft = orderSizesById.filter(
    (s) => !editing.rows.some((d) => d.sizeId === s.sizeId),
  );

  return (
    <form action={formAction} style={{ marginTop: '0.5rem' }}>
      <input type="hidden" name="queueIndex" value={editing.queueIndex} />
      <input
        type="hidden"
        name="rows"
        value={JSON.stringify(
          editing.rows
            .filter((r) => r.requiredQty > 0)
            .map((r, idx) => ({
              sizeId: r.sizeId,
              requiredQty: r.requiredQty,
              sortOrder: idx,
            })),
        )}
      />

      {editing.rows.length > 0 && (
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
            {editing.rows.map((r) => {
              const planQty = planBySizeId.get(r.sizeId) ?? 0;
              const upper = remainder.get(r.sizeId) ?? planQty;
              const overRemainder = r.requiredQty > upper;
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
                      max={upper}
                      value={r.requiredQty}
                      onChange={(e) => onChangeQty(r.sizeId, e.target.value)}
                      style={{ width: 80, textAlign: 'right' }}
                      aria-invalid={overRemainder || belowIssued}
                    />
                    {overRemainder && (
                      <div
                        className="meta-line"
                        style={{ color: '#b91c1c', fontSize: '0.7rem' }}
                      >
                        Не больше {upper} (остаток плана)
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
                      onClick={() => onRemoveRow(r.sizeId)}
                      aria-label={`Удалить строку ${r.sizeCode}`}
                      disabled={r.issuedQty > 0}
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
          <label
            className="meta-line"
            htmlFor={`ocr-add-size-${editing.queueIndex}`}
          >
            Добавить размер:
          </label>
          <select
            id={`ocr-add-size-${editing.queueIndex}`}
            defaultValue=""
            onChange={(e) => {
              onAddRow(e.target.value);
              e.target.value = '';
            }}
          >
            <option value="" disabled>
              Выберите размер из заказа…
            </option>
            {sizesNotInDraft.map((s) => {
              const upper = remainder.get(s.sizeId) ?? s.qtyPlan;
              return (
                <option
                  key={s.sizeId}
                  value={s.sizeId}
                  disabled={upper <= 0}
                >
                  {s.sizeCode} (остаток {upper})
                </option>
              );
            })}
          </select>
        </div>
      )}

      <div
        className="actions-row"
        style={{ margin: 0, display: 'flex', gap: '0.5rem' }}
      >
        <SaveButton hasRows={editing.rows.length > 0} />
        <button type="button" className="btn" onClick={onCancel}>
          Отмена
        </button>
      </div>
    </form>
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

function DisableQueueButton({
  formAction,
  queueIndex,
  disabled,
}: {
  formAction: (form: FormData) => void;
  queueIndex: number;
  disabled: boolean;
}) {
  return (
    <form action={formAction} style={{ display: 'inline' }}>
      <input type="hidden" name="queueIndex" value={queueIndex} />
      <DisableQueueSubmit disabled={disabled} queueIndex={queueIndex} />
    </form>
  );
}

function DisableQueueSubmit({
  disabled,
  queueIndex,
}: {
  disabled: boolean;
  queueIndex: number;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="btn btn-danger"
      disabled={pending || disabled}
      data-testid={`btn-disable-queue-${queueIndex}`}
    >
      {pending ? 'Отключаем…' : 'Отключить очередь'}
    </button>
  );
}
