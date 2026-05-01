/**
 * AdminEmptyState — мягкое «пусто» для админских таблиц/секций.
 *
 * В TЗ Admin UI Polish empty-state перестал быть техническим
 * («0 строк») и стал подсказкой («Сотрудников ещё нет — добавьте
 * первого»). Поэтому компонент принимает `title` и `hint` строкой/
 * нодой и опциональные `actions` справа.
 *
 * Иконку прокидываем извне (рендерится в `lucide-react`-стиле):
 * это позволяет каждой странице выбрать свою — Users / Factory /
 * Scissors / … — без расширения внутреннего словаря компонента.
 */
import type { ReactNode } from 'react';

interface AdminEmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
}

export function AdminEmptyState({
  icon,
  title,
  hint,
  actions,
}: AdminEmptyStateProps) {
  return (
    <div className="admin-empty">
      {icon != null && <span className="admin-empty__icon">{icon}</span>}
      <span className="admin-empty__title">{title}</span>
      {hint != null && <span className="admin-empty__hint">{hint}</span>}
      {actions != null && (
        <div className="admin-empty__actions">{actions}</div>
      )}
    </div>
  );
}
