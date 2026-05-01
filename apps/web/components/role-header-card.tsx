import type { ReactNode } from 'react';

export interface RoleHeaderShiftField {
  label: string;
  value: ReactNode;
  meta?: ReactNode;
}

export interface RoleHeaderCardProps {
  /** Имя пользователя (крупным). */
  name: string;
  /** Роль (бейдж справа). */
  role: string;
  /** Поля смены: операция, оборудование, время и т.п. */
  fields?: RoleHeaderShiftField[];
  /** Активна ли смена — управляет статусом-индикатором. */
  shiftActive?: boolean;
  /** Подпись под индикатором (например, «Смена с 09:14»). */
  statusText?: string;
}

/**
 * RoleHeaderCard — фирменная синяя «шапка-профиль» поверх /work
 * (mobile clean redesign). Показывает имя сотрудника, роль и
 * ключевые параметры активной смены крупным шрифтом.
 */
export function RoleHeaderCard({
  name,
  role,
  fields,
  shiftActive,
  statusText,
}: RoleHeaderCardProps) {
  return (
    <div className="role-header" aria-label="Профиль сотрудника">
      <div className="role-header__top">
        <div>
          <div className="role-header__brand">Sewing</div>
          <h1 className="role-header__name">{name}</h1>
        </div>
        <span className="role-header__role">{role}</span>
      </div>
      {fields && fields.length > 0 ? (
        <div className="role-header__shift">
          {fields.map((f) => (
            <div key={f.label}>
              <span className="role-header__shift-label">{f.label}</span>
              <span className="role-header__shift-value">{f.value}</span>
              {f.meta ? (
                <span className="role-header__shift-meta">{f.meta}</span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {statusText ? (
        <span
          className={`role-header__status${shiftActive ? ' role-header__status--active' : ''}`}
        >
          <span className="role-header__status-dot" />
          {statusText}
        </span>
      ) : null}
    </div>
  );
}
