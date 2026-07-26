import Link from 'next/link';
import { ArrowRight, Pencil, Plus, Scissors } from 'lucide-react';
import {
  PATTERN_ITEM_STATUS_LABELS,
  type PatternItemStatus,
  type PatternListItemDto,
} from '@sewing/shared/patterns';
import type { PatternCategoryListItemDto } from '@sewing/shared/pattern-categories';
import { ApiRequestError, errorText } from '@/lib/api';
import { listPatterns } from '@/lib/patterns-api';
import { listPatternCategories } from '@/lib/pattern-categories-api';
import { resolvePatternCategoryIcon } from '@/lib/pattern-category-icon';
import {
  AdminCard,
  AdminEmptyState,
  AdminPageShell,
  AdminPagination,
  AdminSearchInput,
  AdminSectionHeader,
  AdminStatusBadge,
  AdminTable,
  paginate,
  type AdminTableColumn,
} from '@/components/admin';
import { statusTone } from '@/lib/admin-labels';
import { DeleteCategoryChipButton } from './delete-category-chip-button';
import {
  PatternArchiveCheckbox,
  PatternArchiveHeaderButton,
  PatternArchiveProvider,
  PatternArchiveRowActions,
} from './pattern-archive';

export const dynamic = 'force-dynamic';

interface SearchParams {
  page?: string;
  pageSize?: string;
  search?: string;
  status?: string;
  categoryId?: string;
  tab?: string;
}

function formatStatusLabel(status: string): string {
  const known = (PATTERN_ITEM_STATUS_LABELS as Record<string, string>)[status];
  return known ?? status;
}

/**
 * Список лекал (Patterns MVP-1, изолированный модуль) + фильтр по
 * категориям номенклатуры.
 *
 * Backend `GET /api/patterns` возвращает все статусы, фильтры на
 * сервере (`search`, `categoryId`). Пагинация — клиентская
 * через `paginate()`, как в `/admin/tech-cards` / `/admin/clients`.
 *
 * Этап «Архив номенклатуры» (по аналогии с архивом расчётов цеха):
 * список разложен по двум вкладкам — «Номенклатура» (ACTIVE/DRAFT) и
 * «Архив» (ARCHIVED). Поэтому статус НЕ передаём в backend-фильтр, а
 * фетчим одну выдачу и режем локально: так у обеих вкладок есть
 * счётчики за один round-trip (тот же приём, что в `/admin/suppliers`).
 * Селект «Статус» остаётся только на активной вкладке и сужает
 * ACTIVE/DRAFT; выбор `status=ARCHIVED` из старой ссылки/закладки
 * трактуем как переход на вкладку «Архив».
 */
export default async function AdminPatternsListPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const search = searchParams?.search?.trim();
  const statusParam = (searchParams?.status?.trim() || undefined) as
    | PatternItemStatus
    | undefined;
  const categoryId = searchParams?.categoryId?.trim() || undefined;
  const tab: 'active' | 'archive' =
    searchParams?.tab === 'archive' || statusParam === 'ARCHIVED'
      ? 'archive'
      : 'active';
  // На вкладке «Архив» селекта статуса нет — фильтр не применяем.
  const status = tab === 'archive' ? undefined : statusParam;
  /** `tab` для ссылок/форм: на активной вкладке параметр не нужен. */
  const tabParam = tab === 'archive' ? 'archive' : undefined;

  let allItems: PatternListItemDto[] = [];
  let categories: PatternCategoryListItemDto[] = [];
  let archivedCategories: PatternCategoryListItemDto[] = [];
  let error: string | null = null;
  try {
    allItems = await listPatterns({
      search: search || undefined,
      categoryId,
    });
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? errorText(e)
        : 'Не удалось загрузить список лекал';
  }
  try {
    // Активные категории — основной фильтр; архивные грузим отдельно,
    // чтобы их можно было удалить навсегда или вернуть прямо из списка
    // (иначе архивная категория становится недостижимой — отдельной
    // страницы-списка категорий нет).
    [categories, archivedCategories] = await Promise.all([
      listPatternCategories({ status: 'ACTIVE' }),
      listPatternCategories({ status: 'ARCHIVED' }),
    ]);
  } catch {
    // graceful — категории фильтра не блокируют страницу.
    categories = [];
    archivedCategories = [];
  }

  const archivedItems = allItems.filter((p) => p.status === 'ARCHIVED');
  const activeItems = allItems.filter((p) => p.status !== 'ARCHIVED');
  const items =
    tab === 'archive'
      ? archivedItems
      : status
        ? activeItems.filter((p) => p.status === status)
        : activeItems;

  const { pageItems, page, pageSize, total } = paginate(items, searchParams);

  const columns: AdminTableColumn<PatternListItemDto>[] = [
    {
      // Чекбокс массовых операций архива. `sortable: false` — сортировать
      // по нему нечего (`AdminTableView` читает textContent ячейки).
      key: 'select',
      header: '',
      sortable: false,
      render: (p) => <PatternArchiveCheckbox patternId={p.id} />,
    },
    {
      key: 'preview',
      header: '',
      render: (p) => <PatternPreviewThumb pattern={p} />,
    },
    {
      key: 'name',
      header: 'Название',
      render: (p) => (
        <div>
          <span className="admin-table__primary">{p.name}</span>
          <div className="admin-muted" style={{ fontSize: '0.85rem' }}>
            Артикул: {p.article}
          </div>
        </div>
      ),
    },
    {
      key: 'category',
      header: 'Категория',
      render: (p) => {
        if (p.categoryName) {
          return (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 10,
              }}
            >
              <CategoryChipIcon
                iconImageUrl={p.categoryIconImageUrl}
                iconKey={p.categoryIconKey}
                alt={p.categoryName}
                variant="row"
              />
              {p.categoryName}
            </span>
          );
        }
        if (p.categoryCode) {
          return (
            <span title="Старая текстовая категория (legacy)">
              {p.categoryCode}
            </span>
          );
        }
        return <span className="admin-muted">—</span>;
      },
    },
    {
      key: 'sizeFiles',
      header: 'Файлы',
      align: 'right',
      render: (p) => p.sizeFilesCount,
    },
    {
      key: 'materialAreas',
      header: 'Площадей',
      align: 'right',
      render: (p) => p.materialAreasCount,
    },
    {
      key: 'sizes',
      header: 'Размеры',
      render: (p) =>
        p.sizes.length === 0 ? (
          <span className="admin-muted">—</span>
        ) : (
          <span style={{ fontSize: '0.85rem' }}>
            {p.sizes.map((s) => s.code).join(', ')}
          </span>
        ),
    },
    {
      key: 'updatedAt',
      header: 'Обновлено',
      render: (p) => (
        <span className="admin-muted" style={{ fontSize: '0.85rem' }}>
          {new Date(p.updatedAt).toLocaleString('ru-RU')}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Статус',
      render: (p) => (
        <AdminStatusBadge tone={statusTone(p.status)}>
          {formatStatusLabel(p.status)}
        </AdminStatusBadge>
      ),
    },
    {
      // Архив: «В архив» на активной вкладке, «Вернуть» / «Удалить» — в
      // архиве. Кнопки клиентские, поэтому клик не уводит по `rowHref`.
      key: 'archive',
      header: '',
      isAction: true,
      render: (p) => <PatternArchiveRowActions patternId={p.id} />,
    },
    {
      key: 'open',
      header: '',
      isAction: true,
      render: (p) => (
        <Link
          href={`/admin/patterns/${p.id}`}
          className="admin-table__action-link"
        >
          Открыть
          <ArrowRight size={14} strokeWidth={1.6} aria-hidden />
        </Link>
      ),
    },
  ];

  return (
    <AdminPageShell
      icon={<Scissors size={22} strokeWidth={1.6} aria-hidden />}
      title="Номенклатура"
      subtitle={`Активных: ${activeItems.length} · Архив: ${archivedItems.length}`}
      actions={
        <>
          {/* Этап «Загружаемая JPEG-иконка категории»: модалка
              создания категории удалена; кнопка ведёт на отдельную
              страницу /admin/pattern-categories/new (см.
              `apps/web/app/admin/pattern-categories/new/page.tsx`). */}
          <Link
            href="/admin/pattern-categories/new"
            className="admin-btn admin-btn--ghost"
          >
            <Plus size={16} strokeWidth={1.6} aria-hidden />
            Добавить категорию
          </Link>
          <Link
            href="/admin/patterns/new"
            className="admin-btn admin-btn--primary"
          >
            <Plus size={16} strokeWidth={1.6} aria-hidden />
            Создать номенклатуру
          </Link>
        </>
      }
    >
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      {/* ------------------------------------------------------ */}
      {/* Фильтр категорий (этап «Категории номенклатуры»)        */}
      {/* ------------------------------------------------------ */}
      <AdminCard>
        <div
          className="admin-muted"
          style={{ fontSize: '0.85rem', marginBottom: 10 }}
        >
          Фильтр по группе номенклатуры. Наведите на категорию, чтобы её
          отредактировать (карандаш) или удалить (корзина).
        </div>
        <div
          aria-label="Фильтр по категориям"
          style={{
            display: 'flex',
            gap: 8,
            flexWrap: 'wrap',
            alignItems: 'center',
          }}
        >
          <CategoryFilterChip
            href={buildHref('/admin/patterns', {
              search: search || undefined,
              status: status || undefined,
              tab: tabParam,
            })}
            active={!categoryId}
            ariaLabel="Фильтр: все категории"
          >
            Все
          </CategoryFilterChip>
          {categories.map((c) => (
            <CategoryFilterChip
              key={c.id}
              href={buildHref('/admin/patterns', {
                search: search || undefined,
                status: status || undefined,
                tab: tabParam,
                categoryId: c.id,
              })}
              active={categoryId === c.id}
              ariaLabel={`Фильтр: ${c.name}`}
              editHref={`/admin/pattern-categories/${c.id}`}
              editAriaLabel={`Редактировать категорию: ${c.name}`}
              deleteCategoryId={c.id}
              deleteCategoryName={c.name}
            >
              <CategoryChipIcon
                iconImageUrl={c.iconImageUrl}
                iconKey={c.iconKey}
                alt={c.name}
                variant="row"
              />
              <span className="pattern-category-filter__label">{c.name}</span>
            </CategoryFilterChip>
          ))}
          {categories.length === 0 && (
            <span className="admin-muted" style={{ fontSize: '0.85rem' }}>
              Категории ещё не заведены — нажмите «Добавить категорию», чтобы
              задать набор параметров для новой номенклатуры.
            </span>
          )}
        </div>

        {/* Архивные категории: показываем отдельным приглушённым рядом,
            чтобы их можно было удалить навсегда или вернуть в работу
            (иначе после архивации категория становилась недостижимой). */}
        {archivedCategories.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div
              className="admin-muted"
              style={{ fontSize: '0.8rem', marginBottom: 8 }}
            >
              В архиве
            </div>
            <div
              aria-label="Архивные категории"
              style={{
                display: 'flex',
                gap: 8,
                flexWrap: 'wrap',
                alignItems: 'center',
              }}
            >
              {archivedCategories.map((c) => (
                <CategoryFilterChip
                  key={c.id}
                  href={buildHref('/admin/patterns', {
                    search: search || undefined,
                    status: status || undefined,
                    tab: tabParam,
                    categoryId: c.id,
                  })}
                  active={categoryId === c.id}
                  archived
                  ariaLabel={`Фильтр: ${c.name} (в архиве)`}
                  editHref={`/admin/pattern-categories/${c.id}`}
                  editAriaLabel={`Открыть категорию: ${c.name}`}
                  deleteCategoryId={c.id}
                  deleteCategoryName={c.name}
                >
                  <CategoryChipIcon
                    iconImageUrl={c.iconImageUrl}
                    iconKey={c.iconKey}
                    alt={c.name}
                    variant="row"
                  />
                  <span className="pattern-category-filter__label">
                    {c.name}
                  </span>
                </CategoryFilterChip>
              ))}
            </div>
          </div>
        )}
      </AdminCard>

      <AdminCard>
        {/* Этап «Архив номенклатуры»: вкладки «Номенклатура» / «Архив». */}
        <div className="admin-tabs">
          <Link
            href={buildHref('/admin/patterns', {
              search: search || undefined,
              status: status || undefined,
              categoryId: categoryId || undefined,
            })}
            className={`admin-tab ${tab === 'active' ? 'admin-tab--active' : ''}`}
            aria-current={tab === 'active' ? 'page' : undefined}
          >
            Номенклатура ({activeItems.length})
          </Link>
          <Link
            href={buildHref('/admin/patterns', {
              search: search || undefined,
              categoryId: categoryId || undefined,
              tab: 'archive',
            })}
            className={`admin-tab ${tab === 'archive' ? 'admin-tab--active' : ''}`}
            aria-current={tab === 'archive' ? 'page' : undefined}
          >
            Архив ({archivedItems.length})
          </Link>
        </div>

        <form
          action="/admin/patterns"
          method="get"
          className="admin-form-grid"
        >
          {categoryId && (
            <input type="hidden" name="categoryId" value={categoryId} />
          )}
          {tab === 'archive' && <input type="hidden" name="tab" value="archive" />}
          <AdminSearchInput
            id="patternSearch"
            placeholder="Название / артикул / категория"
            initial={search ?? ''}
            basePath="/admin/patterns"
            preserveParams={{ status, categoryId, tab: tabParam }}
          />
          {/* Селект статуса — только на активной вкладке: в архиве статус
              заведомо один (`ARCHIVED`), фильтровать нечего. */}
          {tab === 'active' && (
            <div className="admin-field">
              <label htmlFor="patternStatus">Статус</label>
              <select
                id="patternStatus"
                name="status"
                defaultValue={status ?? ''}
              >
                <option value="">Все</option>
                {Object.entries(PATTERN_ITEM_STATUS_LABELS)
                  // `ARCHIVED` живёт во вкладке «Архив» — из селекта убран,
                  // чтобы не было двух путей к одному и тому же списку.
                  .filter(([code]) => code !== 'ARCHIVED')
                  .map(([code, label]) => (
                    <option key={code} value={code}>
                      {label}
                    </option>
                  ))}
              </select>
            </div>
          )}
          <div className="admin-actions-row" style={{ alignItems: 'end' }}>
            <button type="submit" className="admin-btn">
              Применить
            </button>
            {(search || status || categoryId) && (
              <Link
                href={
                  tab === 'archive'
                    ? '/admin/patterns?tab=archive'
                    : '/admin/patterns'
                }
                className="admin-btn admin-btn--ghost"
              >
                Сбросить
              </Link>
            )}
          </div>
        </form>

        {/* Провайдер архива оборачивает шапку (кнопка «Очистить архив»),
            таблицу (чекбоксы + кнопки в строках) и нижний тулбар выбора. */}
        {/* «Очистить архив» бьёт по ВСЕЙ текущей выдаче вкладки (все
            страницы клиентской пагинации), а не только по видимой
            странице — количество показываем в confirm перед операцией. */}
        <PatternArchiveProvider
          mode={tab}
          allPatternIds={items.map((p) => p.id)}
        >
          <AdminSectionHeader
            title={tab === 'archive' ? 'Архив' : 'Номенклатура'}
            hint={
              tab === 'archive'
                ? `В архиве: ${items.length}. Удаление навсегда — только отсюда.`
                : `Всего: ${items.length}`
            }
            actions={<PatternArchiveHeaderButton />}
          />

          <AdminTable
            rows={pageItems}
            columns={columns}
            rowKey={(p) => p.id}
            rowHref={(p) => `/admin/patterns/${p.id}`}
            emptyContent={
              tab === 'archive' ? (
                <AdminEmptyState
                  icon={<Scissors size={26} strokeWidth={1.6} aria-hidden />}
                  title="Архив пуст"
                  hint="Сюда попадает номенклатура, отправленная в архив кнопкой «В архив». Из архива её можно вернуть или удалить навсегда."
                />
              ) : (
                <AdminEmptyState
                  icon={<Scissors size={26} strokeWidth={1.6} aria-hidden />}
                  title="Лекала ещё не заведены"
                  hint="Создайте первое лекало — например, «Футболка-классика»."
                  actions={
                    <Link
                      href="/admin/patterns/new"
                      className="admin-btn admin-btn--primary"
                    >
                      <Plus size={16} strokeWidth={1.6} aria-hidden />
                      Создать номенклатуру
                    </Link>
                  }
                />
              )
            }
          />
        </PatternArchiveProvider>

        <AdminPagination
          page={page}
          pageSize={pageSize}
          total={total}
          basePath="/admin/patterns"
          preserveParams={{
            search: search || undefined,
            status: status || undefined,
            categoryId: categoryId || undefined,
            tab: tabParam,
          }}
          label="лекал"
        />
      </AdminCard>
    </AdminPageShell>
  );
}

function buildHref(
  basePath: string,
  params: Record<string, string | undefined>,
): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') sp.set(k, v);
  }
  const qs = sp.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

/**
 * Чип-фильтр категории. Подписан названием категории (этап «Подписать
 * группы номенклатуры»): внутри `children` — иконка + текстовый label.
 *
 * Если заданы `editHref` / `deleteCategoryId`, чип становится
 * wrapper-ом, где рядом с основной фильтр-ссылкой лежит кластер
 * действий (`pattern-category-filter__actions`):
 *   - `Pencil` (`<Link>`) ведёт на страницу редактирования категории;
 *   - `DeleteCategoryChipButton` (client) удаляет категорию «в один
 *     клик» через server-action.
 *
 * Кластер скрыт по умолчанию (`opacity: 0`) и появляется на hover
 * родителя или focus-within (см. CSS в `globals.css`). Сознательно НЕ
 * вкладываем эти контролы в основной `<Link>` — у HTML нельзя вкладывать
 * интерактив в `<a>` (валидно только sibling-схема).
 *
 * Кнопка «Все категории» вызывается без `editHref` → возвращается к
 * простому одиночному Link-варианту, чтобы не плодить пустую обёртку.
 */
function CategoryFilterChip({
  href,
  active,
  children,
  archived,
  ariaLabel,
  editHref,
  editAriaLabel,
  deleteCategoryId,
  deleteCategoryName,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
  archived?: boolean;
  ariaLabel?: string;
  editHref?: string;
  editAriaLabel?: string;
  deleteCategoryId?: string;
  deleteCategoryName?: string;
}) {
  const filterLink = (
    <Link
      href={href}
      className={
        (active
          ? 'admin-btn admin-btn--primary'
          : 'admin-btn admin-btn--ghost') +
        (archived ? ' pattern-category-filter__link--archived' : '')
      }
      aria-current={active ? 'page' : undefined}
      aria-label={ariaLabel}
      style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}
    >
      {children}
    </Link>
  );

  if (!editHref && !deleteCategoryId) {
    return filterLink;
  }

  return (
    <span className="pattern-category-filter">
      {filterLink}
      <span className="pattern-category-filter__actions">
        {editHref && (
          <Link
            href={editHref}
            className="pattern-category-filter__act"
            aria-label={editAriaLabel}
            title={editAriaLabel}
          >
            <Pencil size={12} strokeWidth={1.7} aria-hidden />
          </Link>
        )}
        {deleteCategoryId && deleteCategoryName && (
          <DeleteCategoryChipButton
            categoryId={deleteCategoryId}
            categoryName={deleteCategoryName}
          />
        )}
      </span>
    </span>
  );
}

/**
 * Иконка категории для chip-фильтра / таблицы. Этап «Загружаемая
 * иконка категории JPG/PNG»: основной источник — `iconImageUrl` (JPG
 * или PNG, загруженный менеджером); если пуст — fallback на legacy
 * lucide-`iconKey` (whitelist `PATTERN_CATEGORY_ICON_KEYS`).
 *
 * Размер задаётся вариантом и реализован CSS-классами
 * `.pattern-category-icon` / `--filter` / `--detail` (см.
 * `apps/web/app/globals.css`):
 *   - `filter` — chip-фильтр сверху страницы (плитка 80×80,
 *     текст категории убран — название вынесено в `title` / `aria-label`
 *     родительской ссылки `CategoryFilterChip`);
 *   - `row`    — строка таблицы / списка номенклатуры (32×32).
 *
 * Сознательно не используем `next/image`: иконки лежат на API origin
 * (`/uploads/...`), он не входит в `images.domains`. Native `<img>` —
 * простой и предсказуемый, как и для preview лекал на этой же странице.
 */
function CategoryChipIcon({
  iconImageUrl,
  iconKey,
  alt,
  variant = 'row',
}: {
  iconImageUrl: string | null | undefined;
  iconKey: string | null | undefined;
  alt: string;
  variant?: 'filter' | 'row';
}) {
  const className =
    variant === 'filter'
      ? 'pattern-category-icon pattern-category-icon--filter'
      : 'pattern-category-icon';
  if (iconImageUrl) {
    return (
      <span className={className} aria-hidden={false}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={iconImageUrl} alt={alt} />
      </span>
    );
  }
  const Icon = resolvePatternCategoryIcon(iconKey);
  return (
    <span className={className} aria-hidden>
      <Icon strokeWidth={1.6} />
    </span>
  );
}

/**
 * Маленький preview-чип. Если `previewImageUrl` задан, рисуем
 * картинку 56×56; иначе — простой placeholder с иконкой ножниц
 * (UI-плейсхолдер из требований ТЗ).
 */
function PatternPreviewThumb({
  pattern,
}: {
  pattern: PatternListItemDto;
}) {
  if (pattern.previewImageUrl) {
    // `next/image` требует known domains для оптимизации, поэтому
    // используем native `<img>` — превью лекала не критично к
    // bundle-size и берётся с того же origin (api → /uploads).
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={pattern.previewImageUrl}
        alt=""
        width={56}
        height={56}
        style={{
          width: 56,
          height: 56,
          objectFit: 'cover',
          borderRadius: 6,
          border: '1px solid var(--admin-border-soft, #e2e8f0)',
        }}
      />
    );
  }
  return (
    <div
      aria-hidden
      style={{
        width: 56,
        height: 56,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 6,
        background: 'var(--admin-surface-muted, #f1f5f9)',
        border: '1px dashed var(--admin-border-soft, #e2e8f0)',
        color: 'var(--admin-text-muted, #64748b)',
      }}
    >
      <Scissors size={20} strokeWidth={1.6} />
    </div>
  );
}
