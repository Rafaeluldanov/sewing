'use server';

/**
 * Server actions окна «Справка».
 *
 * RBAC — на backend: ручки `/api/help/*` открыты любому
 * аутентифицированному, а видимость статьи режется по ролям внутри
 * сервиса.
 */

import { revalidatePath } from 'next/cache';
import type {
  KnowledgeFeedbackDto,
  KnowledgeFeedbackKind,
} from '@sewing/shared/knowledge';
import { ApiRequestError, errorText } from '@/lib/api';
import { sendHelpFeedback } from '@/lib/help-api';

/**
 * 👍 / 👎 / «это не то».
 *
 * Запрос, по которому статью нашли, передаётся вместе с отзывом: пара
 * «искали X → сказали „это не то"» показывает автору не «статья
 * плохая», а каким словом её не нашли.
 *
 * Ошибку возвращаем, но не роняем экран: сотрудник у машины нажал
 * палец вниз — это не повод показывать ему страницу ошибки.
 */
export async function sendHelpFeedbackAction(
  slug: string,
  kind: KnowledgeFeedbackKind,
  query?: string,
): Promise<{ ok: boolean; error?: string }> {
  const body: KnowledgeFeedbackDto = { kind, query: query || undefined };
  try {
    await sendHelpFeedback(slug, body);
  } catch (e) {
    return {
      ok: false,
      error:
        e instanceof ApiRequestError ? errorText(e) : 'Не удалось отправить',
    };
  }
  revalidatePath('/help');
  return { ok: true };
}
