import { Fragment } from 'react';
import Link from 'next/link';
import { ArrowRight, Plus, Scissors } from 'lucide-react';
import { ApiRequestError, errorText } from '@/lib/api';
import { listOperations } from '@/lib/operations-api';
import {
  groupOperationsByCategory,
  type OperationSummaryDto,
} from '@sewing/shared/operations';
import {
  AdminArchiveTabs,
  AdminCard,
  AdminEmptyState,
  AdminPageShell,
  AdminSearchInput,
  AdminSectionHeader,
  AdminStatusBadge,
  AdminTableRow,
  BulkArchiveCheckbox,
  BulkArchiveHeaderButton,
  BulkArchiveProvider,
  BulkArchiveSelectAll,
  BulkArchiveRowActions,
} from '@/components/admin';
import {
  archiveOperationsAction,
  purgeOperationsAction,
  restoreOperationsAction,
} from './archive-actions';
import {
  formatPricingMode,
  formatStatus,
  statusTone,
} from '@/lib/admin-labels';
import { formatDuration } from '@/lib/operations-time-norm';
import {
  calculateOperationDailyEconomics,
  formatEarningsPerDay,
} from '@/lib/operation-economics';

export const dynamic = 'force-dynamic';

function formatRate(op: OperationSummaryDto): React.ReactNode {
  if (op.pricingMode === 'FIXED') {
    return op.fixedRate !== null ? (
      <strong>{op.fixedRate.toFixed(2)} ₽</strong>
    ) : (
      <AdminStatusBadge tone="warning">Не задано</AdminStatusBadge>
    );
  }
  if (op.pricingMode === 'BY_SIZE') {
    return op.ratesBySizeCount > 0 ? (
      <span>
        ставок: <strong>{op.ratesBySizeCount}</strong>
      </span>
    ) : (
      <AdminStatusBadge tone="warning">Не задано</AdminStatusBadge>
    );
  }
  return <span className="admin-muted">—</span>;
}

/**
 * Компактный бейдж «8ч: …» в списке операций — плановый заработок за
 * 8-часовую смену по текущим ставке/норме времени (см.
 * `lib/operation-economics.ts`). Это **только справочный расчёт** для
 * управленческого экрана; payroll/SalaryEntry/OperationEntry он не
 * подменяет. Подробный расчёт — на карточке операции.
 *
 * Что показываем:
 *   - `pricingMode = FIXED`, `timeNormMode = FIXED` ⇒ «8ч: 5 184 ₽»;
 *   - `BY_SIZE` хотя бы по одной из осей ⇒ «8ч: по размерам» (без
 *     детализации, чтобы не раздувать строку — диапазоны считаются
 *     не на summary-DTO, а только на detail-странице);
 *   - `SALARY_ONLY` ⇒ «8ч: оклад» (нет сдельной ставки);
 *   - данных нет / нет ставки / нет нормы ⇒ «8ч: —».
 */
function formatDailyEarnings(op: OperationSummaryDto): React.ReactNode {
  if (op.pricingMode === 'SALARY_ONLY') {
    return <span className="admin-muted">8ч: оклад</span>;
  }
  if (op.pricingMode === 'BY_SIZE' || op.timeNormMode === 'BY_SIZE') {
    return <span className="admin-muted">8ч: по размерам</span>;
  }
  const econ = calculateOperationDailyEconomics({
    rateRub: op.fixedRate,
    timeNormSec: op.timeNormSec,
  });
  if (econ.earningsPerDayRub === null) {
    return <span className="admin-muted">8ч: —</span>;
  }
  return (
    <span>
      8ч: <strong>{formatEarningsPerDay(econ.earningsPerDayRub)}</strong>
    </span>
  );
}

/**
 * Колонка «Норма времени» в `/admin/operations`. Это **отдельная ось**
 * от тарифа (рублёвых ставок). Для FIXED показываем `formatDuration`,
 * для BY_SIZE — счётчик строк по размерам, иначе «Не задана».
 */
function formatTimeNorm(op: OperationSummaryDto): React.ReactNode {
  if (op.timeNormMode === 'FIXED') {
    return op.timeNormSec !== null && op.timeNormSec > 0 ? (
      <strong>{formatDuration(op.timeNormSec)}</strong>
    ) : (
      <AdminStatusBadge tone="muted">Не задана</AdminStatusBadge>
    );
  }
  if (op.timeNormMode === 'BY_SIZE') {
    return op.timeNormsBySizeCount > 0 ? (
      <span>
        размеров: <strong>{op.timeNormsBySizeCount}</strong>
      </span>
    ) : (
      <AdminStatusBadge tone="muted">Не задана</AdminStatusBadge>
    );
  }
  return <span className="admin-muted">—</span>;
}

/**
 * Список операций (Admin UI Polish + ТЗ «Compact grouped table»).
 *
 * Источник истины — `GET /api/operations` (роли `ADMIN`/`SHOP_MANAGER`).
 * Доступ — `app/admin/layout.tsx`. Backend параллельно защищает
 * `/api/operations/*` через `@Roles('SHOP_MANAGER', 'ADMIN')`.
 *
 * Группировка по категориям (ТЗ «Единая группировка»):
 *   - операции делятся на секции в порядке `OPERATION_CATEGORY_ORDER`
 *     (Раскрой → Пошив → ОТК → ВТО → Упаковка), пустые группы скрыты;
 *   - неизвестная/`null` категория уходит в «Без категории» в конце;
 *   - внутри секции порядок — `sortOrder`, затем `name`.
 *
 * Compact layout (ТЗ «compact grouped-table layout»):
 *   - один table header на весь список;
 *   - категории внутри одного tbody как тонкие group-row
 *     разделители (`.admin-compact-group-row`);
 *   - старая «карточка-секция на каждую категорию» сознательно убрана,
 *     чтобы не плодить отдельный header на каждую группу — это
 *     создавало лишний вертикальный воздух (см. ТЗ §1).
 *
 * Каркас страницы — стандартный каркас админского списка (эталон —
 * `/admin/routes`): ОДНА `AdminCard`, внутри неё по порядку вкладки
 * архива, поиск, `AdminSectionHeader` («Активные · Всего: N») и уже
 * потом таблица в рамке `.admin-table-wrap`. Раньше таблица жила в
 * отдельной `.admin-compact-grouped-card` с padding: 0, из-за чего
 * заголовок секции превращался в полосу с border-bottom во всю
 * ширину карточки и выбивался из остальных списков админки.
 *
 * Пагинация отключена сознательно: на одной экранной форме менеджеру
 * удобнее видеть весь каталог сгруппированным, чем перелистывать.
 */
export default async function AdminOperationsListPage({
  searchParams,
}: {
  searchParams?: { tab?: string; search?: string };
}) {
  // Этап «Архив справочников»: вкладка «Архив» показывает операции с
  // `isActive = false` (тот же флаг, что тумблер «Активна» на карточке).
  const tab: 'active' | 'archive' =
    searchParams?.tab === 'archive' ? 'archive' : 'active';
  const search = searchParams?.search?.trim() || undefined;

  let all: OperationSummaryDto[] = [];
  let error: string | null = null;
  try {
    // Поиск — на бэке (по коду и названию); группировка по категориям
    // и вкладки active/archive считаются поверх отфильтрованного набора.
    all = await listOperations(search);
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? errorText(e)
        : 'Не удалось загрузить список операций';
  }

  const activeItems = all.filter((op) => op.isActive);
  const archivedItems = all.filter((op) => !op.isActive);
  const items = tab === 'archive' ? archivedItems : activeItems;

  const sortedItems = [...items].sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.name.localeCompare(b.name, 'ru');
  });
  const groups = groupOperationsByCategory(sortedItems);

  return (
    <AdminPageShell
      icon={<Scissors size={22} strokeWidth={1.6} aria-hidden />}
      title="Операции"
      subtitle={`Активных: ${activeItems.length} · Архив: ${archivedItems.length}`}
      actions={
        <Link
          href="/admin/operations/new"
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

      <AdminCard>
        <AdminArchiveTabs
          basePath="/admin/operations"
          tab={tab}
          activeCount={activeItems.length}
          archiveCount={archivedItems.length}
        />

        <form method="get" className="admin-form-grid" role="search">
          {tab === 'archive' && (
            <input type="hidden" name="tab" value="archive" />
          )}
          <AdminSearchInput
            id="operations-search"
            placeholder="Код или название операции"
            initial={search ?? ''}
            basePath="/admin/operations"
            resetParams={{}}
            preserveParams={{ tab: tab === 'archive' ? 'archive' : undefined }}
          />
        </form>

        <BulkArchiveProvider
          mode={tab}
          allIds={items.map((op) => op.id)}
          actions={{
            archive: archiveOperationsAction,
            restore: restoreOperationsAction,
            purge: purgeOperationsAction,
          }}
          labels={{
            one: 'операцию',
            many: 'операций',
            archiveHint:
              'Операции пропадут из рабочих списков и подбора в маршрутах. История, ставки и нормы сохранятся.',
            purgeHint:
              'Вместе с операцией пропадут её ставки, нормы времени и привязка к станкам. Операции с историей или в маршрутах будут пропущены.',
          }}
        >
          <AdminSectionHeader
            title={tab === 'archive' ? 'Архив' : 'Активные'}
            hint={
              tab === 'archive'
                ? `В архиве: ${items.length}. Удаление навсегда — только отсюда.`
                : `Всего: ${items.length}`
            }
            actions={<BulkArchiveHeaderButton />}
          />

          {groups.length === 0 ? (
            search ? (
              <AdminEmptyState
                icon={<Scissors size={26} strokeWidth={1.6} aria-hidden />}
                title="Данные не найдены"
                hint="По заданному поиску операций нет. Измените запрос или очистите поиск."
              />
            ) : tab === 'archive' ? (
              <AdminEmptyState
                icon={<Scissors size={26} strokeWidth={1.6} aria-hidden />}
                title="Архив пуст"
                hint="Сюда попадают операции, отправленные в архив. Из архива их можно вернуть или удалить навсегда."
              />
            ) : (
              <AdminEmptyState
                icon={<Scissors size={26} strokeWidth={1.6} aria-hidden />}
                title="Операций пока нет"
                actions={
                  <Link
                    href="/admin/operations/new"
                    className="admin-btn admin-btn--primary"
                  >
                    <Plus size={16} strokeWidth={1.6} aria-hidden />
                    Добавить операцию
                  </Link>
                }
              />
            )
          ) : (
            <div className="admin-table-wrap admin-compact-table-wrap">
              <table className="admin-table admin-compact-grouped-table admin-operations-compact-table">
                <thead>
                  <tr>
                    <th>
                      <BulkArchiveSelectAll ids={sortedItems.map((op) => op.id)} />
                    </th>
                    <th>Название</th>
                    <th>Тариф</th>
                    <th>Ставка</th>
                    <th>Норма времени</th>
                    <th>За 8 часов</th>
                    <th>Статус</th>
                    <th aria-label="Архив" />
                    <th aria-label="Действия" />
                  </tr>
                </thead>
                <tbody>
                  {groups.map((group) => (
                    <Fragment key={group.category}>
                      <tr
                        className="admin-compact-group-row admin-operations-group-row"
                        data-category={group.category}
                      >
                        <td colSpan={9}>
                          <div className="admin-compact-group-row__inner">
                            <span data-category-title={group.category}>
                              {group.label}
                            </span>
                            <span className="admin-compact-group-row__count">
                              {group.operations.length}
                            </span>
                          </div>
                        </td>
                      </tr>
                      {group.operations.map((op) => (
                        /*
                          Кликабельная строка (drill-in): весь ряд ведёт туда же,
                          куда ссылка «Открыть» справа — на карточку операции.
                          Клики по чекбоксу bulk-архива, кнопкам и самой ссылке
                          не перехватываются (см. `AdminTableRow`).
                        */
                        <AdminTableRow
                          key={op.id}
                          href={`/admin/operations/${op.id}`}
                          className="admin-compact-row admin-operations-row admin-table__row--clickable"
                        >
                          <td>
                            <BulkArchiveCheckbox id={op.id} />
                          </td>
                          <td data-label="Название">
                            <span className="admin-table__primary">{op.name}</span>
                            {op.producesFinishedGoods && (
                              <>
                                {' '}
                                {/*
                                  Признак «операция выпускает готовую продукцию»
                                  (см.
                                  `prisma/schema.prisma::Operation.producesFinishedGoods`,
                                  `apps/api/src/modules/finished-goods/finished-goods.service.ts::recordPassportOutputInTx`).
                                  Маленький badge даёт менеджеру быструю
                                  ориентацию, какая операция фиксирует выпуск.
                                */}
                                <AdminStatusBadge tone="info">
                                  Выпуск ГП
                                </AdminStatusBadge>
                              </>
                            )}
                            {op.boxPacking && (
                              <>
                                {' '}
                                {/*
                                  Признак «коробочная упаковка» (см.
                                  `prisma/schema.prisma::Operation.boxPacking`,
                                  `apps/api/src/modules/packing/packing.service.ts::assertPackingActor`).
                                  Отдельный badge рядом с «Выпуск ГП»: оси
                                  независимы, и менеджеру важно видеть, на
                                  какой именно операции категории `PACKING`
                                  у упаковщика откроется окно коробок —
                                  «Распаковка» (приёмка сырья) остаётся без
                                  бейджа и идёт обычным passport-flow.
                                */}
                                <AdminStatusBadge tone="info">
                                  Коробки
                                </AdminStatusBadge>
                              </>
                            )}
                          </td>
                          <td data-label="Тариф">{formatPricingMode(op.pricingMode)}</td>
                          <td data-label="Ставка">{formatRate(op)}</td>
                          <td data-label="Норма времени">{formatTimeNorm(op)}</td>
                          <td data-label="За 8 часов">{formatDailyEarnings(op)}</td>
                          <td data-label="Статус">
                            <AdminStatusBadge tone={statusTone(op.isActive)}>
                              {formatStatus(op.isActive)}
                            </AdminStatusBadge>
                          </td>
                          <td className="admin-table__actions admin-compact-row__actions">
                            <BulkArchiveRowActions id={op.id} />
                          </td>
                          <td className="admin-table__actions admin-compact-row__actions">
                            <Link
                              href={`/admin/operations/${op.id}`}
                              className="admin-table__action-link"
                            >
                              Открыть
                              <ArrowRight size={14} strokeWidth={1.6} aria-hidden />
                            </Link>
                          </td>
                        </AdminTableRow>
                      ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </BulkArchiveProvider>
      </AdminCard>
    </AdminPageShell>
  );
}
