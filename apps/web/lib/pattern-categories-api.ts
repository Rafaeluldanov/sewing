/**
 * Серверные обёртки над `/api/pattern-categories` (см.
 * `apps/api/src/modules/pattern-categories/pattern-categories.controller.ts`).
 *
 * Используется из RSC `/admin/patterns/*` и из server actions
 * (`apps/web/app/admin/patterns/actions.ts`). Контракты — те же
 * Zod-схемы из `@sewing/shared/pattern-categories`.
 */
import type {
  CreatePatternCategoryDto,
  ListPatternCategoriesQuery,
  PatternCategoryDto,
  PatternCategoryListItemDto,
  ReplacePatternCategoryParametersDto,
  UpdatePatternCategoryDto,
} from '@sewing/shared/pattern-categories';
import { apiFetch, apiFetchMultipart } from './api';

export function listPatternCategories(
  query: Partial<ListPatternCategoriesQuery> = {},
): Promise<PatternCategoryListItemDto[]> {
  const params = new URLSearchParams();
  if (query.status) params.set('status', query.status);
  if (query.search) params.set('search', query.search);
  const qs = params.toString();
  const path = qs.length > 0 ? `/pattern-categories?${qs}` : '/pattern-categories';
  return apiFetch<PatternCategoryListItemDto[]>(path, { cache: 'no-store' });
}

export function getPatternCategory(id: string): Promise<PatternCategoryDto> {
  return apiFetch<PatternCategoryDto>(
    `/pattern-categories/${encodeURIComponent(id)}`,
    { cache: 'no-store' },
  );
}

export function createPatternCategory(
  body: CreatePatternCategoryDto,
): Promise<PatternCategoryDto> {
  return apiFetch<PatternCategoryDto>('/pattern-categories', {
    method: 'POST',
    body,
  });
}

export function updatePatternCategory(
  id: string,
  body: UpdatePatternCategoryDto,
): Promise<PatternCategoryDto> {
  return apiFetch<PatternCategoryDto>(
    `/pattern-categories/${encodeURIComponent(id)}`,
    { method: 'PATCH', body },
  );
}

export function replacePatternCategoryParameters(
  id: string,
  body: ReplacePatternCategoryParametersDto,
): Promise<PatternCategoryDto> {
  return apiFetch<PatternCategoryDto>(
    `/pattern-categories/${encodeURIComponent(id)}/parameters`,
    { method: 'PUT', body },
  );
}

export function archivePatternCategory(
  id: string,
): Promise<PatternCategoryDto> {
  return apiFetch<PatternCategoryDto>(
    `/pattern-categories/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  );
}

/**
 * Hard-delete архивной категории
 * (`DELETE /pattern-categories/:id/permanent`). Backend блокирует
 * удаление, если категория не `ARCHIVED` (409
 * `PATTERN_CATEGORY_DELETE_FORBIDDEN`). Ответ пустой.
 *
 * `cascade` — явное согласие на каскад по содержимому группы:
 * номенклатура уходит в архив, техкарты остаются без группы
 * (`?cascade=1`). Без флага backend отвечает 409, если группа не
 * пустая, — так случайный вызов API не может «разобрать» группу мимо
 * предупреждения в UI.
 */
export function deletePatternCategory(
  id: string,
  options?: { cascade?: boolean },
): Promise<void> {
  const qs = options?.cascade ? '?cascade=1' : '';
  return apiFetch<void>(
    `/pattern-categories/${encodeURIComponent(id)}/permanent${qs}`,
    { method: 'DELETE' },
  );
}


/**
 * Загрузка иконки категории JPG/JPEG/PNG
 * (`POST /api/pattern-categories/:id/icon`, multipart/form-data, поле
 * `file`). Используется server action на странице создания категории
 * (`apps/web/app/admin/pattern-categories/new/actions.ts`).
 *
 * Backend сам валидирует расширение (`jpg`/`jpeg`/`png`) и размер;
 * здесь мы просто форвардим `FormData`. См.
 * `PatternCategoriesStorageService.saveIcon`.
 */
export function uploadPatternCategoryIcon(
  id: string,
  file: File | Blob,
  fileName?: string,
): Promise<PatternCategoryDto> {
  const fd = new FormData();
  if (fileName) {
    fd.append('file', file, fileName);
  } else {
    fd.append('file', file);
  }
  return apiFetchMultipart<PatternCategoryDto>(
    `/pattern-categories/${encodeURIComponent(id)}/icon`,
    fd,
  );
}
