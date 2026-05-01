'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { CheckCircle2, Save, XCircle } from 'lucide-react';
import type { PrinterDetailDto } from '@sewing/shared/printers';
import { selectWindowsPrinterAction } from '../actions';
import {
  initialUpdatePrinterState,
  type UpdatePrinterState,
} from '../form-state';

interface Props {
  printer: PrinterDetailDto;
}

function SaveButton({ disabled }: { disabled?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending || disabled}
    >
      <Save size={16} strokeWidth={1.6} aria-hidden />
      {pending ? 'Сохраняем…' : 'Сохранить'}
    </button>
  );
}

/**
 * Блок «Физический принтер Windows» в карточке принтера.
 *
 * Показывает hostName агента, текущий выбор и select из списка
 * системных принтеров, который агент шлёт через `Get-Printer`.
 * UX-инвариант: даже если агент сейчас offline — рисуем последний
 * известный список, чтобы менеджер мог поправить выбор заранее.
 */
export function WindowsPrinterForm({ printer }: Props) {
  const action = selectWindowsPrinterAction.bind(null, printer.id);
  const [state, formAction] = useFormState<UpdatePrinterState, FormData>(
    action,
    initialUpdatePrinterState,
  );

  const list = printer.availableWindowsPrinters;
  const hasList = list.length > 0;

  return (
    <div className="admin-form">
      <dl className="admin-deflist">
        <dt>Хост агента</dt>
        <dd>
          {printer.agentHostName ? (
            <code style={{ fontSize: '0.85rem' }}>{printer.agentHostName}</code>
          ) : (
            <span className="admin-muted">не подключён</span>
          )}
        </dd>
        <dt>Текущий выбор</dt>
        <dd>
          {printer.selectedWindowsPrinter ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <CheckCircle2
                size={14}
                strokeWidth={1.7}
                aria-hidden
                style={{ color: 'var(--admin-green-fg, #166534)' }}
              />
              {printer.selectedWindowsPrinter}
            </span>
          ) : (
            <span className="admin-muted">не выбран</span>
          )}
        </dd>
      </dl>

      {hasList ? (
        <form action={formAction} className="admin-form">
          <div className="admin-field">
            <label htmlFor="selectedWindowsPrinter">Печатать на</label>
            <select
              id="selectedWindowsPrinter"
              name="selectedWindowsPrinter"
              defaultValue={printer.selectedWindowsPrinter ?? ''}
            >
              <option value="">— не выбран —</option>
              {list.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>

          {state.error && (
            <div
              role="alert"
              style={{ color: 'var(--admin-danger-fg)', fontSize: '0.88rem' }}
            >
              <XCircle size={14} strokeWidth={1.6} aria-hidden /> {state.error}
              {state.errorRequestId && (
                <span className="admin-muted" style={{ marginLeft: 6 }}>
                  req: <code>{state.errorRequestId}</code>
                </span>
              )}
            </div>
          )}
          {state.ok && (
            <div role="status" className="admin-muted" style={{ fontSize: '0.88rem' }}>
              Сохранено.
            </div>
          )}

          <div className="admin-actions-row">
            <SaveButton />
          </div>
        </form>
      ) : (
        <p className="admin-muted" style={{ margin: 0, fontSize: '0.88rem' }}>
          Агент ещё не прислал список принтеров.
        </p>
      )}
    </div>
  );
}
