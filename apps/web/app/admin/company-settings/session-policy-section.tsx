'use client';

import { useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import { CheckCircle, LogOut, Save, ShieldAlert, XCircle } from 'lucide-react';
import {
  sessionIdleTimeoutLabel,
  SESSION_IDLE_TIMEOUT_PRESETS,
  type CompanySettingsDto,
} from '@sewing/shared/company-settings';
import { AdminCard, AdminSectionHeader } from '@/components/admin';
import {
  terminateSessionsAction,
  updateSessionIdleTimeoutAction,
} from './actions';
import {
  initialUpdateSessionPolicyState,
  type UpdateSessionPolicyState,
} from './form-state';

/**
 * Секция «Вход и сессии» на `/admin/company-settings?tab=security`.
 *
 * Решает вполне бытовую проблему цеха: терминал один на несколько
 * человек, кнопку «Выйти» после смены почти никто не жмёт, и следующий
 * работает под чужой учёткой — выработка и брак уходят не тому
 * сотруднику. Сессия при этом живёт 12 часов от входа, то есть до
 * утра.
 *
 * Здесь две разные вещи, поэтому и форм две:
 *   - НАСТРОЙКА «выходить после N минут бездействия» — постоянное
 *     правило, применяется ко всем новым и продлеваемым сессиям;
 *   - ДЕЙСТВИЕ «Завершить все сеансы» — разовое, с немедленным
 *     эффектом на весь цех. Смешивать его с сохранением формы нельзя:
 *     случайно выгнать всех, поправив реквизиты, — плохая история.
 *
 * Выпадающий список, а не поле ввода минут: значимых режимов немного,
 * а свободный ввод порождает вопрос «а 7 минут — это нормально?».
 */

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      <Save size={16} aria-hidden />
      {pending ? 'Сохраняем…' : 'Сохранить'}
    </button>
  );
}

function TerminateButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-danger" disabled={pending}>
      <LogOut size={16} aria-hidden />
      {pending ? 'Завершаем…' : 'Завершить все сеансы'}
    </button>
  );
}

function Feedback({ state }: { state: UpdateSessionPolicyState }) {
  if (state.error) {
    return (
      <p className="form-error" role="alert">
        <XCircle size={16} aria-hidden /> {state.error}
        {state.errorRequestId ? ` (${state.errorRequestId})` : ''}
      </p>
    );
  }
  if (state.ok && state.successMessage) {
    return (
      <p className="form-success" role="status">
        <CheckCircle size={16} aria-hidden /> {state.successMessage}
      </p>
    );
  }
  return null;
}

export function SessionPolicySection({
  settings,
}: {
  settings: CompanySettingsDto;
}) {
  const [idleState, idleFormAction] = useFormState<
    UpdateSessionPolicyState,
    FormData
  >(updateSessionIdleTimeoutAction, initialUpdateSessionPolicyState);
  const [terminateState, terminateFormAction] = useFormState<
    UpdateSessionPolicyState,
    FormData
  >(terminateSessionsAction, initialUpdateSessionPolicyState);
  // Подтверждение в два шага — вместо `confirm()`, который в терминале
  // на планшете выглядит инородно и не читается на ходу.
  const [confirming, setConfirming] = useState(false);

  const validFrom = settings.sessionsValidFrom
    ? new Date(settings.sessionsValidFrom).toLocaleString('ru-RU', {
        timeZone: 'Europe/Moscow',
        dateStyle: 'short',
        timeStyle: 'short',
      })
    : null;

  return (
    <>
      <AdminCard>
        <AdminSectionHeader
          title="Вход и сессии"
          hint="когда система сама выводит сотрудника из учётной записи"
        />
        <div style={{ height: 8 }} />

        <form action={idleFormAction} className="off-route">
          <div className="off-route__control">
            <label
              className="off-route__label"
              htmlFor="sessionIdleTimeoutMinutes"
            >
              Выходить из системы
            </label>
            <select
              id="sessionIdleTimeoutMinutes"
              name="sessionIdleTimeoutMinutes"
              defaultValue={String(settings.sessionIdleTimeoutMinutes)}
              className="off-route__select"
            >
              {SESSION_IDLE_TIMEOUT_PRESETS.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {sessionIdleTimeoutLabel(minutes)}
                </option>
              ))}
            </select>
            <SaveButton />
          </div>

          <p className="off-route__desc">
            Отсчёт идёт от последнего действия человека: клика, нажатия
            клавиши, скана. Пока сотрудник работает, сессия продлевается
            сама. За минуту до выхода на экране появляется предупреждение —
            одно нажатие возвращает полное время.
          </p>
          <p className="off-route__desc">
            Выход из системы <b>не закрывает смену</b> и не отменяет
            начатую работу: сотрудник входит заново и продолжает с того же
            места. Экраны-мониторы цеха (учётка <code>DISPLAY</code>) под
            автовыход не попадают — доска на стене должна гореть всю смену.
          </p>

          <Feedback state={idleState} />
        </form>
      </AdminCard>

      <AdminCard>
        <AdminSectionHeader
          title="Завершить все сеансы"
          hint="разом выкинуть из системы всех, кто сейчас в ней"
        />
        <div style={{ height: 8 }} />

        <div className="off-route">
          <p className="off-route__desc">
            <ShieldAlert size={16} aria-hidden /> Если терминал остался
            залогиненным, а подойти к нему некому — сеансы можно оборвать
            разом. Все сотрудники, включая вас, увидят форму входа; данные
            и открытые смены при этом не трогаются.
            {validFrom ? (
              <>
                {' '}
                Последний раз: <b>{validFrom}</b>.
            </>
          ) : null}
        </p>

        {confirming ? (
          <form action={terminateFormAction} className="off-route__control">
            <span className="off-route__label">
              Завершить сеансы у всех сотрудников?
            </span>
            <button
              type="button"
              className="btn"
              onClick={() => setConfirming(false)}
            >
              Отмена
            </button>
            <TerminateButton />
          </form>
        ) : (
          <div className="off-route__control">
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => setConfirming(true)}
            >
              <LogOut size={16} aria-hidden />
              Завершить все сеансы
            </button>
          </div>
        )}

        <Feedback state={terminateState} />
      </div>
    </AdminCard>
    </>
  );
}
