'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { useState } from 'react';
import type { CellDetailDto } from '@sewing/shared/passports';
import { Icon } from '@/components/icon';
import {
  placePassportAction,
  type PassportFormState,
} from '../../orders/[id]/passports/actions';

interface Props {
  passportId: string;
  orderId: string;
  cells: CellDetailDto[];
}

const initialState: PassportFormState = {};

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      <Icon name="warehouses" size={16} />
      {pending ? 'Размещение…' : 'Разместить в ячейку'}
    </button>
  );
}

export function PlaceForm({ passportId, orderId, cells }: Props) {
  const action = placePassportAction.bind(null, passportId, orderId);
  const [state, formAction] = useFormState(action, initialState);
  const [cellId, setCellId] = useState<string>(cells[0]?.id ?? '');
  const [cellCode, setCellCode] = useState<string>('');

  return (
    <form action={formAction} className="detail-form">
      <div className="detail-form__grid">
        <div className="detail-form__field">
          <label htmlFor="cellId">Ячейка из списка</label>
          <select
            id="cellId"
            name="cellId"
            value={cellId}
            onChange={(e) => {
              setCellId(e.target.value);
              setCellCode('');
            }}
          >
            <option value="">— выбрать —</option>
            {cells.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code}
                {c.contents.length > 0
                  ? ` · ${c.contents
                      .map((s) => `${s.sizeCode}×${s.quantity}`)
                      .join(', ')}`
                  : ' · пусто'}
              </option>
            ))}
          </select>
        </div>

        <div className="detail-form__field">
          <label htmlFor="cellCode">…или код ячейки</label>
          <input
            id="cellCode"
            name="cellCode"
            type="text"
            placeholder="Например, A1"
            value={cellCode}
            onChange={(e) => {
              setCellCode(e.target.value);
              if (e.target.value) setCellId('');
            }}
            autoComplete="off"
          />
        </div>
      </div>

      <div className="detail-form__actions">
        <SubmitButton />
      </div>

      {state.error && (
        <div className="detail-form__error" role="alert">
          <Icon name="error" size={16} />
          <span>{state.error}</span>
        </div>
      )}
    </form>
  );
}
