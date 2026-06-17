'use server';

/**
 * Server action создания категории номенклатуры
 * (страница `/admin/pattern-categories/new`).
 *
 * Дизайн потока (см. ТЗ «Создание категории с иконкой»):
 *   1) `POST /api/pattern-categories` создаёт категорию и параметры
 *      одним запросом (атомарно на стороне backend).
 *   2) Если на форме выбран JPG/PNG-файл — `POST /api/pattern-categories/:id/icon`
 *      грузит иконку. Если этот шаг падает, категорию НЕ удаляем —
 *      пользователю показываем warning, чтобы он мог подгрузить иконку
 *      позже из карточки категории.
 *   3) После успеха редиректим на `/admin/patterns?categoryId=<id>`,
 *      чтобы менеджер сразу видел свою категорию в фильтре каталога.
 *
 * Никаких технических заголовков (`roleKey`, `inputType`, `iconKey`,
 * `sortOrder`) пользователю не показываем — UI рисует понятные ярлыки,
 * а action маппит их в технические поля для backend (см. `MATERIAL_ROLES`
 * и whitelist input-типов из `@sewing/shared/pattern-categories`).
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  CreatePatternCategorySchema,
  PatternCategoryParameterInputSchema,
  type CreatePatternCategoryDto,
  type PatternCategoryParameterInputDto,
} from '@sewing/shared/pattern-categories';
import { ApiRequestError, errorText } from '@/lib/api';
import {
  createPatternCategory,
  uploadPatternCategoryIcon,
} from '@/lib/pattern-categories-api';
import {
  initialCreatePatternCategoryPageState,
  type CreatePatternCategoryPageState,
} from './form-state';

function explainApiError(e: unknown): { error: string; requestId?: string } {
  if (e instanceof ApiRequestError) {
    return {
      error: errorText(e),
      requestId: e.requestId,
    };
  }
  return { error: 'Не удалось выполнить запрос' };
}

/**
 * Парсит блок «Параметры категории» из FormData. Форма пишет инпуты
 * как `param_<i>_<field>` (тот же контракт, что у удалённой модалки —
 * чтобы упростить миграцию и сохранить совместимость smoke-тестов).
 *
 * Важные поля:
 *   - `param_<i>_label`     — пользовательский label (видим);
 *   - `param_<i>_roleKey`   — материальная роль (whitelist
 *      `MATERIAL_ROLES` или custom через select); скрыто за
 *      пользовательским термином «Роль материала / Связь с техкартой»;
 *   - `param_<i>_inputType` — «Как заполнять» (whitelist
 *      `PATTERN_CATEGORY_PARAMETER_INPUT_TYPES`);
 *   - `param_<i>_unit`      — Единица (м² / шт / текст / пусто);
 *   - `param_<i>_isRequired`— Обязательный (checkbox);
 *   - `param_<i>_sortOrder` — порядок (UI его НЕ показывает,
 *      action подставляет `(i+1) * 10`).
 *
 * Пустые строки (без `roleKey` или `label`) игнорируем — менеджер
 * мог нажать «Добавить параметр» и не заполнить.
 */
function parseParametersFromForm(
  form: FormData,
): PatternCategoryParameterInputDto[] {
  const raw = String(form.get('__paramCount') ?? '').trim();
  const count = raw === '' ? 0 : Math.max(0, Math.min(50, Number(raw) || 0));
  const out: PatternCategoryParameterInputDto[] = [];
  for (let i = 0; i < count; i++) {
    const roleKey = String(form.get(`param_${i}_roleKey`) ?? '').trim();
    const label = String(form.get(`param_${i}_label`) ?? '').trim();
    if (roleKey === '' || label === '') continue;
    const inputType =
      (String(form.get(`param_${i}_inputType`) ?? '').trim() ||
        'AREA_M2_BY_SIZE') as PatternCategoryParameterInputDto['inputType'];
    const unitRaw = form.get(`param_${i}_unit`);
    const unit =
      unitRaw === null ? undefined : String(unitRaw).trim() || undefined;
    const isRequiredRaw = form.get(`param_${i}_isRequired`);
    const isRequired =
      isRequiredRaw === null
        ? undefined
        : isRequiredRaw === 'on' ||
          isRequiredRaw === 'true' ||
          isRequiredRaw === '1';
    // Подтип из таблицы TEEON.pdf (группа → параметр). Пусто = «Другое»
    // (ручной ввод названия) → subtypeKey остаётся null.
    const subtypeKeyRaw = form.get(`param_${i}_subtypeKey`);
    const subtypeKey =
      subtypeKeyRaw === null
        ? undefined
        : String(subtypeKeyRaw).trim() || undefined;
    // Sort order не показываем пользователю — порядок в UI задаёт
    // порядок строк, которые менеджер передвигает кнопками ↑/↓.
    const sortOrder = (i + 1) * 10;
    const candidate = {
      roleKey,
      subtypeKey,
      label,
      inputType,
      unit,
      isRequired,
      sortOrder,
    };
    const parsed = PatternCategoryParameterInputSchema.safeParse(candidate);
    if (parsed.success) {
      out.push(parsed.data);
    }
  }
  return out;
}

export async function createPatternCategoryPageAction(
  _prev: CreatePatternCategoryPageState,
  form: FormData,
): Promise<CreatePatternCategoryPageState> {
  const parameters = parseParametersFromForm(form);
  const dto: CreatePatternCategoryDto = {
    name: String(form.get('name') ?? '').trim(),
    description:
      form.get('description') === null
        ? undefined
        : String(form.get('description') ?? ''),
    parameters: parameters.length > 0 ? parameters : undefined,
  };
  const parsed = CreatePatternCategorySchema.safeParse(dto);
  if (!parsed.success) {
    return {
      ...initialCreatePatternCategoryPageState,
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные категории',
    };
  }

  let createdId: string | null = null;
  try {
    const created = await createPatternCategory(parsed.data);
    createdId = created.id;
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }

  // Загрузка иконки — отдельный multipart запрос. Если файла нет —
  // спокойно пропускаем; если есть и upload падает — категорию
  // оставляем созданной, пользователю покажем warning.
  const iconFile = form.get('iconFile');
  if (iconFile instanceof File && iconFile.size > 0 && createdId) {
    try {
      await uploadPatternCategoryIcon(createdId, iconFile, iconFile.name);
    } catch (e) {
      const x = explainApiError(e);
      revalidatePath('/admin/patterns');
      return {
        iconWarning: `Категория создана, но загрузить иконку не удалось: ${x.error}. Откройте карточку категории в каталоге, чтобы повторить загрузку.`,
        createdCategoryId: createdId,
        errorRequestId: x.requestId,
      };
    }
  }

  revalidatePath('/admin/patterns');
  // Редирект бросает специальное исключение, которое Next.js ловит и
  // отправляет ответ 30x; код после redirect не выполняется.
  redirect(`/admin/patterns?categoryId=${encodeURIComponent(createdId!)}`);
}
