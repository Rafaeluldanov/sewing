'use server';

/**
 * Server actions для блока «Изделие» на странице редактирования заказа
 * (`/admin/orders/[id]/edit`).
 *
 * Реализует ту же фичу «Создать изделие inline», что есть в форме
 * создания заказа, но для УЖЕ существующего заказа: вместо записи
 * payload-а в hidden inputs формы заказа мы тут же создаём
 * `PatternItem` (+ при необходимости `PatternMaterialArea[]`) и
 * привязываем его к заказу через `updateOrder(...)`.
 *
 * Два пути:
 *   - `createInlineProductForEditAction` — calc-flow (статус
 *     `PatternItem = ACTIVE`). Делает 3 запроса последовательно:
 *     `createPattern`, `replacePatternMaterialAreas`, `updateOrder`.
 *     Транзакционности нет — если PATCH order упал, лекало уже создано
 *     как orphan; менеджер увидит его в `/admin/patterns?status=ACTIVE`
 *     и сможет привязать вручную;
 *   - `attachConstructorTaskPatternToOrderAction` — constructor-flow.
 *     `saveConstructorDraftAction` (см. `apps/web/app/admin/orders/new/
 *     constructor-task-action.ts`) уже создал DRAFT-PatternItem +
 *     ConstructorTask, и мы здесь только подвязываем `patternItemId`
 *     к заказу.
 */

import { revalidatePath } from 'next/cache';
import { ApiRequestError } from '@/lib/api';
import { MaterialRoleSchema } from '@sewing/shared/material-roles';
import {
  createPattern,
  replacePatternMaterialAreas,
} from '@/lib/patterns-api';
import { updateOrder } from '@/lib/orders-api';
import type { SavedInlineProductPayload } from '@/app/admin/orders/new/create-product-inline';

export interface InlineProductForEditResult {
  ok: boolean;
  patternItemId?: string;
  error?: string;
}

/**
 * Calc-flow для редактирования заказа.
 *
 * Принимает payload вкладки «Сделать расчёт» (тот же
 * `SavedInlineProductPayload`, что и в форме создания) и orderId.
 * В отличие от формы создания, где payload едет в hidden input и
 * разворачивается на backend-е целиком, здесь мы создаём
 * `PatternItem` (status='ACTIVE') руками + материальные area, потом
 * PATCH-ем заказ.
 *
 * Имя/артикул генерируются: name = «Новое изделие · <timestamp>»,
 * article = «INLINE-<timestamp>-<rand>», категория передаётся из
 * payload-а как есть. Если категория не задана — лекало остаётся без
 * категории (это допустимо).
 *
 * `techCardId` из payload-а тоже подвязывается к заказу — менеджер
 * выбрал его в той же calc-форме.
 */
export async function createInlineProductForEditAction(
  orderId: string,
  payload: SavedInlineProductPayload,
): Promise<InlineProductForEditResult> {
  if (!orderId || typeof orderId !== 'string') {
    return { ok: false, error: 'Не задан id заказа' };
  }
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  const baseName = payload.categoryName
    ? `${payload.categoryName} · доп.`
    : 'Новое изделие';
  const generatedName = `${baseName} · ${new Date()
    .toISOString()
    .slice(0, 16)
    .replace('T', ' ')}`;
  const generatedArticle = `INLINE-${ts}-${rand}`;
  try {
    // 1) PatternItem (ACTIVE).
    const pattern = await createPattern({
      name: generatedName,
      article: generatedArticle,
      categoryId: payload.categoryId ?? null,
      status: 'ACTIVE',
    });
    // 2) Material areas — собираем плоский список «sizeId × roleKey».
    const areas = payload.sizes.flatMap((s) =>
      s.areas
        .filter((a) => a.areaM2.trim() !== '')
        .map((a) => {
          // `roleKey` приходит как `string` из payload-а calc-формы,
          // backend ожидает строго MATERIAL_ROLES whitelist. Прогоняем
          // через shared zod-схему как первую защитную линию — если
          // придёт неизвестная роль, action вернёт 400 от backend-а с
          // понятной ошибкой.
          const role = MaterialRoleSchema.parse(a.roleKey);
          return {
            sizeId: s.sizeId,
            materialRole: role,
            areaM2: a.areaM2,
            comment: null,
          };
        }),
    );
    if (areas.length > 0) {
      await replacePatternMaterialAreas(pattern.id, areas);
    }
    // 3) PATCH заказа — выставляем patternItemId + techCardId.
    await updateOrder(orderId, {
      patternItemId: pattern.id,
      techCardId: payload.techCardId ?? null,
    });
    revalidatePath(`/admin/orders/${orderId}`);
    revalidatePath(`/admin/orders/${orderId}/edit`);
    return { ok: true, patternItemId: pattern.id };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return {
        ok: false,
        error: e.message || 'Не удалось создать изделие для заказа',
      };
    }
    return {
      ok: false,
      error:
        (e as Error)?.message ??
        'Не удалось создать изделие (неизвестная ошибка)',
    };
  }
}

/**
 * Constructor-flow для редактирования заказа.
 *
 * `saveConstructorDraftAction` уже создал DRAFT-PatternItem +
 * ConstructorTask — здесь мы просто подвязываем `patternItemId` к
 * заказу через PATCH. Никаких новых записей в БД не создаём.
 */
export async function attachConstructorTaskPatternToOrderAction(
  orderId: string,
  patternItemId: string,
): Promise<InlineProductForEditResult> {
  if (!orderId || !patternItemId) {
    return { ok: false, error: 'Не задан id заказа или лекала' };
  }
  try {
    await updateOrder(orderId, { patternItemId });
    revalidatePath(`/admin/orders/${orderId}`);
    revalidatePath(`/admin/orders/${orderId}/edit`);
    return { ok: true, patternItemId };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return {
        ok: false,
        error: e.message || 'Не удалось привязать лекало к заказу',
      };
    }
    return {
      ok: false,
      error:
        (e as Error)?.message ??
        'Не удалось привязать лекало (неизвестная ошибка)',
    };
  }
}
