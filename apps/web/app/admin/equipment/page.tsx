import { Fragment } from 'react';
import Link from 'next/link';
import { ArrowRight, Factory, Plus } from 'lucide-react';
import { ApiRequestError, errorText } from '@/lib/api';
import { listEquipment } from '@/lib/equipment-api';
import type { EquipmentSummaryDto } from '@sewing/shared/equipment';
import {
  getOperationCategoryLabel,
  groupEquipmentByOperationCategory,
} from '@sewing/shared/operations';
import {
  AdminCard,
  AdminEmptyState,
  AdminPageShell,
  AdminStatusBadge,
} from '@/components/admin';
import { formatStatus, statusTone } from '@/lib/admin-labels';

export const dynamic = 'force-dynamic';

/**
 * Список оборудования (ADR-0017 + ТЗ «Единая группировка» + ТЗ
 * «Compact grouped table»).
 *
 * Backend / Prisma не меняем. Категории берутся из additive-поля
 * `EquipmentSummaryDto.operationCategories` (см. EquipmentService.list).
 *
 * Группировка:
 *   - оборудование делится на секции по primary-категории связанных
 *     операций — первой по `OPERATION_CATEGORY_ORDER`;
 *   - оборудование без операций уходит в группу «Без операций»
 *     (всегда последняя);
 *   - оборудование с несколькими категориями НЕ дублируется по группам:
 *     одна строка в primary-группе + chip-список всех категорий.
 *
 * Compact layout:
 *   - одна общая AdminCard на всю страницу, один table header;
 *   - категории внутри одного tbody как тонкие group-row
 *     разделители (`.admin-compact-group-row`);
 *   - старая «карточка-секция на каждую категорию» сознательно убрана —
 *     лишний header на каждую группу раздувал страницу (см. ТЗ §2);
 *   - оборудование с несколькими категориями встречается в результате
 *     ровно один раз (см. `groupEquipmentByOperationCategory`), все
 *     категории показываются chip-списком в колонке «Категории».
 *
 * Технический code, как и раньше, виден только на карточке `[id]`
 * внутри AdminTechInfo. Здесь — №, название, chip-категории, число
 * операций, статус.
 */
export default async function AdminEquipmentListPage() {
  let items: EquipmentSummaryDto[] = [];
  let error: string | null = null;
  try {
    items = await listEquipment();
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? errorText(e)
        : 'Не удалось загрузить список оборудования';
  }

  const sortedItems = [...items].sort((a, b) => {
    const an = a.displayNumber ?? '';
    const bn = b.displayNumber ?? '';
    if (an && bn && an !== bn) return an.localeCompare(bn, 'ru');
    if (an && !bn) return -1;
    if (!an && bn) return 1;
    return a.name.localeCompare(b.name, 'ru');
  });

  // Адаптируем DTO под shape `groupEquipmentByOperationCategory`:
  // shared-helper ожидает `operations: [{ category }]`, мы строим
  // фейковые операции из массива категорий — этого достаточно для
  // primary-категории и chip-списка (см. ТЗ §6).
  const groupable = sortedItems.map((eq) => ({
    ...eq,
    operations: eq.operationCategories.map((category) => ({ category })),
  }));
  const groups = groupEquipmentByOperationCategory(groupable);

  return (
    <AdminPageShell
      icon={<Factory size={22} strokeWidth={1.6} aria-hidden />}
      title="Оборудование"
      subtitle={`Всего: ${items.length}`}
      actions={
        <Link
          href="/admin/equipment/new"
          className="admin-btn admin-btn--primary"
        >
          <Plus size={16} strokeWidth={1.6} aria-hidden />
          Добавить
        </Link>
      }
    >
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      {groups.length === 0 ? (
        <AdminCard>
          <AdminEmptyState
            icon={<Factory size={26} strokeWidth={1.6} aria-hidden />}
            title="Оборудования пока нет"
            hint="Добавьте первый станок — это займёт меньше минуты."
            actions={
              <Link
                href="/admin/equipment/new"
                className="admin-btn admin-btn--primary"
              >
                <Plus size={16} strokeWidth={1.6} aria-hidden />
                Добавить оборудование
              </Link>
            }
          />
        </AdminCard>
      ) : (
        <AdminCard className="admin-compact-grouped-card admin-equipment-compact-card">
          <div className="admin-compact-table-wrap">
            <table className="admin-table admin-compact-grouped-table admin-equipment-compact-table">
              <thead>
                <tr>
                  <th>№</th>
                  <th>Название</th>
                  <th>Категории</th>
                  <th>Операций</th>
                  <th>Статус</th>
                  <th aria-label="Действия" />
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => (
                  <Fragment key={group.category}>
                    <tr
                      className="admin-compact-group-row admin-equipment-group-row"
                      data-category={group.category}
                    >
                      <td colSpan={6}>
                        <div className="admin-compact-group-row__inner">
                          <span data-category-title={group.category}>
                            {group.label}
                          </span>
                          <span className="admin-compact-group-row__count">
                            {group.equipment.length}
                          </span>
                        </div>
                      </td>
                    </tr>
                    {group.equipment.map((eq) => (
                      <tr
                        key={eq.id}
                        className="admin-compact-row admin-equipment-row"
                      >
                        <td data-label="№">
                          {eq.displayNumber ? (
                            <strong className="admin-equipment-display-number">
                              №{eq.displayNumber}
                            </strong>
                          ) : (
                            <span className="admin-muted">—</span>
                          )}
                        </td>
                        <td data-label="Название">
                          <span className="admin-table__primary">{eq.name}</span>
                        </td>
                        <td data-label="Категории">
                          {eq.operationCategories.length === 0 ? (
                            <span className="admin-muted">—</span>
                          ) : (
                            <ul
                              className="admin-equipment-category-chips"
                              aria-label="Категории операций"
                            >
                              {eq.operationCategories.map((c) => (
                                <li
                                  key={c}
                                  className="admin-equipment-category-chip"
                                  data-category-chip={c}
                                >
                                  {getOperationCategoryLabel(c)}
                                </li>
                              ))}
                            </ul>
                          )}
                        </td>
                        <td data-label="Операций">
                          {eq.allowedOperationsCount === 0 ? (
                            <AdminStatusBadge tone="warning">
                              Не настроено
                            </AdminStatusBadge>
                          ) : (
                            <span>{eq.allowedOperationsCount}</span>
                          )}
                        </td>
                        <td data-label="Статус">
                          <AdminStatusBadge tone={statusTone(eq.active)}>
                            {formatStatus(eq.active)}
                          </AdminStatusBadge>
                        </td>
                        <td className="admin-table__actions admin-compact-row__actions">
                          <Link
                            href={`/admin/equipment/${eq.id}`}
                            className="admin-table__action-link"
                          >
                            Настроить
                            <ArrowRight size={14} strokeWidth={1.6} aria-hidden />
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </AdminCard>
      )}
    </AdminPageShell>
  );
}
