import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowLeft,
  ArrowRight,
  ClipboardList,
  Package,
  Ruler,
  Scissors,
} from 'lucide-react';
import {
  CONSTRUCTOR_TASK_STATUS_LABELS,
  CONSTRUCTOR_TASK_STATUS_TONE,
} from '@sewing/shared/constructor-tasks';
import {
  PATTERN_ITEM_STATUS_LABELS,
  type PatternDetailDto,
  type PatternSizeFileDto,
  type PatternSizeRefDto,
} from '@sewing/shared/patterns';
import type {
  PatternCategoryListItemDto,
} from '@sewing/shared/pattern-categories';
import type { SizeDto } from '@sewing/shared/orders';
import { ApiRequestError } from '@/lib/api';
import { getPattern } from '@/lib/patterns-api';
import { listPatternCategories } from '@/lib/pattern-categories-api';
import { resolvePatternCategoryIcon } from '@/lib/pattern-category-icon';
import { listSizes } from '@/lib/orders-api';
import {
  AdminCard,
  AdminPageShell,
  AdminSectionHeader,
  AdminStatusBadge,
  AdminTechInfo,
} from '@/components/admin';
import { statusTone } from '@/lib/admin-labels';
import { ClonePatternModalHost } from './clone-modal-host';
import { EditPatternForm } from './edit-form';
import { ArchivePatternButton } from './archive-pattern-button';
import { DeletePatternButton } from './delete-pattern-button';
import { PatternPreviewUploadForm } from './preview-upload-form';
import { PatternSizesManager } from './pattern-sizes-manager';
import { PatternItemParameterNormsForm } from './parameter-norms-form';
import { PatternItemSizeParameterValuesForm } from './size-parameter-values-form';

export const dynamic = 'force-dynamic';

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('ru-RU');
}

function formatStatusLabel(status: string): string {
  const known = (PATTERN_ITEM_STATUS_LABELS as Record<string, string>)[status];
  return known ?? status;
}

/**
 * Карточка лекала (`/admin/patterns/[id]`).
 *
 * Структура (стандартный admin detail-page):
 *   - `AdminPageShell` с названием/артикулом и статус-бейджем;
 *   - две колонки: левая — превью + основное + редактирование +
 *     `PatternSizesManager` (Размеры номенклатуры → DXF по размерам →
 *     Площади материалов); правая — техническая информация.
 *
 * Размеры справочника подгружаются из `GET /api/sizes` (существующий
 * read-only endpoint в `CatalogModule`); никаких новых endpoint-ов
 * для лекал не вводим. На странице `sizes` нужны **только** для
 * select модалки «Добавить размер» (отфильтруем уже добавленные на
 * клиенте). Активные же размеры считаются прямо из `pattern.sizeFiles`
 * внутри менеджера — отдельной модели `PatternSize` нет (см.
 * `pattern-sizes-manager.tsx`).
 */
export default async function AdminPatternDetailPage({
  params,
}: {
  params: { id: string };
}) {
  let pattern: PatternDetailDto;
  try {
    pattern = await getPattern(params.id);
  } catch (e) {
    if (e instanceof ApiRequestError && e.statusCode === 404) {
      notFound();
    }
    throw e;
  }

  // Размеры для select модалки. Если /sizes отвалится, не валим
  // карточку — менеджер увидит «Все размеры уже добавлены», но
  // активные размеры по-прежнему отрисуются (они считаются из
  // `pattern.sizeFiles`).
  let sizesAll: SizeDto[] = [];
  try {
    sizesAll = await listSizes();
  } catch {
    sizesAll = [];
  }
  const allSizes: PatternSizeRefDto[] = sizesAll
    .map((s) => ({ id: s.id, code: s.code, sortOrder: s.sortOrder }))
    .sort((a, b) => a.sortOrder - b.sortOrder);

  // Активные категории справочника — для select в форме
  // редактирования. Если справочник пуст (старые stage-окружения),
  // form покажет подсказку «Создайте категорию».
  let categories: PatternCategoryListItemDto[] = [];
  try {
    categories = await listPatternCategories({ status: 'ACTIVE' });
  } catch {
    categories = [];
  }

  return (
    <AdminPageShell
      icon={<Scissors size={22} strokeWidth={1.6} aria-hidden />}
      title="Карточка номенклатуры"
      subtitle={`${pattern.name} · Артикул: ${pattern.article}`}
      actions={
        <>
          <Link
            href="/admin/patterns"
            className="admin-btn admin-btn--ghost"
          >
            <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />
            К списку
          </Link>
          <AdminStatusBadge tone={statusTone(pattern.status)}>
            {formatStatusLabel(pattern.status)}
          </AdminStatusBadge>
        </>
      }
    >
      <ClonePatternModalHost
        patternId={pattern.id}
        patternName={pattern.name}
        patternArticle={pattern.article}
      />

      <div className="admin-grid-2">
        <div className="admin-stack">
          <AdminCard>
            <AdminSectionHeader title="Превью изделия" />
            <div
              style={{
                display: 'flex',
                gap: 16,
                flexWrap: 'wrap',
                alignItems: 'flex-start',
              }}
            >
              <PatternPreviewLarge pattern={pattern} />
              <div style={{ flex: 1, minWidth: 240 }}>
                <PatternPreviewUploadForm patternId={pattern.id} />
              </div>
            </div>
          </AdminCard>

          <AdminCard>
            <AdminSectionHeader title="Основные данные" />
            <dl className="admin-deflist">
              <dt>Название</dt>
              <dd>{pattern.name}</dd>
              <dt>Артикул</dt>
              <dd>
                <code>{pattern.article}</code>
              </dd>
              <dt>Категория</dt>
              <dd>
                <PatternCategoryDisplay pattern={pattern} />
              </dd>
              <dt>Статус</dt>
              <dd>
                <AdminStatusBadge tone={statusTone(pattern.status)}>
                  {formatStatusLabel(pattern.status)}
                </AdminStatusBadge>
              </dd>
              <dt>Описание</dt>
              <dd>
                {pattern.description ?? (
                  <span className="admin-muted">—</span>
                )}
              </dd>
            </dl>
          </AdminCard>

          {pattern.constructorTask && (
            <AdminCard>
              <AdminSectionHeader
                icon={
                  <ClipboardList size={18} strokeWidth={1.6} aria-hidden />
                }
                title="Источник"
                hint="Лекало создано через flow «Отправить конструктору»"
              />
              <dl className="admin-deflist">
                <dt>Задача</dt>
                <dd>
                  <Link
                    href={`/admin/constructor-tasks/${pattern.constructorTask.id}`}
                    className="admin-table__action-link"
                  >
                    Открыть задачу
                    <ArrowRight size={14} strokeWidth={1.6} aria-hidden />
                  </Link>
                </dd>
                <dt>Статус задачи</dt>
                <dd>
                  <AdminStatusBadge
                    tone={
                      CONSTRUCTOR_TASK_STATUS_TONE[
                        pattern.constructorTask.status
                      ]
                    }
                  >
                    {
                      CONSTRUCTOR_TASK_STATUS_LABELS[
                        pattern.constructorTask.status
                      ]
                    }
                  </AdminStatusBadge>
                </dd>
                <dt>Конструктор</dt>
                <dd>
                  {pattern.constructorTask.assignedToName ?? (
                    <span className="admin-muted">не назначен</span>
                  )}
                </dd>
                <dt>Отправлена</dt>
                <dd>
                  {new Date(
                    pattern.constructorTask.createdAt,
                  ).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}
                </dd>
                {pattern.constructorTask.acceptedAt && (
                  <>
                    <dt>Принята</dt>
                    <dd>
                      {new Date(
                        pattern.constructorTask.acceptedAt,
                      ).toLocaleString('ru-RU', {
                        timeZone: 'Europe/Moscow',
                      })}
                    </dd>
                  </>
                )}
              </dl>
            </AdminCard>
          )}

          <AdminCard>
            <AdminSectionHeader title="Редактирование" />
            <EditPatternForm pattern={pattern} categories={categories} />
            <ArchivePatternButton
              patternId={pattern.id}
              patternName={pattern.name}
              status={pattern.status}
            />
            <DeletePatternButton
              patternId={pattern.id}
              patternName={pattern.name}
              status={pattern.status}
            />
          </AdminCard>

          <PatternSizesManager
            patternId={pattern.id}
            allSizes={allSizes}
            sizeFiles={pattern.sizeFiles}
            materialAreas={pattern.materialAreas}
            categoryAreaParameters={pattern.categoryAreaParameters}
            hasCategory={pattern.categoryId !== null}
          />

          <AdminCard>
            <AdminSectionHeader
              icon={<Ruler size={18} strokeWidth={1.6} aria-hidden />}
              title="Погонные метры"
              hint="Ввод в м пог. по размерам — единица потребности задаётся в категории"
            />
            <PatternSizeParameterValuesBlock pattern={pattern} />
          </AdminCard>

          <AdminCard>
            <AdminSectionHeader
              icon={<Package size={18} strokeWidth={1.6} aria-hidden />}
              title="Фурнитура и нормы"
              hint="Норма «количество на изделие» по фурнитуре категории"
            />
            <PatternParameterNormsBlock pattern={pattern} />
          </AdminCard>
        </div>

        <div className="admin-stack">
          <AdminTechInfo
            items={[
              { label: 'ID', value: <code>{pattern.id}</code> },
              { label: 'Создано', value: formatDateTime(pattern.createdAt) },
              {
                label: 'Обновлено',
                value: formatDateTime(pattern.updatedAt),
              },
            ]}
          />
        </div>
      </div>
    </AdminPageShell>
  );
}

function PatternCategoryDisplay({ pattern }: { pattern: PatternDetailDto }) {
  if (pattern.category) {
    const archived = pattern.category.status !== 'ACTIVE';
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 12 }}>
        <PatternCategoryDisplayIcon
          iconImageUrl={pattern.category.iconImageUrl}
          iconKey={pattern.category.iconKey}
          alt={pattern.category.name}
        />
        <span>{pattern.category.name}</span>
        {archived && (
          <span className="admin-muted" style={{ fontSize: '0.85rem' }}>
            (архивная)
          </span>
        )}
        {pattern.categoryCode && pattern.categoryCode !== pattern.category.name && (
          <span className="admin-muted" style={{ fontSize: '0.85rem' }}>
            · старая: {pattern.categoryCode}
          </span>
        )}
      </span>
    );
  }
  if (pattern.categoryCode) {
    return (
      <span className="admin-muted" title="Старая текстовая категория (legacy)">
        Старая категория: {pattern.categoryCode}
      </span>
    );
  }
  return <span className="admin-muted">—</span>;
}

/**
 * Иконка категории в карточке лекала. Этап «Загружаемая иконка
 * категории JPG/PNG»: основной источник — `iconImageUrl`, fallback —
 * lucide (`iconKey`). Та же логика, что у фильтра в `/admin/patterns`,
 * но размер заметно больше (48×48) — визуально это «герой» карточки.
 * Размер задаётся CSS-классом `.pattern-category-icon--detail`
 * (см. `apps/web/app/globals.css`).
 */
function PatternCategoryDisplayIcon({
  iconImageUrl,
  iconKey,
  alt,
}: {
  iconImageUrl: string | null | undefined;
  iconKey: string | null | undefined;
  alt: string;
}) {
  const className = 'pattern-category-icon pattern-category-icon--detail';
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
 * Блок «Фурнитура и нормы» (этап «Фурнитура и нормы»).
 *
 * UI-логика:
 *   - если у лекала нет категории — рисуем подсказку «Выберите
 *     категорию, чтобы настроить фурнитуру»;
 *   - если категория есть, но в ней нет активных параметров с
 *     `inputType = QTY_PER_ITEM` — empty-state «В категории нет
 *     параметров фурнитуры»;
 *   - иначе рисуем форму `PatternItemParameterNormsForm`, которая
 *     показывает по строке на каждый QTY_PER_ITEM-параметр и
 *     текущие сохранённые нормы.
 *
 * Никаких UI-площадей/материалов здесь не считается — фурнитура
 * НЕ попадает в `PatternMaterialArea` (см. ТЗ §11 «Не использовать
 * PatternMaterialArea для фурнитуры»).
 */
function PatternParameterNormsBlock({
  pattern,
}: {
  pattern: PatternDetailDto;
}) {
  if (!pattern.categoryId || !pattern.category) {
    return (
      <div className="admin-muted" role="status">
        Выберите категорию, чтобы настроить фурнитуру.
      </div>
    );
  }
  const qtyParameters = pattern.category.parameters.filter(
    (p) => p.inputType === 'QTY_PER_ITEM' && p.status === 'ACTIVE',
  );
  if (qtyParameters.length === 0) {
    return (
      <div className="admin-muted" role="status">
        В категории нет параметров фурнитуры. Добавьте параметры типа
        «Количество на изделие» в категории.
      </div>
    );
  }
  return (
    <PatternItemParameterNormsForm
      patternId={pattern.id}
      parameters={qtyParameters}
      norms={pattern.parameterNorms}
    />
  );
}

/**
 * Блок «Погонные метры» (этап «Погонные метры по размерам»).
 *
 * UI-логика:
 *   - если у лекала нет категории — подсказка «Выберите категорию,
 *     чтобы настроить погонные метры»;
 *   - если категория есть, но в ней нет активных параметров с
 *     `inputType = LINEAR_M_BY_SIZE` — empty-state «В категории нет
 *     параметров погонных метров»;
 *   - иначе рисуем форму `PatternItemSizeParameterValuesForm`,
 *     которая показывает таблицу: строки = активные размеры
 *     номенклатуры, колонки = LINEAR_M_BY_SIZE-параметры категории,
 *     ячейки = текущие значения.
 *
 * Активные размеры считаются из `pattern.sizeFiles` (`status =
 * ACTIVE`) — по одному на `sizeId`, как в `pattern-sizes-manager.tsx`.
 * Таблица «Площади материалов» и «Погонные метры» работают с одним
 * и тем же набором активных размеров.
 *
 * `PatternMaterialArea` для погонных метров НЕ используется (см.
 * ТЗ §5 / §11) — значения хранятся в отдельной таблице
 * `PatternItemSizeParameterValue`.
 */
function PatternSizeParameterValuesBlock({
  pattern,
}: {
  pattern: PatternDetailDto;
}) {
  if (!pattern.categoryId || !pattern.category) {
    return (
      <div className="admin-muted" role="status">
        Выберите категорию, чтобы настроить погонные метры.
      </div>
    );
  }
  const linearParameters = pattern.category.parameters.filter(
    (p) => p.inputType === 'LINEAR_M_BY_SIZE' && p.status === 'ACTIVE',
  );
  if (linearParameters.length === 0) {
    return (
      <div className="admin-muted" role="status">
        В категории нет параметров погонных метров. Добавьте параметры
        типа «Погонные метры по размерам» в категории.
      </div>
    );
  }
  const activeSizes = computeActivePatternSizes(pattern.sizeFiles);
  return (
    <PatternItemSizeParameterValuesForm
      patternId={pattern.id}
      sizes={activeSizes}
      parameters={linearParameters}
      values={pattern.sizeParameterValues}
    />
  );
}

/**
 * Активные размеры лекала = по одному на `sizeId` среди
 * `PatternSizeFile` со `status = ACTIVE`. Логика идентична
 * `pattern-sizes-manager.tsx::computeActiveSizes` — оставлена тут
 * локально, чтобы блок «Погонные метры» не зависел от внутренних
 * helper-ов клиентского менеджера. Сортировка — `Size.sortOrder`.
 */
function computeActivePatternSizes(
  sizeFiles: readonly PatternSizeFileDto[],
): PatternSizeRefDto[] {
  const map = new Map<string, PatternSizeFileDto>();
  for (const f of sizeFiles) {
    if (f.status !== 'ACTIVE') continue;
    const prev = map.get(f.sizeId);
    if (!prev) {
      map.set(f.sizeId, f);
      continue;
    }
    if (
      f.version > prev.version ||
      (f.version === prev.version &&
        new Date(f.createdAt).getTime() >
          new Date(prev.createdAt).getTime())
    ) {
      map.set(f.sizeId, f);
    }
  }
  return Array.from(map.values())
    .map<PatternSizeRefDto>((f) => f.size)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

function PatternPreviewLarge({ pattern }: { pattern: PatternDetailDto }) {
  if (pattern.previewImageUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={pattern.previewImageUrl}
        alt={`Превью: ${pattern.name}`}
        width={240}
        height={240}
        style={{
          width: 240,
          height: 240,
          objectFit: 'contain',
          borderRadius: 8,
          border: '1px solid var(--admin-border-soft, #e2e8f0)',
          background: 'var(--admin-surface, #fff)',
        }}
      />
    );
  }
  return (
    <div
      aria-hidden
      style={{
        width: 240,
        height: 240,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 8,
        background: 'var(--admin-surface-muted, #f1f5f9)',
        border: '1px dashed var(--admin-border-soft, #e2e8f0)',
        color: 'var(--admin-text-muted, #64748b)',
      }}
    >
      <Scissors size={48} strokeWidth={1.4} />
    </div>
  );
}
