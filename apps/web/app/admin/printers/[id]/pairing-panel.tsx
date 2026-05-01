'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { Download, RefreshCw, XCircle } from 'lucide-react';
import type { PrinterDetailDto } from '@sewing/shared/printers';
import { generatePairingCodeAction } from '../actions';
import { initialActionState, type ActionState } from '../form-state';

function GenerateButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="admin-btn" disabled={pending}>
      <RefreshCw size={16} strokeWidth={1.6} aria-hidden />
      {pending ? 'Генерируем…' : 'Новый код'}
    </button>
  );
}

interface Props {
  printer: PrinterDetailDto;
  agentDownloadUrl: string;
}

export function PairingPanel({ printer, agentDownloadUrl }: Props) {
  const action = generatePairingCodeAction.bind(null, printer.id);
  const [state, formAction] = useFormState<ActionState, FormData>(
    action,
    initialActionState,
  );

  return (
    <div className="admin-form">
      <dl className="admin-deflist">
        <dt>Код</dt>
        <dd>
          {printer.pairingCode ? (
            <code
              style={{
                fontSize: '1.1rem',
                letterSpacing: '0.15em',
                fontWeight: 700,
              }}
            >
              {printer.pairingCode}
            </code>
          ) : (
            <span className="admin-muted">не сгенерирован</span>
          )}
        </dd>
      </dl>

      <div className="admin-actions-row" style={{ justifyContent: 'flex-start' }}>
        <form action={formAction} style={{ display: 'inline-flex' }}>
          <GenerateButton />
        </form>
        <a
          href={agentDownloadUrl}
          className="admin-btn"
          download="sewing-print-agent.exe"
        >
          <Download size={16} strokeWidth={1.6} aria-hidden />
          Скачать агент
        </a>
      </div>

      {state.error && (
        <div
          role="alert"
          style={{ color: 'var(--admin-danger-fg)', fontSize: '0.88rem' }}
        >
          <XCircle size={14} strokeWidth={1.6} aria-hidden /> {state.error}
        </div>
      )}
      {state.ok && (
        <div role="status" className="admin-muted" style={{ fontSize: '0.88rem' }}>
          Новый код сгенерирован.
        </div>
      )}
    </div>
  );
}
