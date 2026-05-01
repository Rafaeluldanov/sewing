'use client';

import { useFormState, useFormStatus } from 'react-dom';
import type { PrinterDetailDto } from '@sewing/shared/printers';
import { Icon } from '@/components/icon';
import { generatePairingCodeAction } from '../actions';
import { initialActionState, type ActionState } from '../form-state';

function GenerateButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-secondary" disabled={pending}>
      <Icon name="refresh" size={16} />
      {pending ? 'Генерируем…' : 'Сгенерировать код'}
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
    <div className="detail-form">
      <div className="detail-form__grid">
        <div className="detail-form__field">
          <label>Код подключения</label>
          {printer.pairingCode ? (
            <code
              style={{
                fontSize: '1.4rem',
                letterSpacing: '0.15em',
                fontWeight: 700,
              }}
            >
              {printer.pairingCode}
            </code>
          ) : (
            <span className="meta-line">
              Код ещё не сгенерирован или уже использован агентом.
            </span>
          )}
          <span className="detail-form__hint">
            Передайте код оператору, который установит агент рядом с
            принтером. После первого подключения код очищается.
          </span>
        </div>
        <div className="detail-form__field">
          <label>Файл агента</label>
          <a
            href={agentDownloadUrl}
            className="btn btn-primary"
            download="sewing-print-agent.exe"
            style={{ alignSelf: 'flex-start' }}
          >
            <Icon name="arrow-right" size={16} />
            Скачать агент (Windows .exe)
          </a>
          <span className="detail-form__hint">
            Сохраните exe на Windows-станцию рядом с принтером и
            запустите:
            <br />
            <code>
              sewing-print-agent.exe --pair --server &lt;URL&gt; --code{' '}
              {printer.pairingCode ?? '<code>'}
            </code>
            <br />
            Затем <code>sewing-print-agent.exe</code>. Файлы будут
            складываться в <code>spool/</code>, <code>printed/</code>,{' '}
            <code>failed/</code> рядом с exe.
          </span>
        </div>
      </div>

      {state.error && (
        <div className="detail-form__error" role="alert">
          <Icon name="error" size={16} />
          <span>{state.error}</span>
        </div>
      )}
      {state.ok && (
        <div className="detail-form__success" role="status">
          <Icon name="success" size={16} />
          <span>Новый код сгенерирован.</span>
        </div>
      )}

      <form action={formAction} className="detail-form__actions">
        <GenerateButton />
      </form>
    </div>
  );
}
