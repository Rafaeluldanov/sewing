'use client';

/**
 * Inline-кнопка «Восстановить» в строке таблицы `/admin/employees`
 * (вкладка «Архив»).
 *
 * Архитектурный нюанс. Для **активных** сотрудников row-action нет
 * сознательно: архивирование требует preflight по блокерам (открытая
 * смена, висящие паспорта, открытые MasterCall, REQUESTED-заявки на
 * закрытие раскроя), а делать `GET :id/blockers` на каждый ряд
 * RSC-таблицы дорого. Если у активного сотрудника есть блокер, кнопка
 * «Архивировать» из таблицы регулярно падала бы с 409, и менеджер
 * всё равно шёл бы в карточку разбираться. Поэтому архивирование
 * полностью живёт в блоке «Опасная зона» на `/admin/employees/[id]`,
 * где есть полноценный preflight.
 *
 * Восстановление из архива — безопасная операция без блокеров,
 * поэтому оставляем inline в строке. См.
 * `docs/employee-deletion-recon.md §6.1`.
 */

import { useState, useTransition } from 'react';
import { ArchiveRestore } from 'lucide-react';
import type { EmployeeListItemDto } from '@sewing/shared/employees';
import { restoreEmployeeAction } from './actions';

interface Props {
  employee: EmployeeListItemDto;
  viewerId: string | null;
  viewerRole: string;
}

export function EmployeeRowActions({ employee, viewerId, viewerRole }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Активные сотрудники архивируются только из блока «Опасная зона»
  // карточки (см. JSDoc сверху). Здесь мы не рендерим ничего.
  if (employee.active) return null;

  const isSelf = viewerId === employee.id;
  // SHOP_MANAGER не управляет учётками ADMIN — кнопка disabled.
  const cannotManageAdmin =
    employee.role === 'ADMIN' && viewerRole !== 'ADMIN';
  const disabled = isSelf || cannotManageAdmin || pending;

  const handleRestore = () => {
    setError(null);
    startTransition(async () => {
      const res = await restoreEmployeeAction(employee.id);
      if (res.error) setError(res.error);
    });
  };

  return (
    <div className="employee-row-actions__wrap">
      <button
        type="button"
        className="employee-row-actions__inline"
        onClick={handleRestore}
        disabled={disabled}
        title={
          isSelf
            ? 'Нельзя выполнить действие над собственной карточкой'
            : cannotManageAdmin
            ? 'Управление администратором доступно только администратору'
            : undefined
        }
      >
        <ArchiveRestore size={14} strokeWidth={1.6} aria-hidden />
        {pending ? 'Восстановление…' : 'Восстановить'}
      </button>
      {error && (
        <div className="employee-row-actions__error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
