'use client';

/**
 * `CreateMaterialIssueDialog` — форма создания DRAFT-документа
 * «Фактический расход материалов» для карточки заказа
 * (`/admin/orders/[id]?tab=needs`). Открывается по кнопке «Создать
 * расход» в `MaterialIssuesSection`, рендерится inline в блоке — без
 * полноценного модального окна, чтобы не плодить UI-паттерны вне
 * существующей палитры (см.
 * `apps/web/components/orders/material-arrived-button.tsx` как
 * аналог).
 *
 * Контракт:
 *   - `workshopNeeds` приходят из родителя (вкладка «Потребности»
 *     уже их грузит для `OrderMaterialsUnifiedTable` / других
 *     блоков). Это источник строк: при выборе `workshopNeedId`
 *     UI автоматически подставляет `description` / `unit` /
 *     `materialRole`. Если потребностей нет — строку можно заполнить
 *     вручную (backend тоже это разрешает, см.
 *     `MaterialIssuesService.prepareLine`).
 *   - `passports` — опциональный select с паспортами текущего
 *     заказа. Если массив пуст — блок паспорта не показываем
 *     (отдельный большой fetch не делаем — ТЗ §6).
 *   - `totalCost` считается только как preview; источник истины —
 *     backend (Σ issuedQty × unitCost).
 *
 * Submit:
 *   - Строки сериализуются в hidden `payload` JSON-ом, server
 *     action (`createMaterialIssueAction`) парсит и прогоняет через
 *     `CreateMaterialIssueSchema` (Zod).
 *   - После успеха — форма сворачивается, родительский RSC
 *     перечитывает список через `revalidatePath`.
 *
 * Сознательная простота:
 *   - без полноценного модала / фокус-ловушки / ESC-handler;
 *   - без сложного dnd строк — reorder не нужен, строки короткие;
 *   - `cellId` пока не показываем в UI (полезно при наличии UI
 *     ячеек; MVP-расход делается без резервации ячейки).
 */

import { useEffect, useMemo, useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import {
  CheckCircle,
  Plus,
  Trash2,
  XCircle,
} from 'lucide-react';
import type { PassportListItemDto } from '@sewing/shared/passports';
import type { WorkshopNeedListItemDto } from '@sewing/shared/workshop-needs';
import {
  createMaterialIssueAction,
  initialMaterialIssueFormState,
} from '@/app/admin/orders/[id]/material-issues-actions';

interface Props {
  orderId: string;
  workshopNeeds: WorkshopNeedListItemDto[];
  passports: PassportListItemDto[];
  /** Вызывается, когда пользователь закрывает dialog (Cancel / успех). */
  onClose: () => void;
}

interface DraftLine {
  /** Локальный stable-id для React `key` (не отправляется на сервер). */
  localId: string;
  workshopNeedId: string;
  description: string;
  unit: string;
  materialRole: string;
  issuedQty: string;
  unitCost: string;
  comment: string;
}

function makeEmptyLine(): DraftLine {
  return {
    localId:
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2),
    workshopNeedId: '',
    description: '',
    unit: '',
    materialRole: '',
    issuedQty: '',
    unitCost: '',
    comment: '',
  };
}

function toNumber(value: string): number {
  const n = Number(value.replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

function formatMoneyPreview(value: number): string {
  return value.toLocaleString('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: 2,
  });
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending}
    >
      <CheckCircle size={16} strokeWidth={1.6} aria-hidden />
      {pending ? 'Создаём…' : 'Создать'}
    </button>
  );
}

export function CreateMaterialIssueDialog({
  orderId,
  workshopNeeds,
  passports,
  onClose,
}: Props) {
  const [passportId, setPassportId] = useState<string>('');
  const [lines, setLines] = useState<DraftLine[]>([makeEmptyLine()]);
  const [state, formAction] = useFormState(
    createMaterialIssueAction.bind(null, orderId),
    initialMaterialIssueFormState,
  );

  // Автозакрытие формы после успешного create — родитель перечитает
  // список через `revalidatePath` в server action. `state.createdId`
  // меняется только при успехе, поэтому effect отработает ровно
  // один раз на каждое successful submit.
  useEffect(() => {
    if (state.ok && state.createdId) {
      onClose();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.ok, state.createdId]);

  const needsById = useMemo(() => {
    const map = new Map<string, WorkshopNeedListItemDto>();
    for (const n of workshopNeeds) map.set(n.id, n);
    return map;
  }, [workshopNeeds]);

  function updateLine(index: number, patch: Partial<DraftLine>): void {
    setLines((prev) =>
      prev.map((line, i) => (i === index ? { ...line, ...patch } : line)),
    );
  }

  function handleNeedChange(index: number, needId: string): void {
    if (needId === '') {
      updateLine(index, {
        workshopNeedId: '',
        materialRole: '',
      });
      return;
    }
    const need = needsById.get(needId);
    if (!need) {
      updateLine(index, { workshopNeedId: needId });
      return;
    }
    updateLine(index, {
      workshopNeedId: need.id,
      description: need.description,
      unit: need.unit,
      materialRole:
        typeof need.materialRole === 'string' ? need.materialRole : '',
    });
  }

  function addLine(): void {
    setLines((prev) => [...prev, makeEmptyLine()]);
  }

  function removeLine(localId: string): void {
    setLines((prev) =>
      prev.length <= 1 ? prev : prev.filter((l) => l.localId !== localId),
    );
  }

  const total = useMemo(
    () =>
      lines.reduce(
        (acc, l) => acc + toNumber(l.issuedQty) * toNumber(l.unitCost),
        0,
      ),
    [lines],
  );

  // Собираем payload для hidden-поля: пустые опциональные поля
  // не передаём (Zod на сервере требует `.min(1)` для заполненных).
  const payload = useMemo(() => {
    const body = {
      ...(passportId !== '' ? { passportId } : {}),
      lines: lines.map((l) => ({
        ...(l.workshopNeedId !== '' ? { workshopNeedId: l.workshopNeedId } : {}),
        ...(l.description !== '' ? { description: l.description } : {}),
        ...(l.unit !== '' ? { unit: l.unit } : {}),
        issuedQty: l.issuedQty,
        unitCost: l.unitCost,
        ...(l.comment !== '' ? { comment: l.comment } : {}),
      })),
    };
    return JSON.stringify(body);
  }, [lines, passportId]);

  return (
    <form
      action={formAction}
      className="material-issue-dialog"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: 12,
        border: '1px solid var(--admin-border, #d4d4d8)',
        borderRadius: 6,
        background: 'rgba(0, 0, 0, 0.02)',
      }}
    >
      <input type="hidden" name="payload" value={payload} />

      <div style={{ fontWeight: 600 }}>Новый документ расхода</div>
      <div
        className="admin-muted"
        style={{ fontSize: '0.78rem', lineHeight: 1.4 }}
      >
        Создаётся как черновик (DRAFT). Проведение и отмена — отдельными
        действиями из списка. Документ НЕ списывает складские остатки.
      </div>

      {passports.length > 0 && (
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: '0.78rem', fontWeight: 500 }}>
            Паспорт (опционально)
          </span>
          <select
            value={passportId}
            onChange={(e) => setPassportId(e.target.value)}
            style={{
              fontSize: '0.85rem',
              padding: '6px 8px',
              border: '1px solid var(--admin-border, #d4d4d8)',
              borderRadius: 4,
              fontFamily: 'inherit',
            }}
          >
            <option value="">— не привязывать —</option>
            {passports.map((p) => (
              <option key={p.id} value={p.id}>
                {p.number}
                {p.sizeCode ? ` · ${p.sizeCode}` : ''}
              </option>
            ))}
          </select>
        </label>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: '0.85rem', fontWeight: 500 }}>
          Строки расхода
        </div>

        {lines.map((line, index) => (
          <div
            key={line.localId}
            className="material-issue-line"
            style={{
              display: 'grid',
              gap: 6,
              gridTemplateColumns: '1fr',
              padding: 8,
              border: '1px solid var(--admin-border, #d4d4d8)',
              borderRadius: 4,
              background: '#fff',
            }}
          >
            <label
              style={{ display: 'flex', flexDirection: 'column', gap: 3 }}
            >
              <span style={{ fontSize: '0.75rem', fontWeight: 500 }}>
                Потребность цеха
              </span>
              <select
                value={line.workshopNeedId}
                onChange={(e) => handleNeedChange(index, e.target.value)}
                style={{
                  fontSize: '0.85rem',
                  padding: '6px 8px',
                  border: '1px solid var(--admin-border, #d4d4d8)',
                  borderRadius: 4,
                  fontFamily: 'inherit',
                }}
              >
                <option value="">— вручную —</option>
                {workshopNeeds.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.description} ({n.unit})
                  </option>
                ))}
              </select>
            </label>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '2fr 1fr',
                gap: 6,
              }}
            >
              <label
                style={{ display: 'flex', flexDirection: 'column', gap: 3 }}
              >
                <span style={{ fontSize: '0.75rem', fontWeight: 500 }}>
                  Описание{' '}
                  {line.workshopNeedId === '' && (
                    <span style={{ color: '#dc2626' }}>*</span>
                  )}
                </span>
                <input
                  type="text"
                  value={line.description}
                  onChange={(e) =>
                    updateLine(index, { description: e.target.value })
                  }
                  required={line.workshopNeedId === ''}
                  placeholder="Например: Дюспо синий"
                  style={{
                    fontSize: '0.85rem',
                    padding: '6px 8px',
                    border: '1px solid var(--admin-border, #d4d4d8)',
                    borderRadius: 4,
                    fontFamily: 'inherit',
                  }}
                />
              </label>
              <label
                style={{ display: 'flex', flexDirection: 'column', gap: 3 }}
              >
                <span style={{ fontSize: '0.75rem', fontWeight: 500 }}>
                  Ед. изм.{' '}
                  {line.workshopNeedId === '' && (
                    <span style={{ color: '#dc2626' }}>*</span>
                  )}
                </span>
                <input
                  type="text"
                  value={line.unit}
                  onChange={(e) => updateLine(index, { unit: e.target.value })}
                  required={line.workshopNeedId === ''}
                  placeholder="м / шт / кг"
                  style={{
                    fontSize: '0.85rem',
                    padding: '6px 8px',
                    border: '1px solid var(--admin-border, #d4d4d8)',
                    borderRadius: 4,
                    fontFamily: 'inherit',
                  }}
                />
              </label>
            </div>

            {line.materialRole !== '' && (
              <div
                className="admin-muted"
                style={{ fontSize: '0.72rem' }}
              >
                Роль: {line.materialRole}
              </div>
            )}

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr 1fr',
                gap: 6,
              }}
            >
              <label
                style={{ display: 'flex', flexDirection: 'column', gap: 3 }}
              >
                <span style={{ fontSize: '0.75rem', fontWeight: 500 }}>
                  Кол-во <span style={{ color: '#dc2626' }}>*</span>
                </span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={line.issuedQty}
                  onChange={(e) =>
                    updateLine(index, { issuedQty: e.target.value })
                  }
                  required
                  placeholder="0.00"
                  style={{
                    fontSize: '0.85rem',
                    padding: '6px 8px',
                    border: '1px solid var(--admin-border, #d4d4d8)',
                    borderRadius: 4,
                    fontFamily: 'inherit',
                  }}
                />
              </label>
              <label
                style={{ display: 'flex', flexDirection: 'column', gap: 3 }}
              >
                <span style={{ fontSize: '0.75rem', fontWeight: 500 }}>
                  Цена за 1 <span style={{ color: '#dc2626' }}>*</span>
                </span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={line.unitCost}
                  onChange={(e) =>
                    updateLine(index, { unitCost: e.target.value })
                  }
                  required
                  placeholder="0.00"
                  style={{
                    fontSize: '0.85rem',
                    padding: '6px 8px',
                    border: '1px solid var(--admin-border, #d4d4d8)',
                    borderRadius: 4,
                    fontFamily: 'inherit',
                  }}
                />
              </label>
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 3,
                  justifyContent: 'flex-end',
                }}
              >
                <span
                  className="admin-muted"
                  style={{ fontSize: '0.72rem' }}
                >
                  Сумма строки
                </span>
                <span style={{ fontSize: '0.85rem', fontWeight: 500 }}>
                  {formatMoneyPreview(
                    toNumber(line.issuedQty) * toNumber(line.unitCost),
                  )}
                </span>
              </div>
            </div>

            <label
              style={{ display: 'flex', flexDirection: 'column', gap: 3 }}
            >
              <span style={{ fontSize: '0.75rem', fontWeight: 500 }}>
                Комментарий
              </span>
              <input
                type="text"
                value={line.comment}
                onChange={(e) =>
                  updateLine(index, { comment: e.target.value })
                }
                placeholder="Опционально"
                style={{
                  fontSize: '0.85rem',
                  padding: '6px 8px',
                  border: '1px solid var(--admin-border, #d4d4d8)',
                  borderRadius: 4,
                  fontFamily: 'inherit',
                }}
              />
            </label>

            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
              }}
            >
              <button
                type="button"
                className="admin-btn admin-btn--ghost"
                onClick={() => removeLine(line.localId)}
                disabled={lines.length <= 1}
                style={{ fontSize: '0.78rem', padding: '4px 8px' }}
              >
                <Trash2 size={12} strokeWidth={1.6} aria-hidden />
                Удалить строку
              </button>
            </div>
          </div>
        ))}

        <button
          type="button"
          className="admin-btn admin-btn--ghost"
          onClick={addLine}
          style={{ alignSelf: 'flex-start' }}
        >
          <Plus size={14} strokeWidth={1.6} aria-hidden />
          Добавить строку
        </button>
      </div>

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '6px 0',
          borderTop: '1px dashed var(--admin-border, #d4d4d8)',
        }}
      >
        <span className="admin-muted" style={{ fontSize: '0.78rem' }}>
          Предварительный итог (рассчитает backend):
        </span>
        <strong style={{ fontSize: '0.9rem' }}>
          {formatMoneyPreview(total)}
        </strong>
      </div>

      {state.error && (
        <div className="error-box" role="alert">
          <XCircle size={14} strokeWidth={1.6} aria-hidden /> {state.error}
        </div>
      )}

      <div style={{ display: 'flex', gap: 6 }}>
        <SubmitButton />
        <button
          type="button"
          className="admin-btn admin-btn--ghost"
          onClick={onClose}
        >
          Отмена
        </button>
      </div>
    </form>
  );
}
