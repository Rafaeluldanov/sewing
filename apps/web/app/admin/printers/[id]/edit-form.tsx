'use client';

import { useFormState, useFormStatus } from 'react-dom';
import type { EquipmentSummaryDto } from '@sewing/shared/equipment';
import {
  PRINTER_TYPES,
  type PrinterDetailDto,
} from '@sewing/shared/printers';
import { Icon } from '@/components/icon';
import { updatePrinterAction } from '../actions';
import {
  initialUpdatePrinterState,
  type UpdatePrinterState,
} from '../form-state';

interface Props {
  printer: PrinterDetailDto;
  equipment: readonly EquipmentSummaryDto[];
}

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      <Icon name="save" size={16} />
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
    <form action={formAction} className="detail-form">
      <div className="detail-form__grid">
        <div className="detail-form__field">
          <label htmlFor="name">Имя</label>
          <input
            id="name"
            name="name"
            type="text"
            required
            maxLength={120}
            defaultValue={printer.name}
            autoComplete="off"
          />
        </div>
        <div className="detail-form__field">
          <label htmlFor="type">Тип</label>
          <select id="type" name="type" defaultValue={printer.type}>
            {PRINTER_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div className="detail-form__field">
          <label htmlFor="equipmentId">Рабочее место</label>
          <select
            id="equipmentId"
            name="equipmentId"
            defaultValue={printer.equipmentId ?? ''}
          >
            <option value="">— без привязки —</option>
            {equipment.map((eq) => (
              <option key={eq.id} value={eq.id}>
                {eq.name} ({eq.code})
              </option>
            ))}
          </select>
        </div>
        <div className="detail-form__field">
          <label>
            <input
              type="checkbox"
              name="isActive"
              defaultChecked={printer.isActive}
            />
            Активен
          </label>
          <span className="detail-form__hint">
            Если выключено — кнопка «Печать» в системе не будет выбирать
            этот принтер. История заданий сохраняется.
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
          <span>Сохранено.</span>
        </div>
      )}

      <div className="detail-form__actions">
        <SaveButton />
      </div>
    </form>
  );
}
