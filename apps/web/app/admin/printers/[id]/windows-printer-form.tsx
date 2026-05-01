'use client';

import { useFormState, useFormStatus } from 'react-dom';
import type { PrinterDetailDto } from '@sewing/shared/printers';
import { Icon } from '@/components/icon';
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
      className="btn btn-primary"
      disabled={pending || disabled}
    >
      <Icon name="save" size={16} />
      {pending ? 'Сохраняем…' : 'Сохранить выбор'}
    </button>
  );
}

/**
 * Блок «Физический принтер Windows» в карточке принтера
 * (см. `docs/screens.md §18`, `docs/domain.md §17b`).
 *
 * Показывает:
 *   - hostName Windows-машины, на которой установлен агент;
 *   - когда агент в последний раз присылал список;
 *   - текущий выбранный принтер (`selectedWindowsPrinter`) badge-ом;
 *   - select по `availableWindowsPrinters` с кнопкой «Сохранить»;
 *   - empty-state, если агент ещё ничего не прислал.
 *
 * UX-инвариант: даже если агент сейчас offline — мы всё равно
 * рисуем последний известный список, чтобы менеджер мог поправить
 * выбор заранее. См. `docs/screens.md §18`.
 */
export function WindowsPrinterForm({ printer }: Props) {
  const action = selectWindowsPrinterAction.bind(null, printer.id);
  const [state, formAction] = useFormState<UpdatePrinterState, FormData>(
    action,
    initialUpdatePrinterState,
  );

  const list = printer.availableWindowsPrinters;
  const hasList = list.length > 0;
  const lastSync = printer.windowsPrintersUpdatedAt
    ? new Date(printer.windowsPrintersUpdatedAt).toLocaleString('ru-RU')
    : null;

  return (
    <div className="detail-form">
      <div className="detail-form__grid">
        <div className="detail-form__field">
          <label>Компьютер агента</label>
          {printer.agentHostName ? (
            <span className="meta-line">
              <code>{printer.agentHostName}</code>
              {' · агент '}
              <span
                className={`pill ${
                  printer.isOnline ? 'pill--ok' : 'pill--ghost'
                }`}
              >
                {printer.isOnline ? 'онлайн' : 'офлайн'}
              </span>
            </span>
          ) : (
            <span className="meta-line">
              Агент ещё не подключался. Запустите{' '}
              <code>sewing-print-agent.exe --pair</code> на Windows-станции.
            </span>
          )}
        </div>

        <div className="detail-form__field">
          <label>Текущий выбор</label>
          {printer.selectedWindowsPrinter ? (
            <span className="pill pill--ok" style={{ alignSelf: 'flex-start' }}>
              <Icon name="success" size={14} />
              {printer.selectedWindowsPrinter}
            </span>
          ) : (
            <span className="meta-line">
              Принтер не выбран — задания печати будут падать с ошибкой
              «Не выбран Windows-принтер».
            </span>
          )}
        </div>
      </div>

      {hasList ? (
        <form action={formAction} className="detail-form">
          <div className="detail-form__grid">
            <div className="detail-form__field">
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
              <span className="detail-form__hint">
                Список присылает агент с Windows-станции
                (<code>Get-Printer</code>).{' '}
                {lastSync && <>Обновлён: {lastSync}.</>}
              </span>
            </div>
          </div>

          {state.error && (
            <div className="detail-form__error" role="alert">
              <Icon name="error" size={16} />
              <span>
                {state.error}
                {state.errorRequestId && (
                  <span className="detail-form__error-rid">
                    req: <code>{state.errorRequestId}</code>
                  </span>
                )}
              </span>
            </div>
          )}
          {state.ok && (
            <div className="detail-form__success" role="status">
              <Icon name="success" size={16} />
              <span>Выбор сохранён.</span>
            </div>
          )}

          <div className="detail-form__actions">
            <SaveButton />
          </div>
        </form>
      ) : (
        <div className="empty-state">
          <span className="empty-state__title">
            Агент ещё не прислал список системных принтеров
          </span>
          <span className="empty-state__hint">
            После запуска агента (<code>sewing-print-agent.exe</code>) на
            Windows-станции список появится здесь автоматически в течение
            минуты. Если этого не происходит, проверьте, что в Windows
            доступны принтеры (<code>Get-Printer</code> в PowerShell).
          </span>
        </div>
      )}
    </div>
  );
}
