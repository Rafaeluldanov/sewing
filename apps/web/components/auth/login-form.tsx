'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { loginAction, type LoginFormState } from '@/app/login/actions';
import { AuthErrorState } from './auth-error-state';

const initialState: LoginFormState = {};

/**
 * Форма входа на новом дизайне.
 *
 * Server action (`loginAction` в `apps/web/app/login/actions.ts`) и
 * сетевая часть не меняются — мы по-прежнему форвардим cookie через
 * `loginAndPersistSession`. На стороне UI:
 *   - крупные тач-цели и понятные подписи (mobile-first);
 *   - disabled/loading у кнопки во время отправки;
 *   - ошибки — через `AuthErrorState` с фиксированным fallback-текстом
 *     из ТЗ; при этом мы предпочитаем серверное сообщение, если оно
 *     пришло (например, `INVALID_CREDENTIALS` / `USER_DISABLED`), —
 *     именно это сообщение исторически было информативным.
 *
 * `next` — это safeReturnTo, прокинутый со страницы. Его сразу
 * прячем в hidden-input, чтобы server action прочитал его из FormData.
 */
export function LoginForm({ next }: { next: string }) {
  const [state, formAction] = useFormState(loginAction, initialState);
  return (
    <form action={formAction} className="auth-screen__form" noValidate>
      <input type="hidden" name="next" value={next} />
      <label className="auth-screen__field">
        <span className="auth-screen__label">Логин</span>
        <input
          name="login"
          autoComplete="username"
          required
          autoFocus
          className="auth-screen__input"
          placeholder="например, manager"
        />
      </label>
      <label className="auth-screen__field">
        <span className="auth-screen__label">Пароль</span>
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="auth-screen__input"
          placeholder="••••••••"
        />
      </label>
      {state.error ? <AuthErrorState message={state.error} /> : null}
      <SubmitButton />
    </form>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="auth-screen__submit"
      disabled={pending}
      aria-busy={pending}
    >
      {pending ? 'Входим…' : 'Войти'}
    </button>
  );
}
