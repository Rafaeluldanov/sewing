'use server';

/**
 * Server action «подтянуть документ выпуска» — собрать, если его нет, и пересобрать, если есть.
 *
 * ⛔ Это единственное действие раздела, и оно НЕ проводит документ: провести выпуск нельзя, его
 * нельзя ни подтвердить, ни отменить. Действие лишь заставляет систему перечитать факты цеха
 * прямо сейчас, вместо того чтобы ждать события (закрытие коробки, открытие карточки).
 * Придумать выпуск им нельзя: backend требует закрытый заказ и упакованные паспорта.
 *
 * ⛔ В файле только async-экспорты: `'use server'` не допускает ничего другого, а `export const`
 * рядом роняет страницу молча (см. правило репозитория про server actions).
 */
import { revalidatePath } from 'next/cache';

import { ApiRequestError, errorText } from '@/lib/api';
import { backfillProductionDocumentForOrder } from '@/lib/production-documents-api';

export async function syncProductionDocumentAction(
  orderId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await backfillProductionDocumentForOrder(orderId);
  } catch (e) {
    // Отказы здесь осмысленные — «заказ не закрыт», «нечего выпускать» — и человек должен
    // прочитать именно их, а не общее «что-то пошло не так».
    return {
      ok: false,
      error:
        e instanceof ApiRequestError
          ? errorText(e)
          : 'Не удалось обновить документ выпуска',
    };
  }
  // Блок документа живёт во вкладке «Производство» карточки заказа и в разделе документов —
  // обновляем оба, иначе кнопка «сработала», а на экране всё по-старому.
  revalidatePath(`/admin/orders/${orderId}`);
  revalidatePath('/admin/production-documents');
  // Кнопка живёт и на самой карточке документа — её тоже надо перерисовать, иначе человек
  // жмёт «обновить» и видит прежние цифры.
  revalidatePath('/admin/production-documents/[id]', 'page');
  return { ok: true };
}
