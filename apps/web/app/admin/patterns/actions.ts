'use server';

/**
 * Server actions модуля «Лекала».
 *
 * RBAC — на backend (`@Roles('ADMIN', 'SHOP_MANAGER')`). Frontend
 * дополнительно скрывает раздел из sidebar через
 * `NEXT_PUBLIC_FEATURE_PATTERNS=1` (см. `components/admin-sidebar.tsx`).
 *
 * ВАЖНО: файл с `'use server'` может экспортировать только async
 * функции — типы и initial state живут в `./form-state.ts`.
 */

import { revalidatePath, revalidateTag } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  ClonePatternSchema,
  CreatePatternSchema,
  MATERIAL_ROLES,
  ReplacePatternItemParameterNormInputSchema,
  ReplacePatternItemParameterNormsSchema,
  ReplacePatternItemSizeParameterValueInputSchema,
  ReplacePatternItemSizeParameterValuesSchema,
  ReplacePatternMaterialAreaInputSchema,
  UpdatePatternSchema,
  type ClonePatternDto,
  type CreatePatternDto,
  type MaterialRole,
  type ReplacePatternItemParameterNormInputDto,
  type ReplacePatternItemSizeParameterValueInputDto,
  type ReplacePatternMaterialAreaInputDto,
  type UpdatePatternDto,
} from '@sewing/shared/patterns';
import {
  CreatePatternCategorySchema,
  PatternCategoryParameterInputSchema,
  ReplacePatternCategoryParametersSchema,
  type CreatePatternCategoryDto,
  type PatternCategoryParameterInputDto,
} from '@sewing/shared/pattern-categories';
import { CreateSizeSchema } from '@sewing/shared/sizes';
import { createSize } from '@/lib/orders-api';
import { ApiRequestError, errorText } from '@/lib/api';
import {
  archivePatternSizeFile,
  clonePattern,
  createPattern,
  deletePattern,
  deletePatternSizeFile,
  restorePatterns,
  restorePatternSizeFile,
  replacePatternItemParameterNorms,
  replacePatternItemSizeParameterValues,
  replacePatternMaterialAreas,
  updatePattern,
  uploadPatternPreview,
  uploadPatternSizeFile,
} from '@/lib/patterns-api';
import {
  archivePatternCategory,
  createPatternCategory,
  deletePatternCategory,
  getPatternCategory,
  replacePatternCategoryParameters,
  updatePatternCategory,
} from '@/lib/pattern-categories-api';
import type {
  ClonePatternState,
  CreatePatternCategoryState,
  CreatePatternState,
  CreateSizeState,
  MaterialAreasState,
  ParameterNormsState,
  ReplaceCategoryParametersState,
  SizeParameterValuesState,
  UpdatePatternState,
  UploadPatternFileState,
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

function buildCreateDto(form: FormData): CreatePatternDto {
  return {
    name: String(form.get('name') ?? '').trim(),
    article: String(form.get('article') ?? '').trim(),
    categoryCode:
      form.get('categoryCode') === null
        ? undefined
        : String(form.get('categoryCode') ?? ''),
    categoryId:
      form.get('categoryId') === null
        ? undefined
        : String(form.get('categoryId') ?? ''),
    description:
      form.get('description') === null
        ? undefined
        : String(form.get('description') ?? ''),
    status:
      form.get('status') === null
        ? undefined
        : (String(form.get('status') ?? '') as CreatePatternDto['status']),
  };
}

function buildUpdateDto(form: FormData): UpdatePatternDto {
  // Семантика идентична `buildUpdateDto` для клиентов: поле есть в
  // форме → передаём (даже пустую строку, которая через preprocess
  // превратится в `null`); поля нет → undefined → backend не трогает.
  const dto: Partial<UpdatePatternDto> = {};
  if (form.get('name') !== null) {
    dto.name = String(form.get('name') ?? '').trim();
  }
  if (form.get('article') !== null) {
    dto.article = String(form.get('article') ?? '').trim();
  }
  if (form.get('categoryCode') !== null) {
    dto.categoryCode = String(form.get('categoryCode') ?? '');
  }
  if (form.get('categoryId') !== null) {
    dto.categoryId = String(form.get('categoryId') ?? '');
  }
  if (form.get('description') !== null) {
    dto.description = String(form.get('description') ?? '');
  }
  if (form.get('status') !== null) {
    dto.status = String(
      form.get('status') ?? '',
    ) as UpdatePatternDto['status'];
  }
  return dto as UpdatePatternDto;
}

export async function createPatternAction(
  _prev: CreatePatternState,
  form: FormData,
): Promise<CreatePatternState> {
  const parsed = CreatePatternSchema.safeParse(buildCreateDto(form));
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
    };
  }
  let createdId: string | null = null;
  try {
    const created = await createPattern(parsed.data);
    createdId = created.id;
    revalidatePath('/admin/patterns');
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
  if (createdId) {
    redirect(`/admin/patterns/${createdId}`);
  }
  return { ok: true };
}

/**
 * Клонирование номенклатуры (этап «Создать номенклатуру по готовому
 * лекалу»). Принимает FormData с `name` / `article` (оба опциональны;
 * пустые/отсутствующие поля = «backend, подбери сам»).
 *
 * При успехе делает `redirect('/admin/patterns/<newId>')` —
 * `redirect()` бросает исключение, поэтому всё, что идёт после
 * успешного `clonePattern`, не исполнится. State используется только
 * как «канал ошибок».
 */
export async function clonePatternAction(
  sourceId: string,
  _prev: ClonePatternState,
  form: FormData,
): Promise<ClonePatternState> {
  const nameRaw = form.get('name');
  const articleRaw = form.get('article');
  const candidate: ClonePatternDto = {
    name:
      nameRaw === null
        ? undefined
        : String(nameRaw).trim() === ''
          ? undefined
          : String(nameRaw),
    article:
      articleRaw === null
        ? undefined
        : String(articleRaw).trim() === ''
          ? undefined
          : String(articleRaw),
  };
  const parsed = ClonePatternSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
    };
  }
  let createdId: string | null = null;
  try {
    const created = await clonePattern(sourceId, parsed.data);
    createdId = created.id;
    revalidatePath('/admin/patterns');
    revalidatePath(`/admin/patterns/${sourceId}`);
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
  if (createdId) {
    redirect(`/admin/patterns/${createdId}`);
  }
  return { ok: true };
}

export async function updatePatternAction(
  patternId: string,
  _prev: UpdatePatternState,
  form: FormData,
): Promise<UpdatePatternState> {
  const parsed = UpdatePatternSchema.safeParse(buildUpdateDto(form));
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
    };
  }
  try {
    await updatePattern(patternId, parsed.data);
    revalidatePath('/admin/patterns');
    revalidatePath(`/admin/patterns/${patternId}`);
    return { ok: true, successMessage: 'Сохранено.' };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}

/**
 * Soft-archive номенклатуры — переводим `status = ARCHIVED` через
 * существующий `PATCH /api/patterns/:id` (отдельного DELETE-эндпоинта
 * у лекал нет; `UpdatePatternSchema.status` уже принимает `ARCHIVED`).
 *
 * Карточку из БД НЕ удаляем: snapshot-привязки заказов/паспортов
 * (`Order.patternItemId`, `ConstructorTask`, нормы) сохраняются, лекало
 * просто уходит из active-выборок (`listPatterns({ status: 'ACTIVE' })`),
 * поэтому перестаёт предлагаться в формах заказа / техкарты.
 *
 * Без `redirect`: вызывается из client-кнопки через `useTransition`
 * (см. `archive-pattern-button.tsx`), а `redirect()` бросает
 * `NEXT_REDIRECT`, который попал бы в `catch` кнопки и показался как
 * ошибка. После `revalidatePath` карточка перерисуется со статусом
 * «Архив». Ошибки пробрасываем `Error`-ом — кнопка покажет их inline.
 */
export async function archivePatternAction(patternId: string): Promise<void> {
  try {
    await updatePattern(patternId, { status: 'ARCHIVED' });
  } catch (e) {
    throw new Error(explainApiError(e).error);
  }
  revalidatePath('/admin/patterns');
  revalidatePath(`/admin/patterns/${patternId}`);
}

/**
 * Вернуть номенклатуру из архива с карточки (обратная операция к
 * `archivePatternAction`). Идём через `POST /api/patterns/restore`, а не
 * через `PATCH status = ACTIVE`, чтобы правило «куда возвращать» жило в
 * одном месте на backend: карточка с незакрытой задачей конструктора
 * возвращается в `DRAFT`, остальные — в `ACTIVE` (см.
 * `PatternsService.restoreMany`). Та же кнопка есть во вкладке «Архив»
 * списка `/admin/patterns`.
 */
export async function restorePatternAction(patternId: string): Promise<void> {
  try {
    await restorePatterns([patternId]);
  } catch (e) {
    throw new Error(explainApiError(e).error);
  }
  revalidatePath('/admin/patterns');
  revalidatePath(`/admin/patterns/${patternId}`);
}

/**
 * Удаление категории номенклатуры «в один клик» прямо со списка
 * `/admin/patterns` (чип-фильтр).
 *
 * Backend разрешает hard-delete только для архивной категории
 * (`status = ARCHIVED`) и блокирует, если на неё ссылаются
 * лекала/техкарты (409 `PATTERN_CATEGORY_DELETE_FORBIDDEN`). Чтобы у
 * менеджера была одна понятная кнопка «Удалить», оркеструем тут:
 *
 *   1) узнаём текущий статус (`GET /pattern-categories/:id`);
 *   2) если категория активна — архивируем
 *      (`DELETE /pattern-categories/:id`, soft);
 *   3) удаляем навсегда (`DELETE /pattern-categories/:id/permanent`).
 *
 * Если шаг 3 заблокирован (категорию используют лекала/техкарты), а мы
 * только что её архивировали на шаге 2 — возвращаем статус обратно в
 * `ACTIVE`, чтобы категория не «исчезла» из активного фильтра, и
 * пробрасываем человекочитаемый текст 409. Так инвариант сохраняется:
 * категория либо удалена, либо осталась ровно в том статусе, что была.
 */
export async function deleteCategoryFromPatternsAction(
  categoryId: string,
): Promise<void> {
  let wasActive = false;
  try {
    const before = await getPatternCategory(categoryId);
    if (before.status !== 'ARCHIVED') {
      wasActive = true;
      await archivePatternCategory(categoryId);
    }
    await deletePatternCategory(categoryId);
  } catch (e) {
    // Откатываем транзитный архив, чтобы активная категория не пропала.
    if (wasActive) {
      try {
        await updatePatternCategory(categoryId, { status: 'ACTIVE' });
      } catch {
        // best-effort: если откат не удался, категория останется в
        // архиве — её всё ещё видно в блоке «Архив» и можно вернуть.
      }
    }
    // Только человекочитаемый текст из 409 (без технического кода) —
    // backend сам объясняет «почему нельзя и как удалить правильно».
    throw new Error(
      e instanceof ApiRequestError
        ? e.message
        : 'Не удалось удалить категорию. Попробуйте обновить страницу и повторить.',
    );
  }
  revalidatePath('/admin/patterns');
}

/**
 * Hard-delete архивной номенклатуры (`DELETE /api/patterns/:id/permanent`).
 * Зовётся из кнопки «Удалить навсегда» на карточке (видна только для
 * `status = ARCHIVED`). Backend блокирует удаление, если на лекало
 * ссылаются заказы (409 `PATTERN_DELETE_FORBIDDEN`) — пробрасываем
 * текст `Error`-ом, кнопка покажет его inline.
 *
 * Без `redirect`: карточки лекала после удаления нет, навигацию на
 * список делает client-кнопка (`router.push`) после успешного `await`.
 */
export async function deletePatternAction(patternId: string): Promise<void> {
  try {
    await deletePattern(patternId);
  } catch (e) {
    // Только человекочитаемый текст из 409 (без технического кода) —
    // backend сам объясняет «почему нельзя и как удалить правильно».
    throw new Error(
      e instanceof ApiRequestError
        ? e.message
        : 'Не удалось удалить номенклатуру. Попробуйте обновить страницу и повторить.',
    );
  }
  revalidatePath('/admin/patterns');
}

/**
 * Загрузка превью карточки лекала. На input-е стоит accept-фильтр,
 * но финальная валидация (расширение / размер) идёт на backend
 * (`PatternsStorageService.savePreview`).
 */
export async function uploadPatternPreviewAction(
  patternId: string,
  _prev: UploadPatternFileState,
  form: FormData,
): Promise<UploadPatternFileState> {
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return { error: 'Выберите файл превью.' };
  }
  try {
    await uploadPatternPreview(patternId, file, file.name);
    revalidatePath('/admin/patterns');
    revalidatePath(`/admin/patterns/${patternId}`);
    return { ok: true, successMessage: 'Превью обновлено.' };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}

/**
 * Загрузка файла лекала (PDF/PLT/DXF/PLO) по конкретному размеру. `sizeId`
 * приходит скрытым полем формы. Файл НЕобязателен: без него размер
 * добавляется как заглушка (fileUrl = null), файл догружается позже.
 * Backend сам выберет следующую версию.
 */
export async function uploadPatternSizeFileAction(
  patternId: string,
  _prev: UploadPatternFileState,
  form: FormData,
): Promise<UploadPatternFileState> {
  const sizeId = String(form.get('sizeId') ?? '').trim();
  if (!sizeId) return { error: 'Не выбран размер.' };
  const formFile = form.get('file');
  const file =
    formFile instanceof File && formFile.size > 0 ? formFile : null;
  try {
    await uploadPatternSizeFile(patternId, sizeId, file, file?.name);
    revalidatePath('/admin/patterns');
    revalidatePath(`/admin/patterns/${patternId}`);
    return {
      ok: true,
      successMessage: file ? 'Файл загружен.' : 'Размер добавлен без файла.',
    };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}

/**
 * Архивация конкретной версии DXF (`status = ARCHIVED`). На MVP
 * физический файл с диска не удаляем — менеджер видит архивные
 * записи в истории, а не безвозвратно теряет загрузку (см.
 * `PatternsService.archiveSizeFile`).
 *
 * Возвращает `void`, потому что вызывается из `<form action={…}>`
 * без `useFormState` (см. `archive-file-form.tsx`). Ошибки
 * логируются и подавляются — UI ловит их через follow-up GET после
 * `revalidatePath` (запись остаётся `ACTIVE`, кнопка снова доступна).
 */
export async function archivePatternSizeFileAction(
  patternId: string,
  sizeId: string,
  fileId: string,
  _form?: FormData,
): Promise<void> {
  try {
    await archivePatternSizeFile(patternId, sizeId, fileId);
  } catch (e) {
    // Намеренно глушим: action вызывается из inline-кнопки таблицы
    // без отдельного state. Если архивация не удалась — следующий
    // рендер карточки покажет файл всё ещё активным.
    // eslint-disable-next-line no-console
    console.error('archivePatternSizeFile failed', explainApiError(e));
  }
  revalidatePath('/admin/patterns');
  revalidatePath(`/admin/patterns/${patternId}`);
}

/**
 * Восстановление архивного файла размера (`ARCHIVED → ACTIVE`).
 * Обратная к `archivePatternSizeFileAction`. Вызывается из inline-
 * кнопки «Восстановить» в архивной вкладке блока «Файлы по размерам».
 *
 * Бросает `Error` — кнопка (`restore-file-form.tsx`) ловит его через
 * `useTransition` и показывает inline. После успеха `revalidatePath`
 * перерисует карточку: файл вернётся в активную вкладку.
 */
export async function restorePatternSizeFileAction(
  patternId: string,
  sizeId: string,
  fileId: string,
): Promise<void> {
  try {
    await restorePatternSizeFile(patternId, sizeId, fileId);
  } catch (e) {
    throw new Error(explainApiError(e).error);
  }
  revalidatePath('/admin/patterns');
  revalidatePath(`/admin/patterns/${patternId}`);
}

/**
 * Жёсткое удаление файла размера (запись + файл с диска),
 * безвозвратно. Вызывается из кнопки-корзины с подтверждением
 * (`delete-file-form.tsx`) в обеих вкладках блока «Файлы по размерам».
 *
 * Бросает `Error` — кнопка ловит его через `useTransition` и
 * показывает inline. После успеха `revalidatePath` перерисует
 * карточку без удалённого файла.
 */
export async function deletePatternSizeFileAction(
  patternId: string,
  sizeId: string,
  fileId: string,
): Promise<void> {
  try {
    await deletePatternSizeFile(patternId, sizeId, fileId);
  } catch (e) {
    throw new Error(explainApiError(e).error);
  }
  revalidatePath('/admin/patterns');
  revalidatePath(`/admin/patterns/${patternId}`);
}

/**
 * Bulk-replace «Площадей материалов». Форма отправляет один input
 * `area_<sizeId>_<role>` на каждую ячейку; пустые ячейки пропускаются,
 * валидация значения (`> 0`, ≤ 4 знака после точки) идёт через
 * Zod-схему `ReplacePatternMaterialAreaInputSchema`.
 *
 * Этап «Категории номенклатуры»: форма дополнительно отправляет
 * скрытый `__roleKeys` с CSV-списком ролей, по которым сейчас
 * рендерится таблица (категорийные `roleKey` или fallback на
 * `MATERIAL_ROLES`). Action итерирует только по этим ролям —
 * `MaterialRoleSchema` валидирует только глобальные роли, поэтому
 * при наличии категорийных ролей мы пропускаем `MaterialRole`
 * валидацию на клиенте и оставляем её на бэкенде (там роль
 * проверяется по списку параметров категории).
 */
export async function replacePatternMaterialAreasAction(
  patternId: string,
  _prev: MaterialAreasState,
  form: FormData,
): Promise<MaterialAreasState> {
  const areas: ReplacePatternMaterialAreaInputDto[] = [];
  const sizeIdsCsv = String(form.get('__sizeIds') ?? '').trim();
  const sizeIds = sizeIdsCsv ? sizeIdsCsv.split(',').filter(Boolean) : [];

  // Категорийные роли: если форма прислала roleKeys (этап «Категории
  // номенклатуры»), используем их; иначе — fallback на глобальные
  // MATERIAL_ROLES (старые лекала без category).
  const roleKeysCsv = String(form.get('__roleKeys') ?? '').trim();
  const roles: string[] = roleKeysCsv
    ? roleKeysCsv.split(',').map((r) => r.trim()).filter(Boolean)
    : (MATERIAL_ROLES as readonly string[]).slice();

  for (const sizeId of sizeIds) {
    for (const role of roles) {
      const key = `area_${sizeId}_${role}`;
      const raw = form.get(key);
      if (raw === null) continue;
      const trimmed = String(raw).trim();
      if (trimmed === '') continue;
      // Валидируем только areaM2/sizeId/comment — `materialRole`
      // принимаем как есть, т.к. shared schema enforce-ит только
      // глобальные `MATERIAL_ROLES`. Для категорийных roleKey-ов
      // валидация по whitelist делается на бэкенде.
      const parsed = ReplacePatternMaterialAreaInputSchema.safeParse({
        sizeId,
        materialRole: role as MaterialRole,
        areaM2: trimmed,
        comment: undefined,
      });
      if (!parsed.success) {
        // Если упали именно на materialRole (категорийная роль не
        // в `MATERIAL_ROLES`), всё равно отправим на бэкенд — он
        // валидирует по параметрам категории.
        const roleIssue = parsed.error.issues.find((i) =>
          i.path.includes('materialRole'),
        );
        if (
          roleIssue &&
          parsed.error.issues.length === 1 &&
          roleKeysCsv !== ''
        ) {
          areas.push({
            sizeId,
            materialRole: role as MaterialRole,
            areaM2: trimmed,
            comment: null,
          });
          continue;
        }
        return {
          error: `Размер ${sizeId} / ${role}: ${
            parsed.error.issues[0]?.message ?? 'некорректное значение'
          }`,
        };
      }
      areas.push(parsed.data);
    }
  }
  try {
    await replacePatternMaterialAreas(patternId, areas);
    revalidatePath('/admin/patterns');
    revalidatePath(`/admin/patterns/${patternId}`);
    return { ok: true, successMessage: 'Площади сохранены.' };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}

/**
 * Bulk-replace «Фурнитуры и норм» лекала
 * (`PUT /api/patterns/:id/parameter-norms`). Этап «Фурнитура и нормы».
 *
 * Форма отправляет:
 *   - скрытый `__parameterIds` — CSV из `categoryParameterId`
 *     (id параметров категории с `inputType = QTY_PER_ITEM`),
 *     по которым сейчас рендерятся строки;
 *   - на каждый параметр: `norm_<id>_qtyPerItem`, опционально
 *     `norm_<id>_unit` и `norm_<id>_comment`.
 *
 * Семантика «пустого qty»:
 *   - если `qtyPerItem` пуст / `0` — норма НЕ отправляется на
 *     backend, и сервис её удалит (full-replace очищает все
 *     QTY_PER_ITEM-нормы и пишет только переданные).
 *
 * `unit` от формы сейчас пустой / read-only — backend всё равно
 * подставит `parameter.unit` как default, см. сервис.
 */
export async function replacePatternItemParameterNormsAction(
  patternId: string,
  _prev: ParameterNormsState,
  form: FormData,
): Promise<ParameterNormsState> {
  const norms: ReplacePatternItemParameterNormInputDto[] = [];
  const idsCsv = String(form.get('__parameterIds') ?? '').trim();
  const parameterIds = idsCsv
    ? idsCsv.split(',').map((s) => s.trim()).filter(Boolean)
    : [];

  for (const parameterId of parameterIds) {
    const qtyRaw = form.get(`norm_${parameterId}_qtyPerItem`);
    if (qtyRaw === null) continue;
    const qty = String(qtyRaw).trim();
    if (qty === '') continue;
    const unitRaw = form.get(`norm_${parameterId}_unit`);
    const unit =
      unitRaw === null ? undefined : String(unitRaw).trim() || null;
    const commentRaw = form.get(`norm_${parameterId}_comment`);
    const comment =
      commentRaw === null ? undefined : String(commentRaw);
    const parsed = ReplacePatternItemParameterNormInputSchema.safeParse({
      categoryParameterId: parameterId,
      qtyPerItem: qty,
      unit,
      comment,
    });
    if (!parsed.success) {
      return {
        error: `Параметр ${parameterId}: ${
          parsed.error.issues[0]?.message ?? 'некорректное значение'
        }`,
      };
    }
    norms.push(parsed.data);
  }

  // Дополнительно валидируем массив целиком (дубликаты и т.п.).
  const arrayParsed = ReplacePatternItemParameterNormsSchema.safeParse({
    norms,
  });
  if (!arrayParsed.success) {
    return {
      error: arrayParsed.error.issues[0]?.message ?? 'Невалидные данные норм',
    };
  }

  try {
    await replacePatternItemParameterNorms(patternId, arrayParsed.data.norms);
    revalidatePath('/admin/patterns');
    revalidatePath(`/admin/patterns/${patternId}`);
    return { ok: true, successMessage: 'Нормы фурнитуры сохранены.' };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}

/**
 * Bulk-replace значений «погонных метров по размерам» лекала
 * (`PUT /api/patterns/:id/size-parameter-values`). Этап «Погонные
 * метры по размерам».
 *
 * Форма отправляет:
 *   - скрытый `__sizeIds`      — CSV из `Size.id` (активные размеры
 *     номенклатуры);
 *   - скрытый `__parameterIds` — CSV из `categoryParameterId`
 *     (id параметров категории с `inputType = LINEAR_M_BY_SIZE`);
 *   - на каждую ячейку: `value_<parameterId>_<sizeId>`.
 *
 * Семантика «пустой ячейки»:
 *   - если `value` пуст / `0` — значение НЕ отправляется на backend,
 *     и сервис его удалит (full-replace очищает все
 *     LINEAR_M_BY_SIZE-значения в «допустимом окне» и пишет только
 *     переданные).
 */
export async function replacePatternItemSizeParameterValuesAction(
  patternId: string,
  _prev: SizeParameterValuesState,
  form: FormData,
): Promise<SizeParameterValuesState> {
  const values: ReplacePatternItemSizeParameterValueInputDto[] = [];

  const sizeIdsCsv = String(form.get('__sizeIds') ?? '').trim();
  const sizeIds = sizeIdsCsv ? sizeIdsCsv.split(',').filter(Boolean) : [];

  const parameterIdsCsv = String(form.get('__parameterIds') ?? '').trim();
  const parameterIds = parameterIdsCsv
    ? parameterIdsCsv.split(',').filter(Boolean)
    : [];

  for (const parameterId of parameterIds) {
    for (const sizeId of sizeIds) {
      const raw = form.get(`value_${parameterId}_${sizeId}`);
      if (raw === null) continue;
      const trimmed = String(raw).trim();
      if (trimmed === '') continue;
      const parsed = ReplacePatternItemSizeParameterValueInputSchema.safeParse({
        categoryParameterId: parameterId,
        sizeId,
        value: trimmed,
        unit: undefined,
        comment: undefined,
      });
      if (!parsed.success) {
        return {
          error: `Параметр ${parameterId} / размер ${sizeId}: ${
            parsed.error.issues[0]?.message ?? 'некорректное значение'
          }`,
        };
      }
      values.push(parsed.data);
    }
  }

  // Валидация массива целиком (защита от дубликатов, лимит длины).
  const arrayParsed = ReplacePatternItemSizeParameterValuesSchema.safeParse({
    values,
  });
  if (!arrayParsed.success) {
    return {
      error:
        arrayParsed.error.issues[0]?.message ?? 'Невалидные данные',
    };
  }

  try {
    await replacePatternItemSizeParameterValues(
      patternId,
      arrayParsed.data.values,
    );
    revalidatePath('/admin/patterns');
    revalidatePath(`/admin/patterns/${patternId}`);
    return { ok: true, successMessage: 'Погонные метры сохранены.' };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}

// ---------------------------------------------------------------------------
// Категории номенклатуры (этап «Категории номенклатуры»)
// ---------------------------------------------------------------------------

/**
 * Создание категории с параметрами. Параметры приходят как несколько
 * групп инпутов:
 *   `param_<i>_roleKey`, `param_<i>_label`, `param_<i>_inputType`,
 *   `param_<i>_unit`, `param_<i>_isRequired`, `param_<i>_sortOrder`
 * (`__paramCount` = верхняя граница). Пустые / без `roleKey` / без
 * `label` строки игнорируются.
 */
export async function createPatternCategoryAction(
  _prev: CreatePatternCategoryState,
  form: FormData,
): Promise<CreatePatternCategoryState> {
  const parameters = parseParametersFromForm(form);
  const dto: CreatePatternCategoryDto = {
    name: String(form.get('name') ?? '').trim(),
    iconKey: String(
      form.get('iconKey') ?? 'SHIRT',
    ) as CreatePatternCategoryDto['iconKey'],
    slug:
      form.get('slug') === null
        ? undefined
        : String(form.get('slug') ?? '').trim() || undefined,
    description:
      form.get('description') === null
        ? undefined
        : String(form.get('description') ?? ''),
    parameters: parameters.length > 0 ? parameters : undefined,
  };
  const parsed = CreatePatternCategorySchema.safeParse(dto);
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные категории',
    };
  }
  try {
    await createPatternCategory(parsed.data);
    revalidatePath('/admin/patterns');
    return { ok: true, successMessage: 'Категория создана.' };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}

/**
 * Bulk-replace параметров существующей категории
 * (`PUT /api/pattern-categories/:id/parameters`). Тот же формат
 * `param_<i>_*` инпутов, что и при создании.
 */
export async function replacePatternCategoryParametersAction(
  categoryId: string,
  _prev: ReplaceCategoryParametersState,
  form: FormData,
): Promise<ReplaceCategoryParametersState> {
  const parameters = parseParametersFromForm(form);
  const parsed = ReplacePatternCategoryParametersSchema.safeParse({
    parameters,
  });
  if (!parsed.success) {
    return {
      error:
        parsed.error.issues[0]?.message ?? 'Невалидные параметры категории',
    };
  }
  try {
    await replacePatternCategoryParameters(categoryId, parsed.data);
    revalidatePath('/admin/patterns');
    return { ok: true, successMessage: 'Параметры категории сохранены.' };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}

/**
 * Soft-archive категории (`DELETE /api/pattern-categories/:id`).
 * Карточки лекал с этой категорией остаются в БД и продолжают
 * отображаться с пометкой «архивная категория».
 */
export async function archivePatternCategoryAction(
  categoryId: string,
  _form?: FormData,
): Promise<void> {
  try {
    await archivePatternCategory(categoryId);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('archivePatternCategory failed', explainApiError(e));
  }
  revalidatePath('/admin/patterns');
}

// ---------------------------------------------------------------------------
// Создание размера в общем справочнике (этап «Создание пользовательского
// размера», см. ТЗ; backend — `POST /api/sizes`,
// `apps/api/src/modules/sizes/*`).
// ---------------------------------------------------------------------------

/**
 * Server action модалки «Создать размер» на карточке номенклатуры
 * (`/admin/patterns/[id]`).
 *
 * Контракт:
 *   - принимает `FormData` с полем `code` (строка размера, как ввёл
 *     пользователь — может быть «200*300*10», «6xl», «200×300×10»…);
 *   - валидирует/нормализует через `CreateSizeSchema` (один источник
 *     истины с backend-ом);
 *   - вызывает `POST /api/sizes` (idempotent — повтор того же кода
 *     вернёт уже существующий размер);
 *   - после успеха ревалидирует страницу карточки лекала и кэш-тег
 *     `sizes`, чтобы новый размер сразу появился в:
 *       · select модалки «Добавить размер» (он берёт `pattern.sizeFiles`
 *         + `listSizes()` с RSC; кэш `listSizes` инвалидируем тегом),
 *       · формах создания/редактирования заказа (тот же `listSizes()`).
 *
 * Сам размер к **этой** номенклатуре action НЕ привязывает — для
 * привязки требуется DXF-файл (см. `PatternSizeFile.fileUrl` в
 * `prisma/schema.prisma`, ТЗ §5 «Если PatternSizeFile не позволяет
 * добавить размер без файла»). После успеха модалка показывает
 * подсказку «Чтобы привязать размер к номенклатуре — нажмите
 * «Добавить размер» и загрузите DXF-файл».
 */
export async function createSizeAction(
  patternId: string,
  _prev: CreateSizeState,
  form: FormData,
): Promise<CreateSizeState> {
  const rawCode = String(form.get('code') ?? '');
  const sortOrderRaw = form.get('sortOrder');
  const sortOrder =
    sortOrderRaw === null ||
    sortOrderRaw === undefined ||
    String(sortOrderRaw).trim() === ''
      ? undefined
      : Number(sortOrderRaw);
  const parsed = CreateSizeSchema.safeParse({
    code: rawCode,
    sortOrder: Number.isFinite(sortOrder) ? sortOrder : undefined,
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
    };
  }
  try {
    const created = await createSize(parsed.data);
    // Сразу освежаем все известные потребители справочника:
    //   · карточка лекала (modal «Добавить размер» рисует select из
    //     результата `listSizes`);
    //   · общий список лекал (там размеры не показываются, но кеш
    //     RSC ради единообразия дёргаем);
    //   · формы заказов берут `listSizes()` через `next: { tags:
    //     ['sizes'] }` — инвалидируем его теговым revalidateTag.
    revalidateTag('sizes');
    revalidatePath('/admin/patterns');
    revalidatePath(`/admin/patterns/${patternId}`);
    return {
      ok: true,
      successMessage: `Размер «${created.code}» создан в общем справочнике.`,
      createdSizeId: created.id,
      createdSizeCode: created.code,
    };
  } catch (e) {
    const x = explainApiError(e);
    return { error: x.error, errorRequestId: x.requestId };
  }
}

function parseParametersFromForm(form: FormData): PatternCategoryParameterInputDto[] {
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
    const sortOrderRaw = form.get(`param_${i}_sortOrder`);
    const sortOrder =
      sortOrderRaw === null || String(sortOrderRaw).trim() === ''
        ? undefined
        : Number(sortOrderRaw);
    const isRequiredRaw = form.get(`param_${i}_isRequired`);
    const isRequired =
      isRequiredRaw === null
        ? undefined
        : isRequiredRaw === 'on' ||
          isRequiredRaw === 'true' ||
          isRequiredRaw === '1';
    const candidate = {
      roleKey,
      label,
      inputType,
      unit,
      isRequired,
      sortOrder: Number.isFinite(sortOrder) ? sortOrder : undefined,
    };
    const parsed = PatternCategoryParameterInputSchema.safeParse(candidate);
    if (parsed.success) {
      out.push(parsed.data);
    }
  }
  return out;
}
