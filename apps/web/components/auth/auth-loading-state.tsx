/**
 * Компактный fallback для auth-flow.
 *
 * Не используется самим логином (там есть собственный pending-state
 * у кнопки), но нужен для server-component'ов / loading.tsx, чтобы не
 * мигать legacy-UI при медленной сети. Лежит в `components/auth/`,
 * чтобы переиспользовать вместе с `AuthShell` и `AuthCard`.
 */
export function AuthLoadingState({
  text = 'Входим…',
}: {
  text?: string;
}) {
  return (
    <div className="auth-screen__status" role="status" aria-live="polite">
      <span className="auth-screen__spinner" aria-hidden />
      <span>{text}</span>
    </div>
  );
}
