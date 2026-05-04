'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { Save, XCircle } from 'lucide-react';
import { EMPLOYEE_ROLES } from '@sewing/shared/employees';
import {
  PRINTER_TYPES,
  type PrinterDetailDto,
} from '@sewing/shared/printers';
import { formatRole } from '@/lib/admin-labels';
import { updatePrinterAction } from '../actions';
import {
  initialUpdatePrinterState,
  type UpdatePrinterState,
} from '../form-state';

interface Props {
  printer: PrinterDetailDto;
}

const PRINTER_TYPE_LABEL: Record<string, string> = {
  DEFAULT: 'По умолчанию',
  WINDOWS: 'Windows',
  ZEBRA: 'Zebra',
};

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending}
    >
      <Save size={16} strokeWidth={1.6} aria-hidden />
      {pending ? 'Сохраняем…' : 'Сохранить'}
    </button>
  );
}

/**
 * Форма карточки принтера. Привязка теперь по РОЛИ сотрудника
 * (`Printer.role`). См. комментарий к `CreatePrinterForm` и
 * `PrintJobsService.resolvePrinter`. Старая привязка к Equipment
 * из админки убрана; в БД поле `equipmentId` остаётся, но из этой
 * формы оно больше не редактируется.
 */
export function EditPrinterForm({ printer }: Props) {
  const action = updatePrinterAction.bind(null, printer.id);
  const [state, formAction] = useFormState<UpdatePrinterState, FormData>(
    action,
    initialUpdatePrinterState,
  );

  return (
    <form action={formAction} className="admin-form">
      {/* Три поля в одну линию (адаптив — см. .admin-form-grid--printer-row
          в globals.css: на узких экранах разворачиваются в столбец). */}
      <div className="admin-form-grid admin-form-grid--printer-row">
        <div className="admin-field">
          <label htmlFor="printer-name">Название</label>
          <input
            id="printer-name"
            name="name"
            type="text"
            required
            maxLength={120}
            defaultValue={printer.name}
            autoComplete="off"
          />
        </div>
        <div className="admin-field">
          <label htmlFor="printer-type">Тип</label>
          <select
            id="printer-type"
            name="type"
            defaultValue={printer.type}
          >
            {PRINTER_TYPES.map((t) => (
              <option key={t} value={t}>
                {PRINTER_TYPE_LABEL[t] ?? t}
              </option>
            ))}
          </select>
        </div>
        <div className="admin-field">
          <label htmlFor="printer-role">Роль сотрудника</label>
          <select
            id="printer-role"
            name="role"
            defaultValue={printer.role ?? ''}
          >
            <option value="">— без привязки —</option>
            {EMPLOYEE_ROLES.map((r) => (
              <option key={r} value={r}>
                {formatRole(r)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="admin-muted" style={{ fontSize: '0.8rem' }}>
        Сотрудник этой роли получит сюда задания на печать. Без привязки
        принтер останется только под тестовую/массовую печать.
      </div>

      <div className="admin-field admin-field--inline">
        <input
          id="printer-active"
          type="checkbox"
          name="isActive"
          defaultChecked={printer.isActive}
        />
        <label htmlFor="printer-active">Активен</label>
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
  );
}
