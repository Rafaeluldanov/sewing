/**
 * AdminStatusBadge — мягкая «пилюля» статуса для админских таблиц и
 * detail-карточек.
 *
 * Принимает уже отформатированный лейбл (например, `"Активен"`) и
 * семантический `tone`. Тон считается через `statusTone` из
 * `lib/admin-labels`, чтобы цветовая подсветка везде была
 * согласованной — `success` для DONE/ACTIVE, `info` для IN_PROGRESS,
 * `danger` для CANCELLED/REJECTED, `muted` для остального.
 *
 * Никаких иконок внутри по умолчанию — `dot` это маленький кружок,
 * который рисуется CSS-ом и не зависит от `lucide-react`.
 */
import type { AdminStatusTone } from '@/lib/admin-labels';

interface AdminStatusBadgeProps {
  tone?: AdminStatusTone;
  children: React.ReactNode;
  /** Показать маленькую цветную точку слева (для inline-таблиц). */
  withDot?: boolean;
}

export function AdminStatusBadge({
  tone = 'muted',
  children,
  withDot = false,
}: AdminStatusBadgeProps) {
  return (
    <span className={`admin-status-badge admin-status-badge--${tone}`}>
      {withDot && <span className="admin-status-badge__dot" aria-hidden />}
      {children}
    </span>
  );
}
