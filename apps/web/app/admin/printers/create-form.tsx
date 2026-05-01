'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { Save, XCircle } from 'lucide-react';
import type { EquipmentSummaryDto } from '@sewing/shared/equipment';
import { PRINTER_TYPES } from '@sewing/shared/printers';
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

export function CreatePrinterForm({
  equipment,
}: {
  equipment: readonly EquipmentSummaryDto[];
}) {
  const [state, formAction] = useFormState<CreatePrinterState, FormData>(
    createPrinterAction,
    initialCreatePrinterState,
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
          <label htmlFor="printer-equipment">Рабочее место</label>
          <select id="printer-equipment" name="equipmentId" defaultValue="">
            <option value="">— без привязки —</option>
            {equipment.map((eq) => (
              <option key={eq.id} value={eq.id}>
                {eq.name}
              </option>
            ))}
          </select>
        </div>
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
