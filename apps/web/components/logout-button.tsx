import { logoutAction } from '@/app/(auth)/logout-action';
import { Icon } from '@/components/icon';

/**
 * Серверный компонент: оборачивает logout server action в простую
 * `<form>`. Это даёт прогрессивное улучшение — кнопка работает даже
 * без JS на странице, что важно для производственных терминалов.
 */
export function LogoutButton() {
  return (
    <form action={logoutAction}>
      <button type="submit" className="app-header__logout">
        <Icon name="logout" size={14} />
        <span>Выйти</span>
      </button>
    </form>
  );
}
