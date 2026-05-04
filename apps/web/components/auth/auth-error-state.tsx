/**
 * Inline-блок ошибки auth-flow с фиксированным текстом из ТЗ.
 *
 * Используется внутри `LoginForm`, но вынесен отдельно, чтобы не
 * дублировать вёрстку в loading.tsx / error boundary, если они
 * появятся.
 */
export function AuthErrorState({
  message = 'Не удалось войти. Проверьте данные и попробуйте ещё раз.',
}: {
  message?: string;
}) {
  return (
    <div className="auth-screen__error" role="alert">
      {message}
    </div>
  );
}
