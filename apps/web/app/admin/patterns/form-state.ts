/**
 * State-объекты для server actions модуля «Лекала» (см. `./actions.ts`).
 *
 * Файл с `'use server'` обязан экспортировать только async-функции,
 * поэтому интерфейсы и initial-значения вынесены сюда (тот же
 * паттерн, что у `/admin/clients/form-state.ts`).
 */

export interface CreatePatternState {
  ok?: boolean;
  successMessage?: string;
  error?: string;
  errorRequestId?: string;
}

export const initialCreatePatternState: CreatePatternState = {};

export interface UpdatePatternState {
  ok?: boolean;
  successMessage?: string;
  error?: string;
  errorRequestId?: string;
}

export const initialUpdatePatternState: UpdatePatternState = {};

export interface UploadPatternFileState {
  ok?: boolean;
  successMessage?: string;
  error?: string;
  errorRequestId?: string;
}

export const initialUploadPatternFileState: UploadPatternFileState = {};

export interface MaterialAreasState {
  ok?: boolean;
  successMessage?: string;
  error?: string;
  errorRequestId?: string;
}

export const initialMaterialAreasState: MaterialAreasState = {};

/**
 * State формы «Фурнитура и нормы» (см.
 * `apps/web/app/admin/patterns/[id]/parameter-norms-form.tsx`,
 * `replacePatternItemParameterNormsAction` в `actions.ts`).
 */
export interface ParameterNormsState {
  ok?: boolean;
  successMessage?: string;
  error?: string;
  errorRequestId?: string;
}

export const initialParameterNormsState: ParameterNormsState = {};

/**
 * State формы «Погонные метры по размерам» (см.
 * `apps/web/app/admin/patterns/[id]/size-parameter-values-form.tsx`,
 * `replacePatternItemSizeParameterValuesAction` в `actions.ts`).
 */
export interface SizeParameterValuesState {
  ok?: boolean;
  successMessage?: string;
  error?: string;
  errorRequestId?: string;
}

export const initialSizeParameterValuesState: SizeParameterValuesState = {};

/**
 * State модалки «Добавить категорию» (этап «Категории номенклатуры»,
 * см. `apps/web/app/admin/patterns/category-create-modal.tsx`).
 */
export interface CreatePatternCategoryState {
  ok?: boolean;
  successMessage?: string;
  error?: string;
  errorRequestId?: string;
}

export const initialCreatePatternCategoryState: CreatePatternCategoryState = {};

/**
 * State редактирования параметров категории. На MVP не используется
 * отдельной формой (категория редактируется в той же модалке через
 * `replacePatternCategoryParameters`), но интерфейс зарезервирован
 * под будущую страницу `/admin/patterns/categories/[id]`.
 */
export interface ReplaceCategoryParametersState {
  ok?: boolean;
  successMessage?: string;
  error?: string;
  errorRequestId?: string;
}

export const initialReplaceCategoryParametersState: ReplaceCategoryParametersState =
  {};

/**
 * State модалки «Создать размер» (этап «Создание пользовательского
 * размера», см. `apps/web/app/admin/patterns/[id]/create-size-modal.tsx`,
 * `createSizeAction` в `actions.ts`).
 *
 * `createdSizeCode` — каноничный `Size.code` после нормализации
 * (например, ввод «200*300*10» вернёт `"200×300×10"`). Используется
 * UI для подсказки «Размер «200×300×10» создан и доступен в
 * справочнике».
 */
export interface CreateSizeState {
  ok?: boolean;
  successMessage?: string;
  error?: string;
  errorRequestId?: string;
  createdSizeId?: string;
  createdSizeCode?: string;
}

export const initialCreateSizeState: CreateSizeState = {};

/**
 * State модалки «Клонировать номенклатуру» (этап «Создать номенклатуру
 * по готовому лекалу», см. `apps/web/app/admin/patterns/[id]/clone-modal.tsx`
 * и `clonePatternAction` в `actions.ts`).
 *
 * При успехе action редиректит на новую карточку — `ok`/`successMessage`
 * в UI не отображаются (state используется только как «канал ошибок»).
 */
export interface ClonePatternState {
  ok?: boolean;
  successMessage?: string;
  error?: string;
  errorRequestId?: string;
}

export const initialClonePatternState: ClonePatternState = {};
