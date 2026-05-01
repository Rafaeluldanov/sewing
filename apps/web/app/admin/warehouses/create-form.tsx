'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { Icon } from '@/components/icon';
import { createWarehouseAction } from './actions';
import {
  initialCreateWarehouseState,
  type CreateWarehouseState,
} from './form-state';

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      <Icon name="plus" size={16} />
      {pending ? 'Создаём…' : 'Создать склад'}
    </button>
  );
}

/**
 * Форма создания склада на `/admin/warehouses/new` (см. `docs/screens.md §10b`).
 *
 * Поля:
 *   - **Название** — обязательное, max 120 символов.
 *   - **Код** — опциональный человекочитаемый идентификатор (max 32),
 *     попадает в QR-этикетку ячейки («Склад: <name> (<code>)»). Если
 *     пусто — backend сохраняет `null`.
 *
 * Уникальность `name`/`code` валидируется на backend бизнес-ошибками
 * `WAREHOUSE_NAME_TAKEN` / `WAREHOUSE_CODE_TAKEN` (см. `docs/api.md §15`).
 * После успешного создания action редиректит на карточку нового склада
 * (`/admin/warehouses/[id]`) — менеджер сразу попадает в место настройки
 * линий и ячеек. Тот же паттерн — у `CreateEquipmentForm` и
 * `CreateOperationForm`.
 */
export function CreateWarehouseForm() {
  const [state, formAction] = useFormState<CreateWarehouseState, FormData>(
    createWarehouseAction,
    initialCreateWarehouseState,
  );

  return (
    <form action={formAction} className="detail-form">
      <div className="detail-form__grid">
        <div className="detail-form__field">
          <label htmlFor="warehouse-name">Название</label>
          <input
            id="warehouse-name"
            name="name"
            type="text"
            maxLength={120}
            placeholder="например, Основной склад"
            required
            autoComplete="off"
          />
          <span className="detail-form__hint">
            Видно менеджерам в списках и в карточках ячеек.
          </span>
        </div>

        <div className="detail-form__field">
          <label htmlFor="warehouse-code">Код</label>
          <input
            id="warehouse-code"
            name="code"
            type="text"
            maxLength={32}
            placeholder="опционально, напр. MAIN"
            autoComplete="off"
          />
          <span className="detail-form__hint">
            Опциональный короткий идентификатор для QR-этикеток ячеек.
            Если пусто — на этикетке будет только название.
          </span>
        </div>
      </div>

      <div className="detail-form__actions">
        <SubmitButton />
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
    </form>
  );
}
