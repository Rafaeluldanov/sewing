'use server';

/**
 * Server actions для inline-сценария «Создать изделие» в форме создания
 * заказа (`apps/web/app/admin/orders/new/create-product-modal.tsx`).
 *
 * Три точки делегирования:
 *   - `createPatternCategoryFromOrderModalAction` — заводит группу
 *     номенклатуры из inline-формы (без иконки/slug — backend сам
 *     сгенерирует slug). Возвращает свежий `PatternCategoryDto`.
 *   - `createTechCardFromOrderModalAction` — заводит техкарту с
 *     привязкой к выбранной группе номенклатуры; `materialLines`
 *     пред-заполняются на клиенте по параметрам категории
 *     (`inputType = AREA_M2_BY_SIZE`).
 *   - `loadCompatibleTechCardsAction` — обновлённый список техкарт +
 *     compatibility-метки после inline-создания.
 *
 * Контракты — те же Zod-схемы из `@sewing/shared`, что валидирует backend.
 */

import {
  CreatePatternCategorySchema,
  type CompatibleTechCardsResponseDto,
  type CreatePatternCategoryDto,
  type PatternCategoryDto,
} from '@sewing/shared/pattern-categories';
import {
  CreateTechCardSchema,
  type CreateTechCardDto,
  type TechCardTemplateDetailDto,
} from '@sewing/shared/tech-cards';
import { ApiRequestError } from '@/lib/api';
import {
  createPatternCategory,
  getCompatibleTechCards,
  getPatternCategory,
  uploadPatternCategoryIcon,
} from '@/lib/pattern-categories-api';
import { createTechCard } from '@/lib/tech-cards-api';

export interface InlineActionFailure {
  error: string;
}

export interface InlineCreatePatternCategoryResult {
  ok?: boolean;
  category?: PatternCategoryDto;
  error?: string;
}

export async function createPatternCategoryFromOrderModalAction(
  raw: unknown,
): Promise<InlineCreatePatternCategoryResult> {
  const parsed = CreatePatternCategorySchema.safeParse(raw);
  if (!parsed.success) {
    return {
      error:
        parsed.error.issues[0]?.message ??
        'Не удалось создать группу номенклатуры',
    };
  }
  const dto = parsed.data as CreatePatternCategoryDto;
  try {
    const created = await createPatternCategory(dto);
    return { ok: true, category: created };
  } catch (e) {
    return { error: explainApiError(e) };
  }
}

export interface InlineCreateTechCardResult {
  ok?: boolean;
  techCard?: TechCardTemplateDetailDto;
  error?: string;
}

export async function createTechCardFromOrderModalAction(
  raw: unknown,
): Promise<InlineCreateTechCardResult> {
  const parsed = CreateTechCardSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      error:
        parsed.error.issues[0]?.message ?? 'Не удалось создать техкарту',
    };
  }
  const dto = parsed.data as CreateTechCardDto;
  try {
    const created = await createTechCard(dto);
    return { ok: true, techCard: created };
  } catch (e) {
    return { error: explainApiError(e) };
  }
}

export async function loadCompatibleTechCardsAction(
  categoryId: string,
): Promise<CompatibleTechCardsResponseDto | { error: string }> {
  if (!categoryId) {
    return { error: 'Не указана группа номенклатуры' };
  }
  try {
    return await getCompatibleTechCards(categoryId);
  } catch (e) {
    return { error: explainApiError(e) };
  }
}

/**
 * Загружает полную карточку группы номенклатуры (с параметрами).
 * Используется UI модалки для построения колонок таблицы расходов
 * по активным AREA_M2_BY_SIZE-параметрам.
 */
export async function loadPatternCategoryDetailAction(
  categoryId: string,
): Promise<PatternCategoryDto | { error: string }> {
  if (!categoryId) {
    return { error: 'Не указана группа номенклатуры' };
  }
  try {
    return await getPatternCategory(categoryId);
  } catch (e) {
    return { error: explainApiError(e) };
  }
}

/**
 * Загрузить иконку группы номенклатуры из inline-сценария (вкладки
 * «+ Создать изделие» → окно «Добавить группу»). Принимает FormData
 * с полем `file` — клиентский код шлёт `File` напрямую, не дёргая
 * `apiFetch` на стороне браузера (тот использует `next/headers` и
 * доступен только в RSC / Server Actions).
 */
export async function uploadCategoryIconFromOrderModalAction(
  categoryId: string,
  formData: FormData,
): Promise<{ ok?: boolean; category?: PatternCategoryDto; error?: string }> {
  const file = formData.get('file');
  if (!(file instanceof File)) {
    return { error: 'Файл иконки не передан' };
  }
  try {
    const updated = await uploadPatternCategoryIcon(categoryId, file, file.name);
    return { ok: true, category: updated };
  } catch (e) {
    return { error: explainApiError(e) };
  }
}

function explainApiError(e: unknown): string {
  if (e instanceof ApiRequestError) {
    const prefix = e.code ? `[${e.code}] ` : '';
    return `${prefix}${e.message}`;
  }
  return 'Не удалось выполнить запрос';
}
