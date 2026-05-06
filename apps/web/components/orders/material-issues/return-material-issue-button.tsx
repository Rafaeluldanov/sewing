'use client';

/**
 * `ReturnMaterialIssueButton` — inline-действие «Сторнировать» для
 * строки POSTED-документа расхода в таблице `MaterialIssuesTable`.
 *
 * MVP-итерация (см. ТЗ «Возврат / сторно проведённого списания
 * материалов»): UI отдаёт ТОЛЬКО полное сторно остатка. Никаких
 * inputs по qty — сервер сам считает остаток к возврату по каждой
 * строке (`MaterialIssueLine.issuedQty − Σ ранее возвращённое`).
 *
 * Поведение:
 *   - свёрнутое состояние — маленькая danger-кнопка «Сторнировать»
 *     (если у документа `returnStatus === 'PARTIAL'` — текст
 *     «Сторнировать остаток», смысл тот же);
 *   - развёрнутое — inline-форма с обязательной причиной (`reason`,
 *     2..500), warning-блоком «Будет возвращено всё оставшееся
 *     количество» и preview-таблицей строк (`issuedQty`,
 *     `returnedQty`, `remainingQty = netIssuedQty`, `unit`,
 *     `description`);
 *   - сабмит идёт через `returnMaterialIssueAction`, форма генерит
 *     `clientRequestId` (UUID v4) при первом рендере — повторный
 *     submit с тем же id идемпотентен на уровне backend
 *     (`UNIQUE MaterialIssueReturn.sourceKey`);
 *   - после успеха `revalidatePath` обновляет блок «Фактический
 *     расход материалов»: `returnStatus` уходит в `FULL` (или
 *     остаётся `PARTIAL`, если когда-нибудь появится частичный
 *     возврат с произвольным qty), кнопка «Сторнировать» исчезает
 *     либо превращается в «Сторнировать остаток».
 */
import { useFormState, useFormStatus } from 'react-dom';
import { RotateCcw, XCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import type {
  MaterialIssueAggregateReturnStatus,
  MaterialIssueLineDto,
} from '@sewing/shared/material-issues';
import {
  initialMaterialIssueFormState,
  returnMaterialIssueAction,
} from '@/app/admin/orders/[id]/material-issues-actions';

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
   * Строки исходного документа — нужны для preview-таблицы.
   * Передаются из `MaterialIssuesTable`, который уже подгружает
   * `MaterialIssueDetailDto`.
   */
  lines: readonly MaterialIssueLineDto[];
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--danger"
      disabled={pending}
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

  // Считаем «строки к возврату»: только те, у которых `netIssuedQty > 0`.
  // Если `netIssuedQty` не пришёл с backend (старый клиент / тестовая
  // фикстура), fallback — `issuedQty`.
  const linesToReturn = lines
    .map((line) => {
      const netRaw = line.netIssuedQty ?? line.issuedQty;
      const remaining = Number(netRaw);
      return { line, remaining: Number.isFinite(remaining) ? remaining : 0 };
    })
    .filter(({ remaining }) => remaining > 0);

  return (
    <form
      action={formAction}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        minWidth: 320,
      }}
      data-testid="material-issue-return-form"
    >
      <input type="hidden" name="clientRequestId" value={clientRequestId} />

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
        Будет возвращено всё оставшееся количество по документу.
      </div>

      {linesToReturn.length > 0 && (
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
              <th style={{ padding: '2px 4px', textAlign: 'right' }}>
                Списано
              </th>
              <th style={{ padding: '2px 4px', textAlign: 'right' }}>
                Возвращено
              </th>
              <th style={{ padding: '2px 4px', textAlign: 'right' }}>
                К возврату
              </th>
              <th style={{ padding: '2px 4px' }}>Ед.</th>
            </tr>
          </thead>
          <tbody>
            {linesToReturn.map(({ line }) => (
              <tr key={line.id}>
                <td style={{ padding: '2px 4px' }}>{line.description}</td>
                <td style={{ padding: '2px 4px', textAlign: 'right' }}>
                  {line.issuedQty}
                </td>
                <td style={{ padding: '2px 4px', textAlign: 'right' }}>
                  {line.returnedQty ?? '0'}
                </td>
                <td style={{ padding: '2px 4px', textAlign: 'right' }}>
                  {line.netIssuedQty ?? line.issuedQty}
                </td>
                <td style={{ padding: '2px 4px' }}>{line.unit}</td>
              </tr>
            ))}
          </tbody>
        </table>
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
        <SubmitButton />
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
