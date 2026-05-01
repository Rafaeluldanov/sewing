'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { AlertCircle, Plus } from 'lucide-react';
import type { CompanyDivisionDto } from '@sewing/shared/company-divisions';
import {
  ORDER_DIVISIONS,
  ORDER_DIVISION_LABELS,
} from '@sewing/shared/orders';
import { createDisplayScreenAction } from './actions';
import {
  initialCreateDisplayScreenState,
  type CreateDisplayScreenState,
} from './form-state';

interface Props {
  /**
   * PHASE 1 «CompanyDivision как master-справочник» (см.
   * `docs/domain.md §«Подразделения заказа»»): активные карточки
   * подразделений. Если пусто — UI fallback-ит на legacy enum-select
   * (`ORDER_DIVISIONS`).
   */
  companyDivisions: CompanyDivisionDto[];
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending}
    >
      <Plus size={16} strokeWidth={1.6} aria-hidden />
      {pending ? 'Создаём…' : 'Создать экран'}
    </button>
  );
}

/**
 * Форма создания display-экрана (Admin UI 2.6, ADR-0022 §display).
 *
 * PHASE 1 «CompanyDivision как master-справочник» (см.
 * `docs/domain.md §«Подразделения заказа»`): подразделение
 * выбирается из активных карточек `CompanyDivision` (новый источник
 * истины). Backend синхронизирует пару `(companyDivisionId, division)`
 * по `code` для known whitelist `MARKETPLACE`/`OTHER`. Если список
 * подразделений пуст (новая инсталляция без миграции/seed), форма
 * fallback-ит на legacy enum-select.
 */
export function CreateDisplayScreenForm({ companyDivisions }: Props) {
  const [state, formAction] = useFormState<CreateDisplayScreenState, FormData>(
    createDisplayScreenAction,
    initialCreateDisplayScreenState,
  );

  return (
    <form action={formAction} className="admin-form">
      <div className="admin-form-grid">
        <div className="admin-field">
          <label htmlFor="ds-name">Название</label>
          <input
            id="ds-name"
            name="name"
            type="text"
            minLength={2}
            maxLength={120}
            placeholder="ТВ маркетплейс"
            required
            autoComplete="off"
          />
        </div>

        <div className="admin-field">
          <label htmlFor="ds-companyDivisionId">Подразделение</label>
          {companyDivisions.length > 0 ? (
            <select
              id="ds-companyDivisionId"
              name="companyDivisionId"
              required
              defaultValue=""
            >
              <option value="" disabled>
                Выберите подразделение
              </option>
              {companyDivisions.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          ) : (
            <select id="ds-division" name="division" required defaultValue="">
              <option value="" disabled>
                Выберите подразделение
              </option>
              {ORDER_DIVISIONS.map((d) => (
                <option key={d} value={d}>
                  {ORDER_DIVISION_LABELS[d]}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      <div className="admin-form-grid">
        <div className="admin-field">
          <label htmlFor="ds-login">Логин</label>
          <input
            id="ds-login"
            name="login"
            type="text"
            minLength={2}
            maxLength={64}
            placeholder="display-mp"
            required
            autoComplete="off"
            style={{ textTransform: 'lowercase' }}
          />
        </div>

        <div className="admin-field">
          <label htmlFor="ds-pin">PIN</label>
          <input
            id="ds-pin"
            name="pin"
            type="text"
            minLength={4}
            maxLength={100}
            placeholder="не менее 4 символов"
            required
            autoComplete="off"
          />
        </div>

        <div className="admin-field admin-field--inline">
          <input
            id="ds-active"
            type="checkbox"
            name="isActive"
            defaultChecked
          />
          <label htmlFor="ds-active">Активен</label>
        </div>
      </div>

      <div className="admin-actions-row">
        <SubmitButton />
      </div>

      {state.error && (
        <div className="error-box" role="alert">
          <div className="error-box__msg">
            <AlertCircle size={14} strokeWidth={1.6} aria-hidden /> {state.error}
          </div>
          {state.errorRequestId && (
            <div className="error-box__rid">
              req: <code>{state.errorRequestId}</code>
            </div>
          )}
        </div>
      )}
    </form>
  );
}
