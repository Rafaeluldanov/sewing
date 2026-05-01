// State объекты для server actions из `./actions.ts`. Файл с
// `'use server'` обязан экспортировать только async-функции, поэтому
// initial-значения и связанные интерфейсы вынесены сюда (тот же
// паттерн, что у `/admin/routes/form-state.ts`).
//
// ВАЖНО: НЕ переносить эти значения обратно в `actions.ts` — это
// причина 500 на `/admin/tech-cards/new`: при импорте non-async
// экспорта из `'use server'`-модуля Webpack/Next.js подменяет его
// на server reference, и `useFormState(action, ИНИТ)` падает уже на
// SSR-рендере формы.
import type { TechCardTemplateDetailDto } from '@sewing/shared/tech-cards';

export interface TechCardFormState {
  ok?: boolean;
  successMessage?: string;
  error?: string;
  errorRequestId?: string;
}

export const initialTechCardFormState: TechCardFormState = {};

/**
 * Состояние формы загрузки изображения строки материала техкарты.
 * Используется как `useFormState`-state — UI рендерит сообщение об
 * успехе/ошибке рядом с кнопкой загрузки.
 *
 * Хранится здесь (а не в `actions.ts`), чтобы не нарушать правило
 * «`'use server'` экспортирует только async-функции». На client его
 * можно импортировать как обычный объект; server action сам этот
 * тип использует только в сигнатуре.
 */
export interface UploadMaterialImageState {
  ok?: boolean;
  error?: string;
  errorRequestId?: string;
  successMessage?: string;
  /**
   * Если успешно — обновлённая техкарта целиком (нужна минимальная
   * сигнатура для `useFormState`-обёртки; UI самостоятельно
   * перечитает страницу через `revalidatePath`).
   */
  template?: TechCardTemplateDetailDto;
}

export const initialUploadMaterialImageState: UploadMaterialImageState = {};
