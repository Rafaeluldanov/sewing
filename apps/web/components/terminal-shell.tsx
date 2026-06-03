import type { ReactNode } from 'react';
import {
  RoleHeaderCard,
  type RoleHeaderShiftField,
} from '@/components/role-header-card';
import { SeamstressActionsMenu } from '@/app/work/seamstress-actions-menu';

export interface TerminalShellProps {
  /** Имя сотрудника (крупным в синей карте). */
  name: string;
  /** Подпись роли (бейдж в карте). */
  role: string;
  /** Поля смены (операция/оборудование/время). Нет — карта без сетки. */
  fields?: RoleHeaderShiftField[];
  /** Активна ли смена (статус-индикатор + пункт «Завершить смену»). */
  shiftActive?: boolean;
  /** Подпись под индикатором смены. */
  statusText?: string;
  /**
   * Показывать три-точечное меню действий `SeamstressActionsMenu`
   * («Завершить смену» — только при `shiftActive` — и «Выйти»). Для
   * кабинетов без смены (раскрой/конструктор) даёт меню с одним
   * «Выйти».
   */
  showActionsMenu?: boolean;
  children: ReactNode;
}

/**
 * Единый шаблон рабочего экрана терминала сотрудника: синяя
 * `RoleHeaderCard` сверху + (опционально) меню «⋯» в углу карты — всё
 * в той же обёртке `.work .work--seamstress`, что у ОТК/ВТО/упаковки/
 * швеи. Размеры и позиционирование берутся из общих стилей `.work`,
 * `.role-header*`, `.seamstress-actions*`; собственных оверрайдов нет,
 * поэтому блоки совпадают с ОТК один в один.
 *
 * Контент терминала передаётся как `children` и ложится под карту с
 * `gap: 1rem` (см. `.work`).
 */
export function TerminalShell({
  name,
  role,
  fields,
  shiftActive,
  statusText,
  showActionsMenu,
  children,
}: TerminalShellProps) {
  return (
    <div className="work work--seamstress">
      {showActionsMenu ? (
        <SeamstressActionsMenu shiftActive={!!shiftActive} />
      ) : null}
      <RoleHeaderCard
        name={name}
        role={role}
        fields={fields}
        shiftActive={shiftActive}
        statusText={statusText}
      />
      {children}
    </div>
  );
}
