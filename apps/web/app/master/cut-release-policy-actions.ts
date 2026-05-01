'use server';

/**
 * Server actions Stage 3 «Мастер цеха» — управление одной активной
 * политикой выдачи кроя из мобильного UI `/master`.
 *
 * Контракт API — `apps/api/src/modules/cut-release-policy/*`.
 * UI-потребитель — `apps/web/app/master/cut-release-policy-card.tsx`.
 *
 * Все действия возвращают единый result-shape
 * `{ ok: true, ... } | { ok: false, error, errorRequestId? }` —
 * UI обрабатывает их одинаково и не должен ловить exceptions.
 *
 * `explainApiError` для этой фичи НЕ добавляет префикс `[CODE] `:
 * рабочему на `/work` мы показываем точный inline-message от backend
 * (`CUT_RELEASE_POLICY_VIOLATION` приходит уже с готовой строкой
 * «Сейчас разрешена выдача только: …, лимит N шт.»). Для мастера в
 * `/master` тоже не нужен код перед текстом — он работает с понятными
 * валидационными ошибками формы.
 */

import { revalidatePath } from 'next/cache';
import {
  CreateCutReleasePolicySchema,
  type CreateCutReleasePolicyDto,
  type CutReleasePolicyDto,
} from '@sewing/shared';
import { ApiRequestError } from '@/lib/api';
import {
  createCutReleasePolicy,
  disableCutReleasePolicy,
  getActiveCutReleasePolicy,
} from '@/lib/cut-release-policy-api';

function explainApiError(e: unknown): string {
  if (e instanceof ApiRequestError) return e.message;
  return 'Не удалось выполнить запрос';
}

function errorRequestId(e: unknown): string | undefined {
  return e instanceof ApiRequestError ? e.requestId : undefined;
}

export type CutReleasePolicyResult =
  | { ok: true; policy: CutReleasePolicyDto | null }
  | { ok: false; error: string; errorRequestId?: string };

/**
 * Обновить снимок активной политики (используется polling'ом UI на
 * `/master`, чтобы карточка показывала актуальный `consumedQty/limitQty`).
 */
export async function refreshCutReleasePolicyAction(): Promise<CutReleasePolicyResult> {
  try {
    const res = await getActiveCutReleasePolicy();
    return { ok: true, policy: res.policy };
  } catch (e) {
    return {
      ok: false,
      error: explainApiError(e),
      errorRequestId: errorRequestId(e),
    };
  }
}

/**
 * Установить новое ограничение. Все предыдущие активные политики
 * автоматически выключаются на стороне API в той же транзакции (см.
 * `CutReleasePolicyService.create`).
 */
export async function setCutReleasePolicyAction(
  raw: unknown,
): Promise<CutReleasePolicyResult> {
  const parsed = CreateCutReleasePolicySchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error:
        parsed.error.issues[0]?.message ??
        'Некорректные параметры ограничения',
    };
  }
  // safeParse у zod удаляет undefined-ключи через .nullish/.optional —
  // но если UI передал пустую строку для color/sizeId, безопаснее
  // нормализовать в null здесь, чем зависеть от формы.
  const body: CreateCutReleasePolicyDto = {
    color: parsed.data.color ?? null,
    sizeId: parsed.data.sizeId ?? null,
    limitQty: parsed.data.limitQty,
  };
  try {
    const policy = await createCutReleasePolicy(body);
    revalidatePath('/master');
    return { ok: true, policy };
  } catch (e) {
    return {
      ok: false,
      error: explainApiError(e),
      errorRequestId: errorRequestId(e),
    };
  }
}

/**
 * Снять текущее активное ограничение. Идемпотентно — повторный
 * вызов на уже отключённой политике вернёт её в том же виде.
 */
export async function disableCutReleasePolicyAction(
  policyId: string,
): Promise<CutReleasePolicyResult> {
  if (!policyId) {
    return { ok: false, error: 'Не передан id политики' };
  }
  try {
    const policy = await disableCutReleasePolicy(policyId);
    revalidatePath('/master');
    return { ok: true, policy };
  } catch (e) {
    return {
      ok: false,
      error: explainApiError(e),
      errorRequestId: errorRequestId(e),
    };
  }
}
