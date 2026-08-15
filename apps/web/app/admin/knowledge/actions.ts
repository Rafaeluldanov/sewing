'use server';

/**
 * Server actions раздела «База знаний».
 *
 * RBAC — на backend (`@Roles('SHOP_MANAGER', 'ADMIN')`).
 *
 * Разбор формы устроен так же, как в блоке «Клиенты»: поле есть в
 * FormData → передаём (в том числе пустое, которое схема превратит в
 * `null`/`[]`); поля нет → `undefined` → backend не трогает.
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  CreateKnowledgeArticleSchema,
  UpdateKnowledgeArticleSchema,
  type CreateKnowledgeArticleDto,
  type KnowledgeArea,
  type UpdateKnowledgeArticleDto,
} from '@sewing/shared/knowledge';
import { ApiRequestError, errorText } from '@/lib/api';
import {
  confirmKnowledgeReview,
  createKnowledgeArticle,
  updateKnowledgeArticle,
} from '@/lib/knowledge-api';
import type {
  CreateKnowledgeArticleState,
  UpdateKnowledgeArticleState,
} from './form-state';

function explainApiError(e: unknown): { error: string; requestId?: string } {
  if (e instanceof ApiRequestError) {
    return { error: errorText(e), requestId: e.requestId };
  }
  return { error: 'Не удалось выполнить запрос' };
}

/**
 * Ключевые слова приходят одной строкой через запятую — так их удобнее
 * править в поле ввода, чем чипами с крестиками. Нормализацию (нижний
 * регистр, дубли) делает Zod-схема, здесь только режем по разделителю.
 */
function parseKeywords(raw: FormDataEntryValue | null): string[] {
  if (raw === null) return [];
  return String(raw)
    .split(/[,;\n]/)
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

function parseRoles(form: FormData): string[] {
  return form
    .getAll('roles')
    .map((r) => String(r).trim())
    .filter((r) => r.length > 0);
}

export async function createKnowledgeArticleAction(
  _prev: CreateKnowledgeArticleState,
  form: FormData,
): Promise<CreateKnowledgeArticleState> {
  const dto: CreateKnowledgeArticleDto = {
    title: String(form.get('title') ?? '').trim(),
    body: String(form.get('body') ?? '').trim(),
    keywords: parseKeywords(form.get('keywords')),
    area: (String(form.get('area') ?? 'GENERAL') || 'GENERAL') as KnowledgeArea,
    roles: parseRoles(form),
    // «Опубликовать» и «Сохранить черновик» — две кнопки одной формы,
    // отличающиеся значением submit-а. Дефолт — черновик.
    status: form.get('intent') === 'publish' ? 'PUBLISHED' : 'DRAFT',
    assistantOk: form.get('assistantOk') !== null,
    reviewEveryMonths: form.get('reviewEveryMonths') as unknown as number,
  };

  const parsed = CreateKnowledgeArticleSchema.safeParse(dto);
  if (!parsed.success) {
    return { error: parsed.error.errors[0]?.message ?? 'Проверьте поля формы' };
  }

  let createdId: string;
  try {
    const created = await createKnowledgeArticle(parsed.data);
    createdId = created.id;
  } catch (e) {
    return explainApiError(e);
  }

  revalidatePath('/admin/knowledge');
  redirect(`/admin/knowledge/${createdId}`);
}

export async function updateKnowledgeArticleAction(
  _prev: UpdateKnowledgeArticleState,
  form: FormData,
): Promise<UpdateKnowledgeArticleState> {
  const id = String(form.get('id') ?? '');
  if (!id) return { error: 'Не передан идентификатор статьи' };

  const dto: UpdateKnowledgeArticleDto = {};
  if (form.get('title') !== null) {
    dto.title = String(form.get('title') ?? '').trim();
  }
  if (form.get('body') !== null) {
    dto.body = String(form.get('body') ?? '').trim();
  }
  if (form.get('keywords') !== null) {
    dto.keywords = parseKeywords(form.get('keywords'));
  }
  if (form.get('area') !== null) {
    dto.area = String(form.get('area')) as KnowledgeArea;
  }
  // Чекбоксы ролей: их отсутствие в FormData означает «сняли все»,
  // поэтому ориентируемся на служебное поле-маркер, а не на getAll.
  if (form.get('rolesPresent') !== null) {
    dto.roles = parseRoles(form);
  }
  if (form.get('reviewEveryMonths') !== null) {
    dto.reviewEveryMonths = form.get('reviewEveryMonths') as unknown as number;
  }
  if (form.get('assistantOkPresent') !== null) {
    dto.assistantOk = form.get('assistantOk') !== null;
  }
  const intent = form.get('intent');
  if (intent === 'publish') dto.status = 'PUBLISHED';
  if (intent === 'unpublish') dto.status = 'DRAFT';

  const parsed = UpdateKnowledgeArticleSchema.safeParse(dto);
  if (!parsed.success) {
    return { error: parsed.error.errors[0]?.message ?? 'Проверьте поля формы' };
  }

  try {
    await updateKnowledgeArticle(id, parsed.data);
  } catch (e) {
    return explainApiError(e);
  }

  revalidatePath('/admin/knowledge');
  revalidatePath(`/admin/knowledge/${id}`);
  return {
    ok: true,
    successMessage:
      intent === 'publish'
        ? 'Статья опубликована'
        : intent === 'unpublish'
          ? 'Статья снята с публикации'
          : 'Изменения сохранены',
  };
}

/**
 * «Актуально» из списка просроченных: подтверждение без открытия
 * редактора. Отдельный action ради одного клика — в этом весь смысл
 * механики: подтверждение дороже клика перестают делать.
 */
export async function confirmKnowledgeReviewAction(
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await confirmKnowledgeReview(id);
  } catch (e) {
    return { ok: false, error: explainApiError(e).error };
  }
  revalidatePath('/admin/knowledge');
  revalidatePath(`/admin/knowledge/${id}`);
  return { ok: true };
}
