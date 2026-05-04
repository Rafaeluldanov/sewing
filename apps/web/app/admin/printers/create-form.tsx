'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { Save, XCircle } from 'lucide-react';
import { EMPLOYEE_ROLES } from '@sewing/shared/employees';
import { PRINTER_TYPES } from '@sewing/shared/printers';
import { formatRole } from '@/lib/admin-labels';
import { createPrinterAction } from './actions';
import {
  initialCreatePrinterState,
  type CreatePrinterState,
} from './form-state';

const PRINTER_TYPE_LABEL: Record<string, string> = {
  DEFAULT: 'По умолчанию',
  WINDOWS: 'Windows',
  ZEBRA: 'Zebra',
};

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending}
    >
      <Save size={16} strokeWidth={1.6} aria-hidden />
      {pending ? 'Создаём…' : 'Создать'}
    </button>
  );
}

/**
 * Форма создания принтера. Привязка идёт по РОЛИ сотрудника
 * (`Printer.role`, см. `packages/shared/src/printers.ts`): когда
 * сотрудник на терминале жмёт «Печать» без явного `printerId`,
 * backend ищет активный принтер с такой же `role` (см.
 * `PrintJobsService.resolvePrinter`). Старая привязка к Equipment
 * из UI убрана и больше не передаётся в API.
 */
export function CreatePrinterForm() {
  const [state, formAction] = useFormState<CreatePrinterState, FormData>(
    createPrinterAction,
    initialCreatePrinterState,
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
            placeholder="например, Принтер ОТК-1"
            autoComplete="off"
          />
        </div>
        <div className="admin-field">
          <label htmlFor="printer-type">Тип</label>
          <select id="printer-type" name="type" defaultValue="DEFAULT">
            {PRINTER_TYPES.map((t) => (
              <option key={t} value={t}>
                {PRINTER_TYPE_LABEL[t] ?? t}
              </option>
            ))}
          </select>
        </div>
        <div className="admin-field">
          <label htmlFor="printer-role">Роль сотрудника</label>
          <select id="printer-role" name="role" defaultValue="">
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
        Когда сотрудник выбранной роли нажмёт «Печать», задание уйдёт на
        этот принтер. Без привязки принтер можно использовать только для
        тестовой и массовой печати.
      </div>

      {state.error && (
        <div
          role="alert"
          style={{ color: 'var(--admin-danger-fg)', fontSize: '0.88rem' }}
        >
          <XCircle size={14} strokeWidth={1.6} aria-hidden /> {state.error}
        </div>
      )}

      <div className="admin-actions-row">
        <SubmitButton />
      </div>
    </form>
  );
}
