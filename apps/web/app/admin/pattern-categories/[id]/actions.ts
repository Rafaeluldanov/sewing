'use server';

/**
 * Server actions страницы редактирования категории номенклатуры
 * (`/admin/pattern-categories/[id]`).
 *
 * Используем уже существующий REST-контракт (см.
 * `apps/api/src/modules/pattern-categories/pattern-categories.controller.ts`):
 *
 *   - PATCH  /api/pattern-categories/:id              — основные поля;
 *   - PUT    /api/pattern-categories/:id/parameters   — full-replace параметров;
 *   - POST   /api/pattern-categories/:id/icon         — JPG/PNG;
 *   - DELETE /api/pattern-categories/:id              — soft-archive (status=ARCHIVED).
 *
 * Никаких новых API-эндпоинтов и Prisma-миграций здесь не вводим
 * (см. требования: «Не менять Prisma», «Использовать уже существующие API»).
 *
 * Контракт FormData повторяет ту же `param_<i>_*`-схему, что у формы
 * создания категории (`apps/web/app/admin/pattern-categories/new`):
 * это упрощает миграцию пользователей между двумя UX-флоу и сокращает
 * разницу в smoke-тестах.
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  PatternCategoryParameterInputSchema,
  ReplacePatternCategoryParametersSchema,
  UpdatePatternCategorySchema,
  type PatternCategoryParameterInputDto,
  type ReplacePatternCategoryParametersDto,
  type UpdatePatternCategoryDto,
} from '@sewing/shared/pattern-categories';
import type { ActionResult } from '@/lib/action-result';
import { ApiRequestError, errorText } from '@/lib/api';
import {
  archivePatternCategory,
  deletePatternCategory,
  replacePatternCategoryParameters,
  updatePatternCategory,
  uploadPatternCategoryIcon,
} from '@/lib/pattern-categories-api';
import {
  initialEditPatternCategoryPageState,
  type EditPatternCategoryPageState,
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
 * Парсит блок «Параметры категории» из FormData. Контракт
 * `param_<i>_<field>` идентичен форме создания
 * (`apps/web/app/admin/pattern-categories/new/actions.ts`):
 *
 *   - `param_<i>_label`     — пользовательский label (обязателен);
 *   - `param_<i>_roleKey`   — материальная роль (whitelist `MATERIAL_ROLES`);
 *   - `param_<i>_inputType` — «Как заполнять» (whitelist `PATTERN_CATEGORY_PARAMETER_INPUT_TYPES`);
 *   - `param_<i>_unit`      — единица (м² / шт / "" для текста);
 *   - `param_<i>_isRequired`— чекбокс (передаётся как 'on'/'1');
 *   - `param_<i>_sortOrder` — UI не показывает, action подставляет
 *     `(i+1) * 10` по порядку строк.
 *
 * Пустые строки (без roleKey/label) игнорируем — менеджер мог нажать
 * «Добавить параметр» и не заполнить.
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
    // Sort order не показываем пользователю — порядок ввода = порядок
    // отображения. Кратность 10 оставляет место для будущих ручных
    // «протиснуть между» без смены остальных параметров.
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

/**
 * Главный action страницы — «Сохранить» (Block actions).
 *
 * Шаги (последовательно, останавливаемся на первой ошибке):
 *   1) PATCH /pattern-categories/:id            — name + description;
 *   2) PUT   /pattern-categories/:id/parameters — full-replace набор параметров;
 *   3) POST  /pattern-categories/:id/icon       — если был выбран JPG/PNG.
 *
 * После успеха — `revalidatePath` на `/admin/patterns` и
 * `/admin/pattern-categories/[id]` (фильтр чипов в списке номенклатуры
 * подтянет новое имя/иконку), возвращаем `ok=true` для UI-сообщения.
 */
export async function editPatternCategoryPageAction(
  id: string,
  _prev: EditPatternCategoryPageState,
  form: FormData,
): Promise<EditPatternCategoryPageState> {
  // ---- 1. PATCH основное -------------------------------------------------
  const updateDto: UpdatePatternCategoryDto = {
    name: String(form.get('name') ?? '').trim(),
    description:
      form.get('description') === null
        ? undefined
        : String(form.get('description') ?? ''),
  };
  const updateParsed = UpdatePatternCategorySchema.safeParse(updateDto);
  if (!updateParsed.success) {
    return {
      ...initialEditPatternCategoryPageState,
      error:
        updateParsed.error.issues[0]?.message ?? 'Невалидные данные категории',
    };
  }

  try {
    await updatePatternCategory(id, updateParsed.data);
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }

  // ---- 2. PUT параметры (full-replace) -----------------------------------
  const parameters = parseParametersFromForm(form);
  const replaceDto: ReplacePatternCategoryParametersDto = { parameters };
  const replaceParsed =
    ReplacePatternCategoryParametersSchema.safeParse(replaceDto);
  if (!replaceParsed.success) {
    return {
      error:
        replaceParsed.error.issues[0]?.message ??
        'Невалидные параметры категории',
    };
  }
  try {
    await replacePatternCategoryParameters(id, replaceParsed.data);
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }

  // ---- 3. POST иконка (если файл выбран) --------------------------------
  // Иконка — отдельный multipart-запрос. Если файл не выбран, просто
  // пропускаем шаг. Если upload падает — категория и параметры уже
  // сохранены, поэтому возвращаем warning, чтобы менеджер мог повторить
  // загрузку без потери остальных правок.
  const iconFile = form.get('iconFile');
  if (iconFile instanceof File && iconFile.size > 0) {
    try {
      await uploadPatternCategoryIcon(id, iconFile, iconFile.name);
    } catch (e) {
      const x = explainApiError(e);
      revalidatePath('/admin/patterns');
      revalidatePath(`/admin/pattern-categories/${id}`);
      return {
        ok: true,
        successMessage: 'Категория обновлена',
        iconWarning: `Не удалось загрузить иконку: ${x.error}. Попробуйте ещё раз — основные правки уже сохранены.`,
        errorRequestId: x.requestId,
      };
    }
  }

  revalidatePath('/admin/patterns');
  revalidatePath(`/admin/pattern-categories/${id}`);
  return {
    ok: true,
    successMessage: 'Категория обновлена',
  };
}

/**
 * Архивировать категорию (soft-delete, `status = ARCHIVED`). Backend
 * самостоятельно валидирует, можно ли архивировать (например, если
 * есть активные лекала, кидает PATTERN_CATEGORY_INACTIVE / 409).
 *
 * После успеха редиректим на `/admin/patterns` — откуда пользователь
 * пришёл, чтобы он мог сразу увидеть, что категории больше нет в
 * фильтре.
 */
export async function archivePatternCategoryPageAction(
  id: string,
  _prev: EditPatternCategoryPageState,
  _form: FormData,
): Promise<EditPatternCategoryPageState> {
  try {
    await archivePatternCategory(id);
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
  revalidatePath('/admin/patterns');
  revalidatePath(`/admin/pattern-categories/${id}`);
  // Редирект бросает специальное исключение Next.js — код после не выполняется.
  redirect('/admin/patterns');
}

/**
 * Hard-delete архивной категории
 * (`DELETE /api/pattern-categories/:id/permanent?cascade=1`). Зовётся
 * из кнопки «Удалить навсегда» на карточке (видна только для
 * `status = ARCHIVED`).
 *
 * Флаг `cascade` — согласие на каскад по содержимому: номенклатура
 * группы уезжает в архив, техкарты остаются без группы (кнопка
 * предупреждает об этом в `window.confirm` со счётчиками).
 *
 * Ошибку ВОЗВРАЩАЕМ, а не бросаем: в prod-сборке Next.js подменяет
 * текст исключения из server action на digest-заглушку «An error
 * occurred in the Server Components render…», и причина отказа до
 * менеджера не доезжает (см. `@/lib/action-result`).
 *
 * Без `redirect`: карточки категории после удаления нет, навигацию на
 * список делает client-кнопка (`router.push`) после успешного `await`.
 */
export async function deletePatternCategoryPageAction(
  id: string,
): Promise<ActionResult> {
  try {
    await deletePatternCategory(id, { cascade: true });
  } catch (e) {
    // Только человекочитаемый текст из 409 (без технического кода) —
    // backend сам объясняет «почему нельзя и как удалить правильно».
    return {
      ok: false,
      error:
        e instanceof ApiRequestError
          ? e.message
          : 'Не удалось удалить категорию. Попробуйте обновить страницу и повторить.',
    };
  }
  revalidatePath('/admin/patterns');
  // Каскад увёз номенклатуру группы в архив — карточки номенклатуры
  // тоже устарели (статус + пропавшая группа).
  revalidatePath('/admin/patterns/[id]', 'page');
  return { ok: true };
}
