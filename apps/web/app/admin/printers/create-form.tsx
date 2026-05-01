'use client';

import { useFormState, useFormStatus } from 'react-dom';
import type { EquipmentSummaryDto } from '@sewing/shared/equipment';
import { PRINTER_TYPES } from '@sewing/shared/printers';
import { Icon } from '@/components/icon';
import { createPrinterAction } from './actions';
import {
  initialCreatePrinterState,
  type CreatePrinterState,
} from './form-state';

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      <Icon name="save" size={16} />
      {pending ? 'Создаём…' : 'Создать принтер'}
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
    <form action={formAction} className="detail-form">
      <div className="detail-form__grid">
        <div className="detail-form__field">
          <label htmlFor="printer-name">Имя принтера</label>
          <input
            id="printer-name"
            name="name"
            type="text"
            required
            maxLength={120}
            placeholder="Принтер ОТК-1"
            autoComplete="off"
          />
        </div>
        <div className="detail-form__field">
          <label htmlFor="printer-type">Тип</label>
          <select id="printer-type" name="type" defaultValue="DEFAULT">
            {PRINTER_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <span className="detail-form__hint">
            Управленческая метка. На MVP логика выбора принтера от типа
            не зависит.
          </span>
        </div>
        <div className="detail-form__field">
          <label htmlFor="printer-equipment">Рабочее место</label>
          <select
            id="printer-equipment"
            name="equipmentId"
            defaultValue=""
          >
            <option value="">— без привязки —</option>
            {equipment.map((eq) => (
              <option key={eq.id} value={eq.id}>
                {eq.name} ({eq.code})
              </option>
            ))}
          </select>
          <span className="detail-form__hint">
            Можно привязать позже. Без привязки кнопка «Печать» в системе
            не сможет найти этот принтер автоматически.
          </span>
        </div>
      </div>

      {state.error && (
        <div className="detail-form__error" role="alert">
          <Icon name="error" size={16} />
          <span>{state.error}</span>
        </div>
      )}

      <div className="detail-form__actions">
        <SubmitButton />
      </div>
    </form>
  );
}
