import { ApiRequestError } from '@/lib/api';
import { getShiftMeta } from '@/lib/shifts-api';
import type { OperationLiteDto } from '@sewing/shared/shifts';
import { Icon } from '@/components/icon';
import { DetailPageHeader } from '@/components/detail-page-header';
import { CreateEquipmentForm } from '../create-form';

export const dynamic = 'force-dynamic';

/**
 * Отдельная страница создания оборудования (см. ADR-0017,
 * `docs/screens.md §10a`).
 *
 * Раньше форма жила прямо на `/admin/equipment` и перегружала список —
 * теперь это полноценный detail-экран со своим header'ом и back-link'ом.
 * Список операций берём из `GET /api/shifts/meta`, тот же источник
 * использует и карточка `/admin/equipment/[id]`. Поломка meta не
 * должна ронять страницу: при ошибке оставляем пустой список — менеджер
 * допроставит операции позже на карточке нового станка.
 *
 * Поведение submit'а не менялось: server action `createEquipmentAction`
 * по успеху редиректит на `/admin/equipment/[id]` нового станка
 * (см. `../actions.ts`).
 */
export default async function AdminEquipmentNewPage() {
  let operations: readonly OperationLiteDto[] = [];
  let metaError: string | null = null;
  try {
    const meta = await getShiftMeta();
    operations = meta.operations;
  } catch (e) {
    metaError =
      e instanceof ApiRequestError
        ? `${e.message}${e.code ? ` (${e.code})` : ''}`
        : 'Не удалось загрузить список операций — можно настроить позже на карточке оборудования.';
    operations = [];
  }

  return (
    <div className="page-shell">
      <DetailPageHeader
        eyebrow="Производственный парк"
        icon="equipment"
        title="Новое оборудование"
        subtitle="Минимум — название. Номер и код опциональны (если код пуст, он сгенерируется из названия). Операции можно настроить позже на карточке оборудования."
        backHref="/admin/equipment"
        backLabel="К списку оборудования"
      />

      {metaError && (
        <div className="error-box" role="alert">
          <div className="error-box__msg">{metaError}</div>
        </div>
      )}

      <section className="card">
        <div className="section-header">
          <h2>
            <Icon name="plus" />
            Параметры оборудования
          </h2>
        </div>
        <CreateEquipmentForm operations={operations} />
      </section>
    </div>
  );
}
