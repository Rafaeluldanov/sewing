'use client';

/**
 * PatternSizesManager — единый клиентский компонент, который держит
 * три блока карточки номенклатуры:
 *
 *   1. «Размеры номенклатуры» — счётчик активных размеров + чипсы +
 *      кнопка «Добавить размер».
 *   2. «Файлы по размерам» — две вкладки «Активные» / «Архив».
 *      Активные: per-row «Заменить» / «Архивировать» / корзина.
 *      Архив: все архивные файлы (в т.ч. размеров без активного
 *      файла) с «Восстановить» / корзина.
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
import { Archive, FileText, Plus, Ruler } from 'lucide-react';
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
  AdminTable,
  type AdminTableColumn,
} from '@/components/admin';
import { PatternMaterialAreasForm } from './material-areas-form';
import { ArchivePatternSizeFileForm } from './archive-file-form';
import { RestorePatternSizeFileForm } from './restore-file-form';
import { DeletePatternSizeFileForm } from './delete-file-form';
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
                title={
                  e.activeFile.fileUrl
                    ? `Активный файл: ${e.activeFile.originalFileName} (v${e.activeFile.version})`
                    : 'Размер без файла — файл можно догрузить позже'
                }
              >
                <span className="admin-size-plan__chip-code">
                  {e.size.code}
                </span>
                <span className="admin-size-plan__chip-sep" aria-hidden>
                  ·
                </span>
                <span className="admin-size-plan__chip-qty">
                  {e.activeFile.fileUrl ? `v${e.activeFile.version}` : 'без файла'}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <AdminEmptyState
            icon={<Ruler size={24} strokeWidth={1.6} aria-hidden />}
            title="Размеры не добавлены"
            hint="Добавьте размер (файл лекала можно загрузить сразу или позже), чтобы использовать его в заказах."
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
      {/* 2. Файлы по размерам — вкладки «Активные» / «Архив»  */}
      {/* ---------------------------------------------------- */}
      <PatternSizeFilesCard
        patternId={patternId}
        sizeFiles={sizeFiles}
        onAddSize={openModal}
      />

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
            title="Сначала добавьте размеры"
            hint="Площади материалов вводятся по активным размерам номенклатуры (файл лекала можно догрузить позже)."
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
 * Карточка «Файлы по размерам» с двумя вкладками:
 *
 *   - **Активные** — файлы со `status = ACTIVE` (по строке на размер).
 *     Действия: «Заменить» (новая версия), «Архивировать», корзина
 *     (жёсткое удаление).
 *   - **Архив** — файлы со `status = ARCHIVED` по **всем** размерам,
 *     в т.ч. тем, у которых не осталось активного файла (раньше такие
 *     записи вообще не показывались). Действия: «Восстановить»
 *     (`ARCHIVED → ACTIVE`) и корзина.
 *
 * Корзина (`DeletePatternSizeFileForm`) есть в обеих вкладках — по
 * решению задачи «жёсткое удаление везде». Архивация остаётся
 * обратимой (через вкладку «Архив»), удаление — безвозвратное.
 */
function PatternSizeFilesCard({
  patternId,
  sizeFiles,
  onAddSize,
}: {
  patternId: string;
  sizeFiles: readonly PatternSizeFileDto[];
  onAddSize: () => void;
}) {
  const [tab, setTab] = useState<'active' | 'archived'>('active');

  const activeFiles = useMemo(
    () => sizeFiles.filter((f) => f.status === 'ACTIVE'),
    [sizeFiles],
  );
  const archivedFiles = useMemo(
    () => sizeFiles.filter((f) => f.status === 'ARCHIVED'),
    [sizeFiles],
  );

  const hasAnyActive = activeFiles.length > 0;
  const hasAnyArchived = archivedFiles.length > 0;

  return (
    <AdminCard>
      <AdminSectionHeader
        title="Файлы по размерам"
        hint={`Активных: ${activeFiles.length} · В архиве: ${archivedFiles.length}`}
        actions={
          <span
            className="admin-tabs"
            role="tablist"
            aria-label="Фильтр файлов по статусу"
            style={{ marginBottom: 0 }}
          >
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'active'}
              className={`admin-tab ${tab === 'active' ? 'admin-tab--active' : ''}`}
              onClick={() => setTab('active')}
            >
              <FileText size={14} strokeWidth={1.7} aria-hidden />
              Активные ({activeFiles.length})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'archived'}
              className={`admin-tab ${tab === 'archived' ? 'admin-tab--active' : ''}`}
              onClick={() => setTab('archived')}
            >
              <Archive size={14} strokeWidth={1.7} aria-hidden />
              Архив ({archivedFiles.length})
            </button>
          </span>
        }
      />

      {tab === 'active' ? (
        hasAnyActive ? (
          <PatternSizeFilesTable
            patternId={patternId}
            files={activeFiles}
            mode="active"
          />
        ) : (
          <AdminEmptyState
            icon={<FileText size={26} strokeWidth={1.6} aria-hidden />}
            title="Активных файлов нет"
            hint="Добавьте размер — файл (PDF/PLT/DXF/PLO) можно загрузить в той же модалке или позже."
            actions={
              <button
                type="button"
                className="admin-btn admin-btn--primary"
                onClick={onAddSize}
              >
                <Plus size={16} strokeWidth={1.7} aria-hidden />
                Добавить размер
              </button>
            }
          />
        )
      ) : hasAnyArchived ? (
        <PatternSizeFilesTable
          patternId={patternId}
          files={archivedFiles}
          mode="archived"
        />
      ) : (
        <AdminEmptyState
          icon={<Archive size={26} strokeWidth={1.6} aria-hidden />}
          title="В архиве пусто"
          hint="Заархивированные файлы размеров появятся здесь — отсюда их можно восстановить или удалить навсегда."
        />
      )}
    </AdminCard>
  );
}

/**
 * Таблица файлов размеров для одной вкладки. `mode` определяет набор
 * действий в последней колонке:
 *   - `active`   → «Заменить» + «Архивировать» + корзина;
 *   - `archived` → «Восстановить» + корзина.
 * Колонку «Статус» не рисуем — она избыточна (вкладка = один статус).
 */
function PatternSizeFilesTable({
  patternId,
  files,
  mode,
}: {
  patternId: string;
  files: PatternSizeFileDto[];
  mode: 'active' | 'archived';
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
      render: (f) =>
        f.fileUrl ? (
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
        ) : (
          <span className="admin-muted">файл не загружен</span>
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
      key: 'actions',
      header: '',
      isAction: true,
      render: (f) => (
        <span
          style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}
        >
          {mode === 'active' ? (
            <>
              <ReplacePatternSizeFileForm
                patternId={patternId}
                sizeId={f.sizeId}
                hasFile={f.fileUrl != null}
              />
              <ArchivePatternSizeFileForm
                patternId={patternId}
                sizeId={f.sizeId}
                fileId={f.id}
              />
            </>
          ) : (
            <RestorePatternSizeFileForm
              patternId={patternId}
              sizeId={f.sizeId}
              fileId={f.id}
            />
          )}
          <DeletePatternSizeFileForm
            patternId={patternId}
            sizeId={f.sizeId}
            fileId={f.id}
            label={`${f.size.code} · v${f.version}`}
          />
        </span>
      ),
    },
  ];
  return <AdminTable rows={rows} columns={columns} rowKey={(f) => f.id} />;
}
