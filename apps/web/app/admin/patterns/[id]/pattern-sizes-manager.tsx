'use client';

/**
 * PatternSizesManager — единый клиентский компонент, который держит
 * три блока карточки номенклатуры:
 *
 *   1. «Размеры номенклатуры» — счётчик активных размеров + чипсы +
 *      кнопка «Добавить размер».
 *   2. «DXF по размерам» — таблица только активных размеров с
 *      историей файлов (текущая версия + архивные); per-row кнопки
 *      «Заменить» / «Архивировать».
 *   3. «Площади материалов» — `PatternMaterialAreasForm` поверх
 *      **только активных размеров**.
 *
 * Источник истины «активного размера» — `PatternSizeFile` со
 * `status = 'ACTIVE'`. Никакой отдельной сущности `PatternSize` нет
 * (см. ТЗ: «Не создавать отдельную сущность PatternSize»). Группируем
 * активные файлы по `sizeId`, на размер берём один — последний по
 * `version` (tiebreak — `createdAt`).
 *
 * Модалка «Добавить размер» живёт внутри менеджера: одна модалка на
 * страницу, открывается из любой пустой подсказки и шапки блока.
 *
 * Компонент клиентский, потому что ему нужно состояние модалки и
 * управление фокусом. Внутрь рендерятся `AdminCard` /
 * `AdminSectionHeader` / `AdminEmptyState` — это «общие» компоненты
 * без `'use client'` (см. `apps/web/components/admin/`), их можно
 * использовать как из server, так и из client component.
 */

import { useCallback, useMemo, useState } from 'react';
import { FileText, Plus, Ruler } from 'lucide-react';
import {
  type PatternMaterialAreaDto,
  type PatternSizeFileDto,
  type PatternSizeRefDto,
} from '@sewing/shared/patterns';
import type { PatternCategoryParameterDto } from '@sewing/shared/pattern-categories';
import {
  AdminCard,
  AdminEmptyState,
  AdminSectionHeader,
  AdminStatusBadge,
  AdminTable,
  type AdminTableColumn,
} from '@/components/admin';
import { statusTone } from '@/lib/admin-labels';
import { PatternMaterialAreasForm } from './material-areas-form';
import { ArchivePatternSizeFileForm } from './archive-file-form';
import { ReplacePatternSizeFileForm } from './replace-pattern-size-file-form';
import { AddPatternSizeModal } from './add-pattern-size-modal';
import { CreateSizeModal } from './create-size-modal';

interface ActiveSizeEntry {
  size: PatternSizeRefDto;
  activeFile: PatternSizeFileDto;
}

interface Props {
  patternId: string;
  /**
   * Все размеры справочника `Size`. Нужны для select модалки
   * «Добавить размер» — отфильтруем тут уже добавленные.
   */
  allSizes: readonly PatternSizeRefDto[];
  /**
   * Полная история DXF-файлов (`ACTIVE` + `ARCHIVED`). Активные
   * вычисляем тут же — это удобнее, чем гонять флаги через сервер.
   */
  sizeFiles: readonly PatternSizeFileDto[];
  materialAreas: readonly PatternMaterialAreaDto[];
  /**
   * Активные параметры категории номенклатуры с `inputType =
   * AREA_M2_BY_SIZE` (этап «Категории номенклатуры»). Если у лекала
   * есть категория — таблица «Площади материалов» рендерит колонки
   * именно по этим параметрам. Если категории нет — fallback на
   * глобальный `MATERIAL_ROLES` (см. `material-areas-form.tsx`).
   */
  categoryAreaParameters?: readonly PatternCategoryParameterDto[];
  /**
   * У лекала есть привязка к категории (даже если в категории нет
   * AREA_M2_BY_SIZE параметров — UI должен показать empty-state, а
   * не fallback на глобальные `MATERIAL_ROLES`).
   */
  hasCategory?: boolean;
}

/**
 * Активные размеры = по одному на `sizeId` среди файлов со
 * `status = 'ACTIVE'`. Если по ошибке несколько активных — берём
 * последний по `version`, при равной — по `createdAt`. Сортируем
 * по `size.sortOrder`.
 */
function computeActiveSizes(
  sizeFiles: readonly PatternSizeFileDto[],
): ActiveSizeEntry[] {
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
    .map<ActiveSizeEntry>((f) => ({ size: f.size, activeFile: f }))
    .sort((a, b) => a.size.sortOrder - b.size.sortOrder);
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('ru-RU');
}

export function PatternSizesManager({
  patternId,
  allSizes,
  sizeFiles,
  materialAreas,
  categoryAreaParameters,
  hasCategory,
}: Props) {
  const [modalOpen, setModalOpen] = useState(false);
  // Этап «Создание пользовательского размера»: отдельная модалка для
  // создания записи в общем справочнике `Size`. Живёт рядом с
  // `AddPatternSizeModal`, чтобы менеджер мог сначала создать
  // нестандартный размер (например, «200×300×10»), а потом привязать
  // его к этой номенклатуре через существующий flow «Добавить
  // размер» с DXF-файлом.
  const [createSizeOpen, setCreateSizeOpen] = useState(false);
  // UX-bridge между «Создать размер» и «Добавить размер»: если
  // менеджер только что создал нестандартный размер и нажал в
  // CreateSizeModal «Привязать к этой номенклатуре» — ловим этот
  // размер тут и пробрасываем в AddPatternSizeModal как
  // `initialSelected`. Очищаем при закрытии add-модалки, чтобы
  // следующий «Добавить размер» открывался с обычным дефолтом.
  const [pendingAttachSize, setPendingAttachSize] =
    useState<PatternSizeRefDto | null>(null);

  const activeEntries = useMemo(
    () => computeActiveSizes(sizeFiles),
    [sizeFiles],
  );
  const activeSizes = useMemo(
    () => activeEntries.map((e) => e.size),
    [activeEntries],
  );
  const activeSizeIds = useMemo(
    () => new Set(activeSizes.map((s) => s.id)),
    [activeSizes],
  );

  // Размеры, которых ещё нет среди активных (для select модалки).
  const availableForAdd = useMemo(
    () =>
      allSizes
        .filter((s) => !activeSizeIds.has(s.id))
        .slice()
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [allSizes, activeSizeIds],
  );

  // Файлы, относящиеся к активным размерам (включая архивные версии
  // тех же `sizeId`, чтобы менеджер видел историю замен).
  const filesForActiveSizes = useMemo(
    () => sizeFiles.filter((f) => activeSizeIds.has(f.sizeId)),
    [sizeFiles, activeSizeIds],
  );

  const openModal = useCallback(() => setModalOpen(true), []);
  const closeModal = useCallback(() => {
    setModalOpen(false);
    setPendingAttachSize(null);
  }, []);

  const openCreateSize = useCallback(() => setCreateSizeOpen(true), []);
  const closeCreateSize = useCallback(() => setCreateSizeOpen(false), []);

  // Колбэк из CreateSizeModal — закрываем create-модалку, запоминаем
  // только что созданный размер и сразу открываем AddPatternSizeModal
  // с уже выбранным размером. Менеджеру осталось загрузить DXF и
  // нажать «Добавить».
  const handleAttachCreatedSize = useCallback(
    (size: { id: string; code: string }) => {
      setCreateSizeOpen(false);
      // sortOrder для оптимистичного включения в select: просто
      // ставим Number.MAX_SAFE_INTEGER, чтобы новый размер уехал в
      // конец, как и любые свежесозданные (бэкенд считает sortOrder
      // как max+10). После router.refresh() пропс перетрёт это
      // полем `availableSizes`, и сортировка станет корректной.
      setPendingAttachSize({
        id: size.id,
        code: size.code,
        sortOrder: Number.MAX_SAFE_INTEGER,
      });
      setModalOpen(true);
    },
    [],
  );

  const hasActive = activeSizes.length > 0;

  return (
    <>
      {/* ---------------------------------------------------- */}
      {/* 1. Размеры номенклатуры                              */}
      {/* ---------------------------------------------------- */}
      <AdminCard>
        <AdminSectionHeader
          icon={<Ruler size={18} strokeWidth={1.6} aria-hidden />}
          title="Размеры номенклатуры"
          hint={
            hasActive
              ? `Активных размеров: ${activeSizes.length}`
              : undefined
          }
          actions={
            <span style={{ display: 'inline-flex', gap: 8 }}>
              <button
                type="button"
                className="admin-btn admin-btn--ghost"
                onClick={openCreateSize}
                aria-haspopup="dialog"
                aria-expanded={createSizeOpen}
                title="Создать новый размер в общем справочнике (например, 200×300×10)"
              >
                <Plus size={16} strokeWidth={1.7} aria-hidden />
                Создать размер
              </button>
              <button
                type="button"
                className="admin-btn admin-btn--primary"
                onClick={openModal}
                aria-haspopup="dialog"
                aria-expanded={modalOpen}
              >
                <Plus size={16} strokeWidth={1.7} aria-hidden />
                Добавить размер
              </button>
            </span>
          }
        />
        {hasActive ? (
          <ul
            className="admin-size-plan__chips"
            aria-label="Активные размеры номенклатуры"
            style={{ marginTop: 4 }}
          >
            {activeEntries.map((e) => (
              <li
                key={e.size.id}
                className="admin-size-plan__chip"
                title={`Активный DXF: ${e.activeFile.originalFileName} (v${e.activeFile.version})`}
              >
                <span className="admin-size-plan__chip-code">
                  {e.size.code}
                </span>
                <span className="admin-size-plan__chip-sep" aria-hidden>
                  ·
                </span>
                <span className="admin-size-plan__chip-qty">
                  v{e.activeFile.version}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <AdminEmptyState
            icon={<Ruler size={24} strokeWidth={1.6} aria-hidden />}
            title="Размеры не добавлены"
            hint="Добавьте размер и загрузите DXF, чтобы использовать его в заказах."
            actions={
              <button
                type="button"
                className="admin-btn admin-btn--primary"
                onClick={openModal}
                aria-haspopup="dialog"
                aria-expanded={modalOpen}
              >
                <Plus size={16} strokeWidth={1.7} aria-hidden />
                Добавить размер
              </button>
            }
          />
        )}
      </AdminCard>

      {/* ---------------------------------------------------- */}
      {/* 2. DXF по размерам — только активные размеры         */}
      {/* ---------------------------------------------------- */}
      <AdminCard>
        <AdminSectionHeader
          title="DXF по размерам"
          hint={
            hasActive ? `${activeSizes.length} активных` : undefined
          }
        />
        {hasActive ? (
          <ActiveSizesFilesTable
            patternId={patternId}
            files={filesForActiveSizes}
          />
        ) : (
          <AdminEmptyState
            icon={<FileText size={26} strokeWidth={1.6} aria-hidden />}
            title="DXF по размерам ещё не загружены"
            hint="Добавьте размер — DXF загружается в той же модалке."
            actions={
              <button
                type="button"
                className="admin-btn admin-btn--primary"
                onClick={openModal}
                aria-haspopup="dialog"
                aria-expanded={modalOpen}
              >
                <Plus size={16} strokeWidth={1.7} aria-hidden />
                Добавить размер
              </button>
            }
          />
        )}
      </AdminCard>

      {/* ---------------------------------------------------- */}
      {/* 3. Площади материалов — только активные размеры      */}
      {/* ---------------------------------------------------- */}
      <AdminCard>
        <AdminSectionHeader
          title="Площади материалов"
          hint={
            hasActive
              ? `Активных размеров: ${activeSizes.length} · Площади указываются в м²`
              : undefined
          }
        />
        {hasActive ? (
          <PatternMaterialAreasForm
            patternId={patternId}
            sizes={activeSizes}
            areas={[...materialAreas]}
            categoryAreaParameters={categoryAreaParameters}
            hasCategory={hasCategory}
          />
        ) : (
          <AdminEmptyState
            icon={<Ruler size={24} strokeWidth={1.6} aria-hidden />}
            title="Сначала добавьте размеры и загрузите DXF"
            hint="Площади материалов вводятся по активным размерам номенклатуры."
            actions={
              <button
                type="button"
                className="admin-btn admin-btn--primary"
                onClick={openModal}
                aria-haspopup="dialog"
                aria-expanded={modalOpen}
              >
                <Plus size={16} strokeWidth={1.7} aria-hidden />
                Добавить размер
              </button>
            }
          />
        )}
      </AdminCard>

      {modalOpen && (
        <AddPatternSizeModal
          patternId={patternId}
          availableSizes={availableForAdd}
          initialSelected={pendingAttachSize}
          onClose={closeModal}
        />
      )}
      {createSizeOpen && (
        <CreateSizeModal
          patternId={patternId}
          onClose={closeCreateSize}
          onAttachCreatedSize={handleAttachCreatedSize}
        />
      )}
    </>
  );
}

/**
 * Таблица DXF-файлов **по активным размерам**: одна строка на запись
 * (включая архивные версии тех же `sizeId` — менеджер видит, какие
 * версии были до текущей). Запись со `status = ACTIVE` имеет в
 * «Действиях» две кнопки: «Заменить» (загрузить новую версию) и
 * «Архивировать»; архивные строки — без действий.
 */
function ActiveSizesFilesTable({
  patternId,
  files,
}: {
  patternId: string;
  files: PatternSizeFileDto[];
}) {
  const rows = [...files].sort((a, b) => {
    if (a.size.sortOrder !== b.size.sortOrder) {
      return a.size.sortOrder - b.size.sortOrder;
    }
    if (a.version !== b.version) return b.version - a.version;
    return (
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  });
  const columns: AdminTableColumn<PatternSizeFileDto>[] = [
    {
      key: 'size',
      header: 'Размер',
      render: (f) => <strong>{f.size.code}</strong>,
    },
    {
      key: 'version',
      header: 'Версия',
      align: 'right',
      render: (f) => `v${f.version}`,
    },
    {
      key: 'name',
      header: 'Файл',
      render: (f) => (
        <a
          href={f.fileUrl}
          target="_blank"
          rel="noreferrer"
          className="admin-table__action-link"
          style={{ wordBreak: 'break-all' }}
        >
          <FileText size={14} strokeWidth={1.6} aria-hidden />
          {f.originalFileName}
        </a>
      ),
    },
    {
      key: 'createdAt',
      header: 'Загружен',
      render: (f) => (
        <span className="admin-muted" style={{ fontSize: '0.85rem' }}>
          {formatDateTime(f.createdAt)}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Статус',
      render: (f) => (
        <AdminStatusBadge tone={statusTone(f.status)}>
          {f.status === 'ACTIVE'
            ? 'Активен'
            : f.status === 'ARCHIVED'
              ? 'Архив'
              : f.status}
        </AdminStatusBadge>
      ),
    },
    {
      key: 'actions',
      header: '',
      isAction: true,
      render: (f) =>
        f.status === 'ACTIVE' ? (
          <span
            style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}
          >
            <ReplacePatternSizeFileForm
              patternId={patternId}
              sizeId={f.sizeId}
            />
            <ArchivePatternSizeFileForm
              patternId={patternId}
              sizeId={f.sizeId}
              fileId={f.id}
            />
          </span>
        ) : (
          <span className="admin-muted">—</span>
        ),
    },
  ];
  return <AdminTable rows={rows} columns={columns} rowKey={(f) => f.id} />;
}
