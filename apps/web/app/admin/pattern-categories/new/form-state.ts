/**
 * State server-action создания категории номенклатуры
 * (`apps/web/app/admin/pattern-categories/new/actions.ts`).
 *
 * Файл с `'use server'` обязан экспортировать только async-функции,
 * поэтому интерфейс и initial-state живут в отдельном модуле — тот же
 * паттерн, что у `apps/web/app/admin/patterns/form-state.ts`.
 */

export interface CreatePatternCategoryPageState {
  ok?: boolean;
  /**
   * Сообщение об успехе (на success-флоу мы редиректим на `/admin/patterns`,
   * поэтому пользователь его обычно не видит, но интерфейс совместим с
   * остальными формами админки и предохранён от обрыва редиректа).
   */
  successMessage?: string;
  /** Полная ошибка верхнего уровня (создание категории провалилось). */
  error?: string;
  /**
   * Категория создана, но загрузка иконки упала. Категория НЕ
   * откатывается — пользователь видит warning + кнопку «Пропустить
   * иконку и продолжить» / «Повторить». На MVP ограничимся текстом.
   */
  iconWarning?: string;
  /**
   * Если категория всё-таки создана, frontend получает её id —
   * это удобно для подсказки «Перейти к категории» при iconWarning.
   */
  createdCategoryId?: string;
  errorRequestId?: string;
}

export const initialCreatePatternCategoryPageState: CreatePatternCategoryPageState =
  {};
