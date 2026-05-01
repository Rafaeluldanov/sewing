'use client';

import { useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import {
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Layers,
  Plus,
  Save,
  XCircle,
} from 'lucide-react';
import type { CompanyDivisionDto } from '@sewing/shared/company-divisions';
import {
  AdminCard,
  AdminEmptyState,
  AdminSectionHeader,
  AdminStatusBadge,
  AdminTable,
  type AdminTableColumn,
} from '@/components/admin';
import { formatStatus, statusTone } from '@/lib/admin-labels';
import {
  createCompanyDivisionAction,
  toggleCompanyDivisionActiveAction,
  updateCompanyDivisionAction,
} from './actions';
import {
  initialCreateCompanyDivisionState,
  initialUpdateCompanyDivisionState,
  type CreateCompanyDivisionState,
  type UpdateCompanyDivisionState,
} from './form-state';

function CreateSubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending}
    >
      <Plus size={16} strokeWidth={1.6} aria-hidden />
      {pending ? 'Создаём…' : 'Создать подразделение'}
    </button>
  );
}

function CreateDivisionForm({
  onCreated,
}: {
  onCreated: () => void;
}) {
  const [state, formAction] = useFormState<
    CreateCompanyDivisionState,
    FormData
  >(createCompanyDivisionAction, initialCreateCompanyDivisionState);
  const justOk = state.ok && state.successMessage;
  if (justOk) {
    // Сообщаем родителю — он закрывает форму после успешного create.
    setTimeout(onCreated, 0);
  }
  return (
    <form action={formAction} className="admin-form">
      <div className="admin-form-grid">
        <div className="admin-field">
          <label htmlFor="new-division-code">Код</label>
          <input
            id="new-division-code"
            name="code"
            type="text"
            required
            maxLength={64}
            placeholder="MAIN_SHOP"
            autoComplete="off"
          />
          <span className="admin-field__hint">
            Латиница, цифры, дефис, подчёркивание. Используется как идентификатор.
          </span>
        </div>
        <div className="admin-field">
          <label htmlFor="new-division-name">Название</label>
          <input
            id="new-division-name"
            name="name"
            type="text"
            required
            maxLength={200}
            placeholder="Цех №1"
          />
        </div>
        <div className="admin-field">
          <label htmlFor="new-division-sortOrder">Порядок</label>
          <input
            id="new-division-sortOrder"
            name="sortOrder"
            type="number"
            min={0}
            max={100000}
            defaultValue={100}
          />
          <span className="admin-field__hint">
            Чем меньше число — тем выше в списке.
          </span>
        </div>
      </div>
      <div className="admin-field">
        <label htmlFor="new-division-description">Описание</label>
        <textarea
          id="new-division-description"
          name="description"
          maxLength={1000}
          rows={2}
        />
      </div>

      {state.error && (
        <div className="error-box" role="alert">
          <XCircle size={16} strokeWidth={1.6} aria-hidden /> {state.error}
        </div>
      )}

      <div className="admin-actions-row">
        <CreateSubmitButton />
      </div>
    </form>
  );
}

function EditSubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending}
    >
      <Save size={14} strokeWidth={1.6} aria-hidden />
      {pending ? 'Сохраняем…' : 'Сохранить'}
    </button>
  );
}

function EditDivisionForm({
  division,
}: {
  division: CompanyDivisionDto;
}) {
  const [state, formAction] = useFormState<
    UpdateCompanyDivisionState,
    FormData
  >(
    updateCompanyDivisionAction.bind(null, division.id),
    initialUpdateCompanyDivisionState,
  );
  return (
    <form action={formAction} className="admin-form">
      <div className="admin-form-grid">
        <div className="admin-field">
          <label htmlFor={`edit-division-code-${division.id}`}>Код</label>
          <input
            id={`edit-division-code-${division.id}`}
            name="code"
            type="text"
            required
            maxLength={64}
            defaultValue={division.code}
            autoComplete="off"
          />
        </div>
        <div className="admin-field">
          <label htmlFor={`edit-division-name-${division.id}`}>Название</label>
          <input
            id={`edit-division-name-${division.id}`}
            name="name"
            type="text"
            required
            maxLength={200}
            defaultValue={division.name}
          />
        </div>
        <div className="admin-field">
          <label htmlFor={`edit-division-sortOrder-${division.id}`}>
            Порядок
          </label>
          <input
            id={`edit-division-sortOrder-${division.id}`}
            name="sortOrder"
            type="number"
            min={0}
            max={100000}
            defaultValue={division.sortOrder}
          />
        </div>
      </div>
      <div className="admin-field">
        <label htmlFor={`edit-division-description-${division.id}`}>
          Описание
        </label>
        <textarea
          id={`edit-division-description-${division.id}`}
          name="description"
          maxLength={1000}
          rows={2}
          defaultValue={division.description ?? ''}
        />
      </div>
      <label className="admin-field admin-field--inline">
        <input
          type="checkbox"
          name="isActive"
          defaultChecked={division.isActive}
        />
        <span>Активно</span>
      </label>

      {state.error && (
        <div className="error-box" role="alert">
          <XCircle size={16} strokeWidth={1.6} aria-hidden /> {state.error}
        </div>
      )}
      {state.ok && state.successMessage && (
        <div className="success-box" role="status">
          <CheckCircle size={16} strokeWidth={1.6} aria-hidden />{' '}
          {state.successMessage}
        </div>
      )}

      <div className="admin-actions-row">
        <EditSubmitButton />
      </div>
    </form>
  );
}

/**
 * Inline-кнопка «Включить» / «Отключить» в строке таблицы.
 * Submit идёт через server action `toggleCompanyDivisionActiveAction`,
 * который под капотом вызывает PATCH `/api/company-divisions/:id` с
 * нужным `isActive`.
 *
 * Кнопка живёт в отдельной `<form>` рядом с кнопкой раскрытия
 * редактора — два разных POST endpoint-а уживаются в строке без
 * клиентского JS state.
 */
function ToggleActiveButton({
  division,
}: {
  division: CompanyDivisionDto;
}) {
  const next = !division.isActive;
  return (
    <form action={toggleCompanyDivisionActiveAction}>
      <input type="hidden" name="id" value={division.id} />
      <input type="hidden" name="isActive" value={String(next)} />
      <button
        type="submit"
        className={
          'admin-btn admin-btn--ghost' +
          (division.isActive ? '' : ' admin-btn--primary')
        }
      >
        {division.isActive ? 'Отключить' : 'Включить'}
      </button>
    </form>
  );
}

/**
 * Раскрываемая строка с inline-формой редактирования. Локальный
 * `useState` для open/close — более лёгкий UX, чем переход в
 * отдельный `/admin/company-settings/divisions/[id]`. Подразделений в
 * MVP мало (десятки), и менеджер обычно правит «сразу несколько» —
 * быстрее одним списком.
 */
function DivisionRow({
  division,
}: {
  division: CompanyDivisionDto;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="admin-stack" style={{ gap: 6 }}>
      <div
        className="admin-actions-row"
        style={{ flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' }}
      >
        <button
          type="button"
          className="admin-btn admin-btn--ghost"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? (
            <>
              <ChevronUp size={14} strokeWidth={1.6} aria-hidden />
              Свернуть
            </>
          ) : (
            <>
              <ChevronDown size={14} strokeWidth={1.6} aria-hidden />
              Изменить
            </>
          )}
        </button>
        <ToggleActiveButton division={division} />
      </div>
      {open && (
        <div
          style={{
            marginTop: 4,
            padding: 12,
            border: '1px solid var(--admin-border)',
            borderRadius: 12,
            background: 'var(--admin-surface)',
          }}
        >
          <EditDivisionForm division={division} />
        </div>
      )}
    </div>
  );
}

/**
 * Карточка-секция «Подразделения» на странице `/admin/company-settings`.
 *
 * Включает:
 *   - заголовок секции + кнопка-toggle «Добавить подразделение»;
 *   - inline-форма создания (раскрывается по кнопке);
 *   - таблица всех подразделений (включая отключённые — у них
 *     приглушённый стиль и кнопка «Включить» вместо «Отключить»);
 *   - inline-форма редактирования по каждой строке (раскрывается
 *     отдельной «Изменить»).
 *
 * Удаление out-of-scope (см. `docs/domain.md §«Настройки компании»`):
 * менеджер пользуется кнопкой «Отключить».
 */
export function DivisionsSection({
  divisions,
}: {
  divisions: CompanyDivisionDto[];
}) {
  const [creating, setCreating] = useState(false);
  const active = divisions.filter((d) => d.isActive);
  const inactive = divisions.filter((d) => !d.isActive);

  const columns: AdminTableColumn<CompanyDivisionDto>[] = [
    {
      key: 'code',
      header: 'Код',
      render: (d) => <code className="admin-table__primary">{d.code}</code>,
    },
    {
      key: 'name',
      header: 'Название',
      render: (d) => d.name,
    },
    {
      key: 'description',
      header: 'Описание',
      render: (d) =>
        d.description ?? <span className="admin-muted">—</span>,
    },
    {
      key: 'sortOrder',
      header: 'Порядок',
      align: 'right',
      render: (d) => d.sortOrder,
    },
    {
      key: 'status',
      header: 'Статус',
      render: (d) => (
        <AdminStatusBadge tone={statusTone(d.isActive)}>
          {formatStatus(d.isActive)}
        </AdminStatusBadge>
      ),
    },
    {
      key: 'actions',
      header: '',
      isAction: true,
      render: (d) => <DivisionRow division={d} />,
    },
  ];

  return (
    <AdminCard>
      <AdminSectionHeader
        icon={<Layers size={18} strokeWidth={1.6} aria-hidden />}
        title="Подразделения"
        hint={`Активных: ${active.length} · Отключённых: ${inactive.length}`}
        actions={
          <button
            type="button"
            className="admin-btn admin-btn--primary"
            onClick={() => setCreating((v) => !v)}
          >
            <Plus size={16} strokeWidth={1.6} aria-hidden />
            {creating ? 'Скрыть форму' : 'Добавить подразделение'}
          </button>
        }
      />

      {creating && (
        <div
          style={{
            marginBottom: 16,
            padding: 12,
            border: '1px solid var(--admin-border)',
            borderRadius: 12,
            background: 'var(--admin-surface)',
          }}
        >
          <CreateDivisionForm onCreated={() => setCreating(false)} />
        </div>
      )}

      <AdminTable
        rows={divisions}
        columns={columns}
        rowKey={(d) => d.id}
        emptyContent={
          <AdminEmptyState
            icon={<Layers size={26} strokeWidth={1.6} aria-hidden />}
            title="Подразделений ещё нет"
            hint="Заведите хотя бы одно подразделение через кнопку «Добавить»."
          />
        }
      />
    </AdminCard>
  );
}
