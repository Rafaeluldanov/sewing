'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { Save, XCircle } from 'lucide-react';
import type { EquipmentSummaryDto } from '@sewing/shared/equipment';
import {
  PRINTER_TYPES,
  type PrinterDetailDto,
} from '@sewing/shared/printers';
import { updatePrinterAction } from '../actions';
import {
  initialUpdatePrinterState,
  type UpdatePrinterState,
} from '../form-state';

interface Props {
  printer: PrinterDetailDto;
  equipment: readonly EquipmentSummaryDto[];
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

export function EditPrinterForm({ printer, equipment }: Props) {
  const action = updatePrinterAction.bind(null, printer.id);
  const [state, formAction] = useFormState<UpdatePrinterState, FormData>(
    action,
    initialUpdatePrinterState,
  );

  return (
    <form action={formAction} className="admin-form">
      <div className="admin-form-grid">
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
          <label htmlFor="printer-equipment">Рабочее место</label>
          <select
            id="printer-equipment"
            name="equipmentId"
            defaultValue={printer.equipmentId ?? ''}
          >
            <option value="">— без привязки —</option>
            {equipment.map((eq) => (
              <option key={eq.id} value={eq.id}>
                {eq.name}
              </option>
            ))}
          </select>
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
