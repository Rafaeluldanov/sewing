/**
 * `OrderApplicationsCard` — блок «Нанесение» в карточке заказа.
 *
 * Этап «Нанесение на заказе покупателя» (см.
 * `apps/api/src/modules/order-applications/*`,
 * `packages/shared/src/order-applications.ts`).
 *
 * Серверный компонент: грузит список нанесений по заказу через
 * `getOrderApplications(orderId)`. Если backend упал — показывает
 * error-box, не валит карточку заказа (по тем же принципам, что
 * `WorkshopNeedsCard` / `CutReadinessCard`).
 *
 * UX по статусу заказа:
 *   - любой статус, кроме `CANCELLED` — интерактивная форма
 *     редактирования (`OrderApplicationsForm`): клиент просит принт и
 *     тогда, когда тираж уже кроят.
 *   - `CANCELLED` — read-only список карточек нанесения.
 *   - после завершения расчёта (`isOrderApplicationsLateEdit`) над
 *     формой висит плашка: потребность синхронизируется точечно, а
 *     удалить нанесение, по которому уже пошла закупка, нельзя (409
 *     `ORDER_APPLICATION_HAS_PURCHASE`).
 *
 * Backend / DTO / API не меняем — это чистая presentation-обёртка.
 */
import { ChevronDown, Stamp } from 'lucide-react';
import {
  describeApplicationScope,
  isOrderApplicationsEditable,
  isOrderApplicationsLateEdit,
  type OrderApplicationDto,
} from '@sewing/shared/order-applications';
import type { OrderStatus } from '@sewing/shared/orders';
import {
  AdminCard,
  AdminEmptyState,
  AdminSectionHeader,
  AdminStatusBadge,
} from '@/components/admin';
import { ApiRequestError, errorText } from '@/lib/api';
import { getOrderApplications } from '@/lib/order-applications-api';
import type { AdminStatusTone } from '@/lib/admin-labels';
import { OrderApplicationsForm } from './order-applications-form';

interface Props {
  orderId: string;
  /**
   * Статус родительского заказа управляет режимом блока:
   *   - любой, кроме `CANCELLED` — форма редактирования (replace по
   *     `id` через PUT), см. `isOrderApplicationsEditable`;
   *   - `CANCELLED` — read-only список (backend-инвариант
   *     `ORDER_APPLICATION_ORDER_LOCKED`).
   */
  orderStatus: OrderStatus;
  /**
   * Размеры заказа для адресации нанесения «на выбранные размеры»
   * (этап «Нанесение по размерам»). Нужны только в режиме формы. Если
   * не переданы — режим «выбранные размеры» в форме будет недоступен.
   */
  sizes?: { id: string; code: string }[];
}

function statusTone(status: string): AdminStatusTone {
  switch (status) {
    case 'PLANNED':
      return 'info';
    case 'SENT':
      return 'warning';
    case 'DONE':
      return 'success';
    case 'CANCELLED':
      return 'muted';
    default:
      return 'muted';
  }
}

export async function OrderApplicationsCard({
  orderId,
  orderStatus,
  sizes = [],
}: Props) {
  let applications: OrderApplicationDto[] = [];
  let loadError: string | null = null;
  try {
    applications = await getOrderApplications(orderId);
  } catch (e) {
    loadError =
      e instanceof ApiRequestError
        ? errorText(e)
        : 'Не удалось загрузить нанесения';
  }

  // Окно правки — весь жизненный цикл, кроме отменённого заказа;
  // единый список статусов живёт в shared рядом с backend-гейтом.
  const editable = isOrderApplicationsEditable(orderStatus);
  // Правка после завершения расчёта: потребность и себестоимость уже
  // зафиксированы, поэтому предупреждаем о правилах до сохранения.
  const lateEdit = isOrderApplicationsLateEdit(orderStatus);

  return (
    <div className="admin-order-item-card__section admin-order-applications">
      <div className="admin-order-item-card__subhead">
        <h3 className="admin-order-item-card__subtitle">
          <Stamp
            size={16}
            strokeWidth={1.7}
            aria-hidden
            style={{ verticalAlign: '-2px', marginRight: 6 }}
          />
          Нанесение
        </h3>
        {applications.length > 0 && (
          <span className="admin-order-item-card__meta">
            Строк: {applications.length}
          </span>
        )}
      </div>

      {loadError && (
        <div className="error-box" role="alert" style={{ marginBottom: 8 }}>
          {loadError}
        </div>
      )}

      {editable && lateEdit && (
        <div className="admin-order-applications__late-note" style={{ marginBottom: 8 }}>
          Расчёт заказа уже завершён. Добавленное нанесение попадёт в
          потребность цеха и себестоимость отдельной строкой; строки,
          которые закупщик уже проверил, останутся как есть. Удалить
          нанесение, по которому пошла закупка, нельзя — снимите строку на
          экране «Потребности».
        </div>
      )}

      {editable ? (
        <OrderApplicationsForm
          orderId={orderId}
          initial={applications}
          availableSizes={sizes}
        />
      ) : (
        <ReadOnlyList applications={applications} />
      )}
    </div>
  );
}

function ReadOnlyList({
  applications,
}: {
  applications: OrderApplicationDto[];
}) {
  if (applications.length === 0) {
    return (
      <AdminEmptyState
        icon={<Stamp size={26} strokeWidth={1.6} aria-hidden />}
        title="Нанесений нет"
        hint="Менеджер не добавил нанесения, пока расчёт заказа не был завершён."
      />
    );
  }

  // Группируем по комплектам (этап «Комплекты нанесений»): нанесения
  // одного комплекта показываем под общим заголовком с одной «Применить
  // к» (она одинаковая у всех участников). Одиночные — как раньше.
  type Block =
    | { kind: 'kit'; key: string; label: string; apps: OrderApplicationDto[] }
    | { kind: 'solo'; app: OrderApplicationDto };
  const blocks: Block[] = [];
  const kitByKey = new Map<string, Extract<Block, { kind: 'kit' }>>();
  for (const app of applications) {
    if (app.groupKey) {
      let b = kitByKey.get(app.groupKey);
      if (!b) {
        b = {
          kind: 'kit',
          key: app.groupKey,
          label: app.groupLabel ?? 'Комплект',
          apps: [],
        };
        kitByKey.set(app.groupKey, b);
        blocks.push(b);
      }
      b.apps.push(app);
    } else {
      blocks.push({ kind: 'solo', app });
    }
  }

  return (
    <div className="admin-order-applications__blocks">
      {blocks.map((block) =>
        block.kind === 'kit' ? (
          <div key={block.key} className="admin-order-applications__kit-ro">
            <div className="admin-order-applications__kit-ro-head">
              <Stamp size={14} strokeWidth={1.7} aria-hidden />
              <strong>{block.label || 'Комплект'}</strong>
              <span className="admin-order-applications__kit-ro-scope">
                {describeApplicationScope(block.apps[0])}
              </span>
            </div>
            <ul className="admin-order-applications__list">
              {block.apps.map((app) => (
                <ApplicationItem key={app.id} app={app} hideScope />
              ))}
            </ul>
          </div>
        ) : (
          <ul key={block.app.id} className="admin-order-applications__list">
            <ApplicationItem app={block.app} />
          </ul>
        ),
      )}
    </div>
  );
}

/**
 * Read-only строка нанесения. Свёрнута по умолчанию: видна шапка (тип +
 * этап + статус + место/размер), детали — под разворотом. Реализовано
 * через `<details>`, чтобы карточка осталась серверной (тот же приём,
 * что в `AdminTechInfo`).
 */
function ApplicationItem({
  app,
  hideScope = false,
}: {
  app: OrderApplicationDto;
  hideScope?: boolean;
}) {
  const brief = [
    app.placement,
    app.widthMm != null && app.heightMm != null
      ? `${app.widthMm}×${app.heightMm} мм`
      : null,
    hideScope ? null : describeApplicationScope(app),
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <li className="admin-order-applications__item">
      <details className="admin-order-applications__item-details">
        <summary className="admin-order-applications__item-head">
          <ChevronDown
            size={15}
            strokeWidth={2}
            aria-hidden
            className="admin-order-applications__chev"
          />
          <strong>{app.typeLabel}</strong>
          <AdminStatusBadge tone="muted">{app.stageLabel}</AdminStatusBadge>
          <AdminStatusBadge tone={statusTone(app.status)}>
            {app.statusLabel}
          </AdminStatusBadge>
          {brief && (
            <span className="admin-order-applications__row-sub">{brief}</span>
          )}
        </summary>
        <dl className="admin-deflist admin-deflist--compact">
          {app.placement && (
            <>
              <dt>Место</dt>
              <dd>{app.placement}</dd>
            </>
          )}
          {(app.widthMm != null || app.heightMm != null) && (
            <>
              <dt>Размер</dt>
              <dd>{(app.widthMm ?? '—') + ' × ' + (app.heightMm ?? '—')} мм</dd>
            </>
          )}
          {app.colorsCount != null && (
            <>
              <dt>Цветов</dt>
              <dd>{app.colorsCount}</dd>
            </>
          )}
          {!hideScope && (
            <>
              <dt>Применить к</dt>
              <dd>{describeApplicationScope(app)}</dd>
            </>
          )}
          {app.colorText && (
            <>
              <dt>Цвет / описание</dt>
              <dd>{app.colorText}</dd>
            </>
          )}
          {app.description && (
            <>
              <dt>Описание</dt>
              <dd>{app.description}</dd>
            </>
          )}
          {app.comment && (
            <>
              <dt>Комментарий</dt>
              <dd>{app.comment}</dd>
            </>
          )}
          {app.fileUrl && (
            <>
              <dt>Файл макета</dt>
              <dd>
                <a href={app.fileUrl} target="_blank" rel="noreferrer">
                  {app.fileUrl}
                </a>
              </dd>
            </>
          )}
        </dl>
      </details>
    </li>
  );
}
