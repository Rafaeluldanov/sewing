import { Icon } from '@/components/icon';
import { DetailPageHeader } from '@/components/detail-page-header';
import { CreateWarehouseForm } from '../create-form';

export const dynamic = 'force-dynamic';

/**
 * Отдельная страница создания склада (см. `docs/screens.md §10b`).
 *
 * Раньше форма жила прямо на `/admin/warehouses` и перегружала список —
 * теперь это полноценный detail-экран со своим header'ом и back-link'ом,
 * а на списке остаётся только primary-кнопка «Добавить склад» в правом
 * краю шапки. Тот же UX уже применён к `/admin/equipment/new` (ADR-0017)
 * и `/admin/operations/new` (ADR-0020).
 *
 * RBAC — на уровне `app/admin/layout.tsx` (только `ADMIN`/`SHOP_MANAGER`),
 * backend независимо защищает `POST /api/warehouses` через
 * `@Roles('SHOP_MANAGER', 'ADMIN')` (см. `docs/api.md §15`).
 *
 * Поведение submit'а не менялось: server action `createWarehouseAction`
 * по успеху редиректит на `/admin/warehouses/[id]` нового склада —
 * менеджер сразу попадает в карточку, чтобы массово создать линию ячеек
 * (`A1..A20`) и/или привязать существующие ячейки (см. `../actions.ts`).
 */
export default function AdminWarehouseNewPage() {
  return (
    <div className="page-shell">
      <DetailPageHeader
        eyebrow="Хранение"
        icon="warehouses"
        title="Новый склад"
        subtitle="Создайте новый склад и настройте его структуру (линии и ячейки) на следующем экране — в карточке склада."
        backHref="/admin/warehouses"
        backLabel="К списку складов"
      />

      <section className="card">
        <div className="section-header">
          <h2>
            <Icon name="plus" />
            Параметры склада
          </h2>
          <span className="section-header__hint">
            Минимум — название. Код опционален и используется в QR-этикетках
            ячеек; уникальность <code>name</code>/<code>code</code>
            проверяется на backend.
          </span>
        </div>
        <CreateWarehouseForm />
      </section>
    </div>
  );
}
