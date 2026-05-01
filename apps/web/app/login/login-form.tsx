'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { loginAction, type LoginFormState } from './actions';

const initialState: LoginFormState = {};

export function LoginForm({ next }: { next: string }) {
  const [state, formAction] = useFormState(loginAction, initialState);
  return (
    <form action={formAction} className="auth-form">
      <input type="hidden" name="next" value={next} />
      <label className="auth-form__field">
        <span>Логин</span>
        <input
          name="login"
          autoComplete="username"
          required
          autoFocus
          placeholder="например, manager"
        />
      </label>
      <label className="auth-form__field">
        <span>Пароль</span>
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          placeholder="••••••••"
        />
      </label>
      {state.error ? (
        <div className="auth-form__error" role="alert">
          {state.error}
        </div>
      ) : null}
      <SubmitButton />
    </form>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="auth-form__submit" disabled={pending}>
      {pending ? 'Входим…' : 'Войти'}
    </button>
  );
}
