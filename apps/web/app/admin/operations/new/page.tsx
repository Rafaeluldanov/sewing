import { Icon } from '@/components/icon';
import { DetailPageHeader } from '@/components/detail-page-header';
import { listEquipment } from '@/lib/equipment-api';
import { CreateOperationForm } from '../create-form';

export const dynamic = 'force-dynamic';

/**
 * Отдельная страница создания операции (см. ADR-0020,
 * `docs/screens.md §10c`).
 *
 * Раньше форма жила прямо на `/admin/operations` и перегружала список —
 * теперь это полноценный detail-экран со своим header'ом и back-link'ом,
 * а на списке остаётся только primary-кнопка «Добавить операцию» в
 * правом краю шапки. Тот же UX уже применён к `/admin/equipment/new`
 * (см. ADR-0017).
 *
 * RBAC — на уровне `app/admin/layout.tsx` (только `ADMIN`/`SHOP_MANAGER`),
 * backend независимо защищает `POST /api/operations` через
 * `@Roles('SHOP_MANAGER', 'ADMIN')` (см. `docs/api.md §15a`).
 *
 * Поведение submit'а не менялось: server action `createOperationAction`
 * по успеху редиректит на `/admin/operations/[id]` — менеджер сразу
 * попадает в карточку, чтобы донастроить ставки `BY_SIZE` (если
 * выбран этот режим) или поправить `isActive` (см. `../actions.ts`).
 */
export default async function AdminOperationNewPage() {
  // Список оборудования нужен только ради чек-листа «привязать сразу к
  // станку» (см. `docs/screens.md §10c`). Берём существующий
  // `GET /api/equipment` (роли `ADMIN`/`SHOP_MANAGER`) — отдельная meta
  // нам не нужна, а seamstress-ный `/api/shifts/meta` показывать на
  // admin-экране концептуально странно. Сортировка — по
  // `displayNumber` (если задан) и `name`, чтобы порядок совпадал с
  // ожидаемым «Оверлок №1, №2, …».
  const equipment = (await listEquipment())
    .filter((eq) => eq.active)
    .slice()
    .sort((a, b) => {
      const an = a.displayNumber ?? '';
      const bn = b.displayNumber ?? '';
      if (an && bn && an !== bn) return an.localeCompare(bn, 'ru');
      return a.name.localeCompare(b.name, 'ru');
    });

  return (
    <div className="page-shell">
      <DetailPageHeader
        eyebrow="Тарифы"
        icon="operations"
        title="Новая операция"
        subtitle="Создайте новую операцию и настройте её тарифный режим. Ставки по размерам (BY_SIZE) задаются на карточке сразу после создания."
        backHref="/admin/operations"
        backLabel="К списку операций"
      />

      <section className="card">
        <div className="section-header">
          <h2>
            <Icon name="plus" />
            Параметры операции
          </h2>
          <span className="section-header__hint">
            Код, название, категория и тариф — обязательны. Ставки `BY_SIZE`
            заполняются на карточке.
          </span>
        </div>
        <CreateOperationForm equipment={equipment} />
      </section>
    </div>
  );
}
