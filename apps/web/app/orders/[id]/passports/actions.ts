'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  CreatePassportSchema,
  PlacePassportSchema,
  type CreatePassportDto,
  type PlacePassportDto,
} from '@sewing/shared/passports';
import {
  CreateCuttingClosureRequestSchema,
  type CreateCuttingClosureRequestDto,
} from '@sewing/shared/cutting-closure';
import { ApiRequestError } from '@/lib/api';
import {
  createPassport,
  deletePassport,
  placePassport,
} from '@/lib/passports-api';
import { createCuttingClosureRequest } from '@/lib/cutting-closure-api';

/**
 * Результат сабмита формы выпуска паспорта.
 *
 * Расширен под ADR-0018 «закрытие раскроя через заявку»: помощник
 * раскройщика может в той же форме отметить чекбокс «подать заявку
 * на закрытие». Тогда сразу после успешного создания паспорта
 * server action пытается создать `CuttingClosureRequest`. Возможны
 * исходы (см. `docs/flows.md §F2 / §F13`):
 *
 *  1. `mode = 'redirect'` (старый сценарий менеджера на
 *     `/orders/:id/passports/new`), чекбокс выключен → классический
 *     happy path: redirect на `/passports/[id]`. `success` не
 *     возвращается.
 *  2. Чекбокс включён, обе операции прошли → `success.passport` +
 *     `success.closure.kind = 'created'`. UI показывает success-блок
 *     со ссылкой на паспорт.
 *  3. Чекбокс включён, паспорт создан, заявка не создана →
 *     `success.passport` + `success.closure.kind = 'failed'` +
 *     `success.closure.error`. UI показывает mixed-result: «паспорт
 *     создан, но заявку отправить не удалось», ссылку на паспорт и
 *     подсказку «подать заявку вручную».
 *  4. `mode = 'inline'` (упрощённый flow помощника раскройщика на
 *     `/work`, см. `docs/screens.md §7.5`), чекбокс выключен →
 *     `success.passport` + `success.closure.kind = 'skipped'`. UI
 *     показывает компактный пост-релизный блок с кнопками
 *     «Распечатать паспорт» / «Выпустить следующий», большая
 *     карточка `/passports/:id` НЕ открывается автоматически.
 *
 * Если паспорт не создан, ничего из `success` не возвращаем — обычная
 * `error`/`fieldErrors`-семантика как раньше.
 */
export interface PassportFormState {
  error?: string;
  fieldErrors?: Record<string, string>;
  success?: PassportFormSuccess;
}

export interface PassportFormSuccess {
  passport: {
    id: string;
    number: string;
    /** Нужен компактному success-блоку помощника раскройщика. */
    qtyCut: number;
    /** Нужен компактному success-блоку помощника раскройщика. */
    rollNumber: string;
  };
  closure:
    | { kind: 'created' }
    | { kind: 'failed'; error: string }
    | { kind: 'skipped' };
}

/**
 * Какое поведение должен принять `createPassportAction` после
 * успешного создания паспорта без чекбокса «закрытие раскроя».
 *
 *  - `'redirect'` — классический менеджерский UX: redirect на
 *    `/passports/[id]`. Это поведение по умолчанию, его получают
 *    все, кто бьёт форму без явного `mode` (обратная совместимость).
 *  - `'inline'` — упрощённый UX помощника раскройщика на `/work`:
 *    форма не редиректит, а возвращает `success` с компактным
 *    набором полей паспорта. Большая карточка `/passports/:id` не
 *    открывается автоматически — печать и «Выпустить следующий»
 *    доступны прямо в рабочем поле (см. `docs/screens.md §7.5`).
 */
export type CreatePassportMode = 'redirect' | 'inline';

function explainApiError(e: unknown): string {
  if (e instanceof ApiRequestError) {
    const prefix = e.code ? `[${e.code}] ` : '';
    return `${prefix}${e.message}`;
  }
  return 'Не удалось выполнить запрос';
}

function isNextRedirect(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    'digest' in e &&
    typeof (e as { digest?: unknown }).digest === 'string' &&
    (e as { digest: string }).digest.startsWith('NEXT_REDIRECT')
  );
}

/**
 * Бизнес-логика:
 *  1. Парсим тело паспорта Zod-схемой.
 *  2. Создаём паспорт через `POST /api/passports`. Если упало — обычная
 *     ошибка, заявку даже не пытаемся подать.
 *  3. Если `requestCuttingClosure` выключен И `mode = 'redirect'` —
 *     `redirect` на карточку паспорта, как раньше (UX менеджера не
 *     меняется). Если `mode = 'inline'` — возвращаем `success` с
 *     `closure.kind = 'skipped'`, чтобы /work помощника раскройщика
 *     показал компактный пост-релизный блок без перехода на
 *     `/passports/:id` (см. `docs/screens.md §7.5`).
 *  4. Если чекбокс включён — пытаемся создать заявку. Паспорт уже
 *     существует и НЕ откатывается ни при каких ошибках заявки
 *     (см. ТЗ): UI честно покажет mixed-result со ссылкой «открыть
 *     паспорт».
 *
 *  `productId` пробрасывается через `bind` со страницы — берём его из
 *  заказа на сервере, не доверяя hidden-input в клиентской форме.
 *  `mode` тоже передаётся через `bind` — нельзя принимать его из
 *  клиентского `FormData`, иначе любой пользователь смог бы вынудить
 *  inline-режим на роли, у которой его не должно быть.
 */
export async function createPassportAction(
  orderId: string,
  productId: string | null,
  mode: CreatePassportMode,
  _prev: PassportFormState,
  form: FormData,
): Promise<PassportFormState> {
  // PHASE 2 STEP 3: cutterId — необязательный для creator-CUTTER (его
  // подставит backend), и обязательный для всех остальных ролей. На
  // клиенте select-а просто не будет, если creatorIsCutter, поэтому
  // пустая строка тут — ожидаемый кейс. Backend всё равно валидирует
  // через `CUTTER_REQUIRED` / `CUTTER_NOT_FOUND` / `CUTTER_INACTIVE`.
  const cutterIdRaw = String(form.get('cutterId') ?? '').trim();
  const raw: Partial<CreatePassportDto> = {
    orderId,
    sizeId: String(form.get('sizeId') ?? '').trim(),
    cutDate: String(form.get('cutDate') ?? '').trim(),
    qtyCut: Number(form.get('qtyCut') ?? 0),
    rollNumber: String(form.get('rollNumber') ?? '').trim(),
    ...(cutterIdRaw ? { cutterId: cutterIdRaw } : {}),
  };
  const parsed = CreatePassportSchema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      fieldErrors[issue.path.join('.')] = issue.message;
    }
    return {
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
      fieldErrors,
    };
  }

  const wantsClosure = String(form.get('requestCuttingClosure') ?? '') === 'on';
  const closureReason =
    String(form.get('closureReason') ?? '').trim() || undefined;

  let created;
  try {
    created = await createPassport(parsed.data);
  } catch (e) {
    if (isNextRedirect(e)) throw e;
    return { error: explainApiError(e) };
  }
  revalidatePath(`/orders/${orderId}`);
  revalidatePath('/orders');

  // Снимок «что показать в success-блоке». Берём с фактически
  // созданного DTO, а не с body формы, — это и безопаснее (источник
  // истины — backend), и заодно даёт `number`, который генерится на
  // сервере.
  const passportSnapshot = {
    id: created.id,
    number: created.number,
    qtyCut: created.qtyCut,
    rollNumber: created.rollNumber,
  };

  if (!wantsClosure) {
    if (mode === 'inline') {
      // Упрощённый flow помощника раскройщика на /work: не открываем
      // большую карточку паспорта, отдаём компактный пост-релизный
      // блок (печать + «Выпустить следующий»).
      return {
        success: {
          passport: passportSnapshot,
          closure: { kind: 'skipped' },
        },
      };
    }
    redirect(`/passports/${created.id}`);
  }

  // С этого момента паспорт уже создан. Любая ошибка ниже не должна
  // его «откатывать» — отдаём mixed-result и ссылку на паспорт.
  if (!productId) {
    return {
      success: {
        passport: passportSnapshot,
        closure: {
          kind: 'failed',
          error:
            'У заказа не указано изделие — заявку на закрытие можно подать только в карточке паспорта.',
        },
      },
    };
  }

  const closureBody: CreateCuttingClosureRequestDto = {
    orderId,
    productId,
    sizeId: parsed.data.sizeId,
    reason: closureReason,
  };
  const closureParsed =
    CreateCuttingClosureRequestSchema.safeParse(closureBody);
  if (!closureParsed.success) {
    return {
      success: {
        passport: passportSnapshot,
        closure: {
          kind: 'failed',
          error:
            closureParsed.error.issues[0]?.message ??
            'Невалидные данные заявки',
        },
      },
    };
  }

  try {
    await createCuttingClosureRequest(closureParsed.data);
  } catch (e) {
    if (isNextRedirect(e)) throw e;
    return {
      success: {
        passport: passportSnapshot,
        closure: { kind: 'failed', error: explainApiError(e) },
      },
    };
  }
  revalidatePath(`/passports/${created.id}`);
  revalidatePath(`/orders/${orderId}`);
  return {
    success: {
      passport: passportSnapshot,
      closure: { kind: 'created' },
    },
  };
}

export async function placePassportAction(
  passportId: string,
  orderId: string | null,
  _prev: PassportFormState,
  form: FormData,
): Promise<PassportFormState> {
  const raw: PlacePassportDto = {
    cellId: String(form.get('cellId') ?? '').trim() || undefined,
    cellCode: String(form.get('cellCode') ?? '').trim() || undefined,
  };
  const parsed = PlacePassportSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? 'Укажите ячейку',
    };
  }
  try {
    await placePassport(passportId, parsed.data);
    revalidatePath(`/passports/${passportId}`);
    if (orderId) revalidatePath(`/orders/${orderId}`);
  } catch (e) {
    if (isNextRedirect(e)) throw e;
    return { error: explainApiError(e) };
  }
  return {};
}

// ---------------------------------------------------------------------------
// DELETE — управленческое удаление паспорта (см.
// `PassportsService.delete`, `docs/domain.md §7.8 «Удаление паспорта»`).
// ---------------------------------------------------------------------------

/**
 * Тонкая обёртка `DELETE /api/passports/:id`. RBAC enforce-ит backend
 * (`@Roles('SHOP_MANAGER', 'ADMIN')`); серверная страница, которая
 * рендерит кнопку, отвечает за то, чтобы для остальных ролей кнопка
 * вообще не приходила в HTML.
 *
 * Контракт:
 *   - `{ ok: true }` — паспорт удалён, страница ревалидирована;
 *     UI сам решает, перерисоваться или редиректнуть;
 *   - `{ error: '…' }` — backend отказал (нет прав, паспорт упакован,
 *     есть подтверждённые начисления и т.п.). Текст уже подготовлен
 *     к показу, client-component кладёт его в свой error-box.
 *
 * Отдельный wrapper `deletePassportFromDetailAction` дополнительно
 * редиректит на карточку заказа после успешного удаления — со
 * страницы паспорта возвращаться больше некуда.
 */
export interface DeletePassportActionResult {
  ok?: true;
  error?: string;
}

export async function deletePassportAction(
  passportId: string,
  orderId: string,
): Promise<DeletePassportActionResult> {
  try {
    await deletePassport(passportId);
  } catch (e) {
    return { error: explainApiError(e) };
  }
  revalidatePath(`/orders/${orderId}`);
  revalidatePath(`/admin/orders/${orderId}`);
  revalidatePath(`/passports/${passportId}`);
  return { ok: true };
}

export async function deletePassportFromDetailAction(
  passportId: string,
  orderId: string,
): Promise<DeletePassportActionResult> {
  try {
    await deletePassport(passportId);
  } catch (e) {
    return { error: explainApiError(e) };
  }
  revalidatePath(`/orders/${orderId}`);
  revalidatePath(`/admin/orders/${orderId}`);
  revalidatePath(`/passports/${passportId}`);
  // Возвращаем менеджера на admin-карточку заказа, вкладка
  // «Паспорта» (см. `OrderPassportsTab`,
  // `apps/web/app/admin/orders/[id]/page.tsx`). Управленческое
  // удаление паспорта живёт под admin-RBAC, поэтому именно admin-
  // карточка — правильный «куда вернуться»: пользователь сразу
  // видит обновлённый список без удалённой строки. Раньше уходило
  // в legacy `/orders/<id>` — там SSR подтягивал кэш до revalidate
  // и на пару секунд показывал «битый» паспорт.
  redirect(`/admin/orders/${orderId}?tab=passports`);
}
