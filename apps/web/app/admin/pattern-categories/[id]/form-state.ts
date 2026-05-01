/**
 * State server-action редактирования категории номенклатуры
 * (`apps/web/app/admin/pattern-categories/[id]/actions.ts`).
 *
 * Файл с `'use server'` обязан экспортировать только async-функции —
 * интерфейс и initial-state живут в отдельном модуле, как у соседних
 * форм (`new/form-state.ts`, `apps/web/app/admin/patterns/form-state.ts`).
 *
 * `editPatternCategoryPageAction` атомарно выполняет три шага:
 *   1) PATCH /api/pattern-categories/:id      — основные поля (name, description);
 *   2) PUT   /api/pattern-categories/:id/parameters — full-replace параметров;
 *   3) POST  /api/pattern-categories/:id/icon — JPG/PNG (если выбран файл).
 *
 * На любой ошибке action возвращает `error`/`errorRequestId` и не
 * редиректит. На успехе — `ok=true` + `successMessage`, страница
 * остаётся открытой, чтобы менеджер увидел свежее состояние.
 */

export interface EditPatternCategoryPageState {
  ok?: boolean;
  /** Сообщение об успехе («Категория обновлена», «Иконка загружена»). */
  successMessage?: string;
  /** Ошибка верхнего уровня (что-то из шагов PATCH/PUT/upload не прошло). */
  error?: string;
  /**
   * Категория сохранена, но загрузка иконки упала. Категория остаётся
   * в актуальном состоянии — пользователю показываем warning, чтобы он
   * мог повторить загрузку, не теряя правки полей/параметров.
   */
  iconWarning?: string;
  errorRequestId?: string;
}

export const initialEditPatternCategoryPageState: EditPatternCategoryPageState =
  {};
