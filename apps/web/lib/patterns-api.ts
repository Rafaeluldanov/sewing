/**
 * Серверные обёртки над `/api/patterns` (см.
 * `apps/api/src/modules/patterns/patterns.controller.ts`).
 *
 * Используется из RSC (`/admin/patterns/*`) и из server actions блока
 * лекал (`apps/web/app/admin/patterns/actions.ts`). Контракты — те же
 * Zod-схемы из `@sewing/shared/patterns`, что валидирует backend.
 *
 * Upload-эндпоинты завернуты в `apiFetchMultipart` — server action
 * собирает `FormData` из client form-а и форвардит сюда; cookie
 * прокидывается автоматически (см. `lib/api.ts`).
 */
import type {
  ClonePatternDto,
  CreatePatternDto,
  ListPatternsQuery,
  PatternDetailDto,
  PatternListItemDto,
  PatternsArchiveRequestDto,
  PatternsArchiveResultDto,
  ReplacePatternItemParameterNormInputDto,
  ReplacePatternItemParameterNormsDto,
  ReplacePatternItemSizeParameterValueInputDto,
  ReplacePatternItemSizeParameterValuesDto,
  ReplacePatternMaterialAreaInputDto,
  ReplacePatternMaterialAreasDto,
  UpdatePatternDto,
} from '@sewing/shared/patterns';
import { apiFetch, apiFetchMultipart } from './api';

export function listPatterns(
  query: Partial<ListPatternsQuery> = {},
): Promise<PatternListItemDto[]> {
  const params = new URLSearchParams();
  if (query.search) params.set('search', query.search);
  if (query.status) params.set('status', query.status);
  if (query.categoryId) params.set('categoryId', query.categoryId);
  const qs = params.toString();
  const path = qs.length > 0 ? `/patterns?${qs}` : '/patterns';
  return apiFetch<PatternListItemDto[]>(path, { cache: 'no-store' });
}

export function getPattern(id: string): Promise<PatternDetailDto> {
  return apiFetch<PatternDetailDto>(`/patterns/${encodeURIComponent(id)}`, {
    cache: 'no-store',
  });
}

export function createPattern(
  body: CreatePatternDto,
): Promise<PatternDetailDto> {
  return apiFetch<PatternDetailDto>('/patterns', {
    method: 'POST',
    body,
  });
}

export function updatePattern(
  id: string,
  body: UpdatePatternDto,
): Promise<PatternDetailDto> {
  return apiFetch<PatternDetailDto>(
    `/patterns/${encodeURIComponent(id)}`,
    { method: 'PATCH', body },
  );
}

/**
 * Клонировать существующую номенклатуру (`POST /api/patterns/:id/clone`).
 * Этап «Создать номенклатуру по готовому лекалу». Backend копирует
 * DXF / площади / погонные метры / нормы фурнитуры; если `name` /
 * `article` не заданы, подбирает значения по исходному лекалу.
 */
export function clonePattern(
  id: string,
  body: ClonePatternDto,
): Promise<PatternDetailDto> {
  return apiFetch<PatternDetailDto>(
    `/patterns/${encodeURIComponent(id)}/clone`,
    { method: 'POST', body },
  );
}

export function uploadPatternPreview(
  id: string,
  file: File | Blob,
  fileName?: string,
): Promise<PatternDetailDto> {
  const fd = new FormData();
  if (fileName) {
    fd.append('file', file, fileName);
  } else {
    fd.append('file', file);
  }
  return apiFetchMultipart<PatternDetailDto>(
    `/patterns/${encodeURIComponent(id)}/preview`,
    fd,
  );
}

export function uploadPatternSizeFile(
  patternId: string,
  sizeId: string,
  file: File | Blob | null,
  fileName?: string,
): Promise<PatternDetailDto> {
  const fd = new FormData();
  // Файл необязателен: без него backend создаёт размер-заглушку
  // (fileUrl = null), файл догружается позже.
  if (file) {
    if (fileName) {
      fd.append('file', file, fileName);
    } else {
      fd.append('file', file);
    }
  }
  return apiFetchMultipart<PatternDetailDto>(
    `/patterns/${encodeURIComponent(patternId)}/sizes/${encodeURIComponent(sizeId)}/file`,
    fd,
  );
}

/**
 * Hard-delete архивной номенклатуры (`DELETE /patterns/:id/permanent`).
 * Backend блокирует удаление, если лекало не `ARCHIVED` или на него
 * ссылаются заказы (409 `PATTERN_DELETE_FORBIDDEN`). Ответ пустой.
 */
export function deletePattern(id: string): Promise<void> {
  return apiFetch<void>(
    `/patterns/${encodeURIComponent(id)}/permanent`,
    { method: 'DELETE' },
  );
}

/**
 * Массовые операции архива номенклатуры (`POST /patterns/archive`
 * `…/restore` `…/purge`, этап «Архив номенклатуры»). Ответ —
 * частичный успех: `processed` + `skipped` с причиной; 4xx прилетает
 * только на невалидное тело / отсутствие прав.
 */
export function archivePatterns(
  patternIds: string[],
): Promise<PatternsArchiveResultDto> {
  return apiFetch<PatternsArchiveResultDto>('/patterns/archive', {
    method: 'POST',
    body: { patternIds } satisfies PatternsArchiveRequestDto,
  });
}

export function restorePatterns(
  patternIds: string[],
): Promise<PatternsArchiveResultDto> {
  return apiFetch<PatternsArchiveResultDto>('/patterns/restore', {
    method: 'POST',
    body: { patternIds } satisfies PatternsArchiveRequestDto,
  });
}

export function purgePatterns(
  patternIds: string[],
): Promise<PatternsArchiveResultDto> {
  return apiFetch<PatternsArchiveResultDto>('/patterns/purge', {
    method: 'POST',
    body: { patternIds } satisfies PatternsArchiveRequestDto,
  });
}

export function archivePatternSizeFile(
  patternId: string,
  sizeId: string,
  fileId: string,
): Promise<PatternDetailDto> {
  return apiFetch<PatternDetailDto>(
    `/patterns/${encodeURIComponent(patternId)}/sizes/${encodeURIComponent(sizeId)}/file/${encodeURIComponent(fileId)}`,
    { method: 'DELETE' },
  );
}

/**
 * Восстановить архивный файл размера (`ARCHIVED → ACTIVE`).
 * `POST /patterns/:id/sizes/:sizeId/file/:fileId/restore`.
 */
export function restorePatternSizeFile(
  patternId: string,
  sizeId: string,
  fileId: string,
): Promise<PatternDetailDto> {
  return apiFetch<PatternDetailDto>(
    `/patterns/${encodeURIComponent(patternId)}/sizes/${encodeURIComponent(sizeId)}/file/${encodeURIComponent(fileId)}/restore`,
    { method: 'POST' },
  );
}

/**
 * Жёсткое удаление файла размера (запись + файл с диска), безвозвратно.
 * `DELETE /patterns/:id/sizes/:sizeId/file/:fileId/permanent`.
 */
export function deletePatternSizeFile(
  patternId: string,
  sizeId: string,
  fileId: string,
): Promise<PatternDetailDto> {
  return apiFetch<PatternDetailDto>(
    `/patterns/${encodeURIComponent(patternId)}/sizes/${encodeURIComponent(sizeId)}/file/${encodeURIComponent(fileId)}/permanent`,
    { method: 'DELETE' },
  );
}

export function replacePatternMaterialAreas(
  patternId: string,
  areas: ReplacePatternMaterialAreaInputDto[],
): Promise<PatternDetailDto> {
  const body: ReplacePatternMaterialAreasDto = { areas };
  return apiFetch<PatternDetailDto>(
    `/patterns/${encodeURIComponent(patternId)}/material-areas`,
    { method: 'PUT', body },
  );
}

/**
 * Bulk-replace «Фурнитуры и норм» лекала
 * (`PUT /api/patterns/:id/parameter-norms`). Этап «Фурнитура и
 * нормы». Backend в одной транзакции стирает все старые нормы по
 * QTY_PER_ITEM-параметрам категории и создаёт новые. Параметры, для
 * которых в payload нормы нет, остаются без нормы.
 */
export function replacePatternItemParameterNorms(
  patternId: string,
  norms: ReplacePatternItemParameterNormInputDto[],
): Promise<PatternDetailDto> {
  const body: ReplacePatternItemParameterNormsDto = { norms };
  return apiFetch<PatternDetailDto>(
    `/patterns/${encodeURIComponent(patternId)}/parameter-norms`,
    { method: 'PUT', body },
  );
}

/**
 * Bulk-replace значений «погонных метров по размерам» лекала
 * (`PUT /api/patterns/:id/size-parameter-values`). Этап «Погонные
 * метры по размерам». Backend в одной транзакции стирает все
 * старые значения по LINEAR_M_BY_SIZE параметрам категории и
 * создаёт новые по ячейкам формы. Параметры/размеры, для которых
 * в payload значений нет, остаются без значений.
 */
export function replacePatternItemSizeParameterValues(
  patternId: string,
  values: ReplacePatternItemSizeParameterValueInputDto[],
): Promise<PatternDetailDto> {
  const body: ReplacePatternItemSizeParameterValuesDto = { values };
  return apiFetch<PatternDetailDto>(
    `/patterns/${encodeURIComponent(patternId)}/size-parameter-values`,
    { method: 'PUT', body },
  );
}
