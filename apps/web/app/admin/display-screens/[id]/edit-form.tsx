'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { AlertCircle, KeyRound, Save } from 'lucide-react';
import type { CompanyDivisionDto } from '@sewing/shared/company-divisions';
import type { DisplayScreenDetailDto } from '@sewing/shared/display-screens';
import {
  updateDisplayScreenAction,
  updateDisplayScreenPinAction,
} from './actions';
import {
  initialUpdateDisplayPinState,
  initialUpdateDisplayScreenState,
  type UpdateDisplayPinState,
  type UpdateDisplayScreenState,
} from './form-state';

function SubmitButton({
  label,
  pendingLabel,
  icon,
}: {
  label: string;
  pendingLabel: string;
  icon: React.ReactNode;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending}
    >
      {icon}
      {pending ? pendingLabel : label}
    </button>
  );
}

function FormFeedback({
  state,
}: {
  state: UpdateDisplayScreenState | UpdateDisplayPinState;
}) {
  return (
    <>
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
      {state.ok && state.successMessage && (
        <div
          role="status"
          className="admin-muted"
          style={{ fontSize: '0.88rem' }}
        >
          {state.successMessage}
        </div>
      )}
    </>
  );
}

/**
 * «Основное» карточки экрана: название, подразделение, логин учётки.
 *
 * Поля и их правила — зеркало формы создания (`../create-form.tsx`):
 * расхождение «завести можно, а сохранить нельзя» было бы худшим из
 * багов этой пары форм. Подразделение выбирается из активных карточек
 * `CompanyDivision` (см. `docs/domain.md §«Подразделения заказа»`);
 * именно ради его смены карточка и появилась — раньше переезд экрана
 * в другое подразделение требовал удалить его и завести заново, теряя
 * DISPLAY-учётку вместе с логином.
 *
 * Текущее подразделение подставлено в `defaultValue`. Если карточка
 * подразделения успела уехать в архив, её не будет в списке опций —
 * тогда select покажет плейсхолдер, и менеджер обязан выбрать живое
 * подразделение осознанно (молча сохранить «пусто» форма не даст).
 */
export function DisplayScreenMainForm({
  screen,
  companyDivisions,
}: {
  screen: DisplayScreenDetailDto;
  companyDivisions: CompanyDivisionDto[];
}) {
  const action = updateDisplayScreenAction.bind(null, screen.id);
  const [state, formAction] = useFormState<UpdateDisplayScreenState, FormData>(
    action,
    initialUpdateDisplayScreenState,
  );

  const divisionKnown = companyDivisions.some(
    (d) => d.id === screen.companyDivisionId,
  );

  return (
    <form action={formAction} className="admin-form">
      <div className="admin-form-grid">
        <div className="admin-field">
          <label htmlFor="ds-edit-name">Название</label>
          <input
            id="ds-edit-name"
            name="name"
            type="text"
            minLength={2}
            maxLength={120}
            defaultValue={screen.name}
            placeholder="ТВ маркетплейс"
            required
            autoComplete="off"
          />
        </div>

        <div className="admin-field">
          <label htmlFor="ds-edit-companyDivisionId">Подразделение</label>
          <select
            id="ds-edit-companyDivisionId"
            name="companyDivisionId"
            required
            defaultValue={
              divisionKnown ? (screen.companyDivisionId ?? '') : ''
            }
            disabled={companyDivisions.length === 0}
          >
            <option value="" disabled>
              {companyDivisions.length === 0
                ? '— нет подразделений —'
                : 'Выберите подразделение'}
            </option>
            {companyDivisions.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          {!divisionKnown && screen.companyDivision && (
            <p className="admin-muted" style={{ fontSize: '0.82rem' }}>
              Сейчас: {screen.companyDivision.name} — карточка не в списке
              активных подразделений.
            </p>
          )}
        </div>
      </div>

      <div className="admin-form-grid">
        <div className="admin-field">
          <label htmlFor="ds-edit-login">Логин</label>
          <input
            id="ds-edit-login"
            name="login"
            type="text"
            minLength={2}
            maxLength={64}
            defaultValue={screen.employeeLogin}
            placeholder="display-mp"
            required
            autoComplete="off"
            style={{ textTransform: 'lowercase' }}
          />
          <p className="admin-muted" style={{ fontSize: '0.82rem' }}>
            Логин DISPLAY-учётки этого монитора. После смены экран
            придётся залогинить заново.
          </p>
        </div>
      </div>

      <div className="admin-actions-row">
        <SubmitButton
          label="Сохранить"
          pendingLabel="Сохраняем…"
          icon={<Save size={16} strokeWidth={1.6} aria-hidden />}
        />
      </div>

      <FormFeedback state={state} />
    </form>
  );
}

/**
 * Смена PIN'а монитора — отдельной формой.
 *
 * Отдельной, а не полем в «Основном», сознательно: сохранение
 * названия не должно иметь ни малейшего шанса сбросить код, по
 * которому железка в цехе логинится. Поле повтора — защита от
 * опечатки: текущий PIN нигде не хранится в открытом виде (только
 * bcrypt-hash в `Employee.pinHash`), так что ошибиться и не заметить
 * можно ровно один раз — до следующей перезагрузки монитора.
 */
export function DisplayScreenPinForm({
  screen,
}: {
  screen: DisplayScreenDetailDto;
}) {
  const action = updateDisplayScreenPinAction.bind(null, screen.id);
  const [state, formAction] = useFormState<UpdateDisplayPinState, FormData>(
    action,
    initialUpdateDisplayPinState,
  );

  return (
    <form action={formAction} className="admin-form">
      <div className="admin-form-grid">
        <div className="admin-field">
          <label htmlFor="ds-edit-pin">Новый PIN</label>
          <input
            id="ds-edit-pin"
            name="pin"
            type="text"
            minLength={4}
            maxLength={100}
            placeholder="не менее 4 символов"
            required
            autoComplete="off"
          />
        </div>
        <div className="admin-field">
          <label htmlFor="ds-edit-pin-repeat">Повторите PIN</label>
          <input
            id="ds-edit-pin-repeat"
            name="pinRepeat"
            type="text"
            minLength={4}
            maxLength={100}
            placeholder="ещё раз"
            required
            autoComplete="off"
          />
        </div>
      </div>

      <div className="admin-actions-row">
        <SubmitButton
          label="Сменить PIN"
          pendingLabel="Меняем…"
          icon={<KeyRound size={16} strokeWidth={1.6} aria-hidden />}
        />
      </div>

      <FormFeedback state={state} />
    </form>
  );
}
