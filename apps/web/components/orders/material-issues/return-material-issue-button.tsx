'use client';

/**
 * `ReturnMaterialIssueButton` — inline-действие «Сторнировать» для
 * строки POSTED-документа расхода в таблице `MaterialIssuesTable`.
 *
 * Итерация «Частичный возврат» (см. ТЗ): UI отдаёт массив строк
 * `lines[] = [{ materialIssueLineId, returnedQty }]`, каждая
 * `returnedQty ≥ 0` и не больше `availableToReturn`
 * (`MaterialIssueLineDto.netIssuedQty`). Кнопка «Заполнить всё
 * доступное» проставляет максимум по всем строкам сразу — это
 * заменяет старое полное сторно (исходный backend-режим без
 * `lines` остаётся как fallback для server-to-server клиентов).
 *
 * Поведение:
 *   - свёрнутое состояние — маленькая danger-кнопка «Сторнировать»
 *     (для `PARTIAL` — лейбл «Сторнировать остаток»);
 *   - развёрнутое — inline-форма с обязательной причиной (`reason`,
 *     2..500), warning-блоком, кнопкой «Заполнить всё доступное» и
 *     таблицей строк с input-ом `Вернуть` по каждой;
 *   - submit фильтрует строки с `returnedQty <= 0`;
 *   - минимум одна строка должна иметь `returnedQty > 0` — иначе
 *     UI показывает inline-валидацию и не сабмитит;
 *   - submit идёт через `returnMaterialIssueAction`, форма генерит
 *     `clientRequestId` (UUID v4) при первом рендере — повторный
 *     submit с тем же id идемпотентен на уровне backend
 *     (`UNIQUE MaterialIssueReturn.sourceKey`);
 *   - после успеха `revalidatePath` обновляет блок «Фактический
 *     расход материалов»: `returnStatus` уходит в `FULL` (если
 *     возвращено всё) или `PARTIAL` (если только часть).
 */
import { useFormState, useFormStatus } from 'react-dom';
import { RotateCcw, XCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import type {
  MaterialIssueAggregateReturnStatus,
  MaterialIssueLineDto,
} from '@sewing/shared/material-issues';
import { returnMaterialIssueAction } from '@/app/admin/orders/[id]/material-issues-actions';
import { initialMaterialIssueFormState } from '@/app/admin/orders/[id]/material-issues-form-state';

interface Props {
  orderId: string;
  id: string;
  /**
   * Совокупный статус возвратов. Если `FULL` — кнопка не
   * рендерится (родительская таблица уже не должна её передавать,
   * но мы дополнительно защищаемся). `PARTIAL` меняет лейбл на
   * «Сторнировать остаток».
   */
  returnStatus: MaterialIssueAggregateReturnStatus;
  /**
   * Строки исходного документа — нужны и для preview, и для qty-
   * input-ов. Передаются из `MaterialIssuesTable`, который
   * подгружает `MaterialIssueDetailDto`. Если детали ещё не
   * подгрузились — родитель передаст `[]`, форма откажется
   * сабмитить (ниже).
   */
  lines: readonly MaterialIssueLineDto[];
}

function SubmitButton({ disabled }: { disabled?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--danger"
      disabled={pending || disabled}
      style={{ fontSize: '0.78rem', padding: '4px 8px' }}
      data-testid="material-issue-return-submit"
    >
      {pending ? 'Сторнируем…' : 'Сторнировать'}
    </button>
  );
}

/**
 * Простейший UUID v4 — без зависимостей. Используется только для
 * `clientRequestId` (идемпотентность повторного submit). На UI этого
 * хватает: backend всё равно повторно валидирует через
 * `ReturnMaterialIssueSchema` и пишет `MaterialIssueReturn.sourceKey`
 * с UNIQUE-индексом.
 */
function generateClientRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback на math/timestamp для очень старых браузеров — UUID-
  // подобная строка, достаточно уникальная в рамках одной формы.
  return `mi-return-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

interface PreparedLine {
  /** id `MaterialIssueLine`. */
  id: string;
  description: string;
  unit: string;
  /** `issuedQty` исходной строки (display). */
  issuedQty: string;
  /** `returnedQty` суммарно по уже-проведённым возвратам (display). */
  returnedQty: string;
  /**
   * Сколько ещё можно вернуть — `MaterialIssueLineDto.netIssuedQty`
   * (с fallback на `issuedQty` для старых клиентов / тестов).
   */
  availableToReturn: number;
  /**
   * Текстовый display `availableToReturn` — берём raw-строку
   * `netIssuedQty` (или `issuedQty`), чтобы не терять precision при
   * `Number.toFixed`. Используется как `defaultValue` input-а.
   */
  availableDisplay: string;
}

function prepareLines(lines: readonly MaterialIssueLineDto[]): PreparedLine[] {
  return lines
    .map((line) => {
      const availableRaw = line.netIssuedQty ?? line.issuedQty;
      const availableToReturn = Number(availableRaw);
      return {
        id: line.id,
        description: line.description,
        unit: line.unit,
        issuedQty: line.issuedQty,
        returnedQty: line.returnedQty ?? '0',
        availableToReturn: Number.isFinite(availableToReturn)
          ? availableToReturn
          : 0,
        availableDisplay: String(availableRaw ?? line.issuedQty ?? '0'),
      } satisfies PreparedLine;
    })
    .filter((p) => p.availableToReturn > 0);
}

/**
 * Парсит локализованный ввод (`,` / `.`) в число.
 * Возвращает `NaN`, если строка пустая или не парсится.
 */
function parseQty(value: string): number {
  const normalized = value.replace(',', '.').trim();
  if (normalized === '') return Number.NaN;
  return Number(normalized);
}

export function ReturnMaterialIssueButton({
  orderId,
  id,
  returnStatus,
  lines,
}: Props) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useFormState(
    returnMaterialIssueAction.bind(null, orderId, id),
    initialMaterialIssueFormState,
  );
  // Один `clientRequestId` на одну форму. Не пересоздаём на каждый
  // рендер — иначе после неуспешного submit retry получит другой
  // ключ и идемпотентность сломается.
  const clientRequestId = useMemo(() => generateClientRequestId(), []);

  const preparedLines = useMemo(() => prepareLines(lines), [lines]);

  // Контролируемые input-ы по строкам. По умолчанию — пусто
  // (пользователь сам решит, сколько возвращать). Кнопка «Заполнить
  // всё доступное» проставляет максимумы. Ключ — `MaterialIssueLine.id`.
  const [qtyByLine, setQtyByLine] = useState<Record<string, string>>({});

  if (returnStatus === 'FULL') {
    // Защитный no-op на случай, если родитель забыл скрыть кнопку.
    return null;
  }

  if (!open) {
    return (
      <button
        type="button"
        className="admin-btn admin-btn--danger"
        onClick={() => setOpen(true)}
        style={{ fontSize: '0.78rem', padding: '4px 8px' }}
        data-testid="material-issue-return-trigger"
      >
        <RotateCcw size={12} strokeWidth={1.6} aria-hidden />
        {returnStatus === 'PARTIAL' ? 'Сторнировать остаток' : 'Сторнировать'}
      </button>
    );
  }

  // Если детали ещё не подгрузились (parent передал []), нечего
  // возвращать — отрисуем минимальный stub с подсказкой и без
  // submit-кнопки.
  if (preparedLines.length === 0) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          minWidth: 320,
        }}
        data-testid="material-issue-return-form"
      >
        <div className="admin-muted" style={{ fontSize: '0.78rem' }}>
          Нет строк, доступных к возврату.
        </div>
        <button
          type="button"
          className="admin-btn admin-btn--ghost"
          onClick={() => setOpen(false)}
          style={{ fontSize: '0.78rem', padding: '4px 8px' }}
        >
          Закрыть
        </button>
      </div>
    );
  }

  // Валидация по input-ам: для каждой строки парсим введённое qty,
  // сверяем с `availableToReturn`, считаем общую сумму > 0.
  let hasInvalidQty = false;
  let totalRequested = 0;
  for (const p of preparedLines) {
    const raw = qtyByLine[p.id] ?? '';
    if (raw === '') continue; // пустое поле — строка просто не идёт в запрос
    const n = parseQty(raw);
    if (!Number.isFinite(n) || n < 0 || n > p.availableToReturn) {
      hasInvalidQty = true;
      continue;
    }
    if (n > 0) totalRequested += n;
  }
  const hasNonZeroLine = totalRequested > 0;
  const submitDisabled = !hasNonZeroLine || hasInvalidQty;

  // FormData собирается через скрытое поле `linesPayload` — это
  // проще, чем конструировать `name="lines[0][materialIssueLineId]"`
  // и парсить на сервере. Server action знает обе формы.
  const submittedLines = preparedLines
    .map((p) => {
      const raw = qtyByLine[p.id] ?? '';
      if (raw === '') return null;
      const n = parseQty(raw);
      if (!Number.isFinite(n) || n <= 0) return null;
      return {
        materialIssueLineId: p.id,
        // Передаём строку (не number) — Decimal-as-string совпадает с
        // backend Zod (`positiveDecimal`), без потерь точности.
        returnedQty: raw.replace(',', '.').trim(),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  const fillAllAvailable = () => {
    const next: Record<string, string> = {};
    for (const p of preparedLines) {
      next[p.id] = p.availableDisplay;
    }
    setQtyByLine(next);
  };

  return (
    <form
      action={formAction}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        minWidth: 360,
      }}
      data-testid="material-issue-return-form"
    >
      <input type="hidden" name="clientRequestId" value={clientRequestId} />
      <input
        type="hidden"
        name="linesPayload"
        value={JSON.stringify(submittedLines)}
      />

      <div
        style={{
          fontSize: '0.78rem',
          background: 'rgba(220, 38, 38, 0.08)',
          color: '#7f1d1d',
          padding: '6px 8px',
          border: '1px solid rgba(220, 38, 38, 0.25)',
          borderRadius: 4,
        }}
      >
        Будет создан документ возврата. Исходный расход останется
        проведённым, а факт материалов будет уменьшен на возвращённое
        количество.
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          type="button"
          className="admin-btn admin-btn--ghost"
          onClick={fillAllAvailable}
          style={{ fontSize: '0.72rem', padding: '2px 6px' }}
          data-testid="material-issue-return-fill-all"
        >
          Заполнить всё доступное
        </button>
      </div>

      <table
        style={{
          fontSize: '0.75rem',
          borderCollapse: 'collapse',
          width: '100%',
        }}
        data-testid="material-issue-return-preview"
      >
        <thead>
          <tr style={{ textAlign: 'left' }}>
            <th style={{ padding: '2px 4px' }}>Материал</th>
            <th style={{ padding: '2px 4px', textAlign: 'right' }}>Списано</th>
            <th style={{ padding: '2px 4px', textAlign: 'right' }}>
              Возвращено
            </th>
            <th style={{ padding: '2px 4px', textAlign: 'right' }}>
              Доступно
            </th>
            <th style={{ padding: '2px 4px', textAlign: 'right' }}>Вернуть</th>
            <th style={{ padding: '2px 4px' }}>Ед.</th>
          </tr>
        </thead>
        <tbody>
          {preparedLines.map((p) => {
            const raw = qtyByLine[p.id] ?? '';
            const parsed = raw === '' ? Number.NaN : parseQty(raw);
            const overLimit =
              Number.isFinite(parsed) && parsed > p.availableToReturn;
            const negative = Number.isFinite(parsed) && parsed < 0;
            const invalid =
              raw !== '' && (!Number.isFinite(parsed) || negative || overLimit);
            return (
              <tr key={p.id} data-testid="material-issue-return-row">
                <td style={{ padding: '2px 4px' }}>{p.description}</td>
                <td style={{ padding: '2px 4px', textAlign: 'right' }}>
                  {p.issuedQty}
                </td>
                <td style={{ padding: '2px 4px', textAlign: 'right' }}>
                  {p.returnedQty}
                </td>
                <td style={{ padding: '2px 4px', textAlign: 'right' }}>
                  {p.availableDisplay}
                </td>
                <td style={{ padding: '2px 4px', textAlign: 'right' }}>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={raw}
                    onChange={(e) =>
                      setQtyByLine((prev) => ({
                        ...prev,
                        [p.id]: e.target.value,
                      }))
                    }
                    placeholder="0"
                    aria-invalid={invalid || undefined}
                    aria-label={`Вернуть по строке ${p.description}`}
                    data-testid="material-issue-return-qty-input"
                    style={{
                      width: 80,
                      fontSize: '0.78rem',
                      padding: '2px 4px',
                      textAlign: 'right',
                      border: `1px solid ${
                        invalid ? '#dc2626' : 'var(--admin-border, #d4d4d8)'
                      }`,
                      borderRadius: 3,
                    }}
                  />
                  {overLimit && (
                    <div style={{ fontSize: '0.7rem', color: '#dc2626' }}>
                      Не больше {p.availableDisplay}
                    </div>
                  )}
                </td>
                <td style={{ padding: '2px 4px' }}>{p.unit}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {!hasNonZeroLine && !hasInvalidQty && (
        <div
          className="admin-muted"
          style={{ fontSize: '0.72rem' }}
          data-testid="material-issue-return-no-qty-hint"
        >
          Укажите количество к возврату хотя бы по одной строке (или
          нажмите «Заполнить всё доступное»).
        </div>
      )}

      <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span style={{ fontSize: '0.75rem', fontWeight: 500 }}>
          Причина возврата <span style={{ color: '#dc2626' }}>*</span>
        </span>
        <textarea
          name="reason"
          rows={2}
          minLength={2}
          maxLength={500}
          required
          placeholder="Например: «излишки списания, материал возвращён на склад»"
          style={{
            fontSize: '0.78rem',
            padding: '4px 6px',
            border: '1px solid var(--admin-border, #d4d4d8)',
            borderRadius: 4,
            fontFamily: 'inherit',
          }}
        />
        {state.fieldErrors?.reason && (
          <span style={{ fontSize: '0.7rem', color: '#dc2626' }}>
            {state.fieldErrors.reason}
          </span>
        )}
      </label>

      <div style={{ display: 'flex', gap: 4 }}>
        <SubmitButton disabled={submitDisabled} />
        <button
          type="button"
          className="admin-btn admin-btn--ghost"
          onClick={() => setOpen(false)}
          style={{ fontSize: '0.78rem', padding: '4px 8px' }}
        >
          Закрыть
        </button>
      </div>
      {state.error && (
        <div className="error-box" role="alert">
          <XCircle size={12} strokeWidth={1.6} aria-hidden /> {state.error}
        </div>
      )}
    </form>
  );
}
