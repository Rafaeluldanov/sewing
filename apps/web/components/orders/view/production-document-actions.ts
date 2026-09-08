'use server';

/**
 * Server action «Сформировать документ выпуска» — достройка по уже закрытому заказу.
 *
 * ⛔ Это единственное действие раздела и осознанное исключение из правила «документ собирается
 * сам»: заказы, закрытые ДО появления раздела, документа не получили, потому что рождаться было
 * нечему. Все входы документа — исторические факты, поэтому выпуск восстанавливается, а не
 * выдумывается. Новый выпуск кнопкой не создать: backend требует закрытый заказ и упакованные
 * паспорта.
 *
 * ⛔ В файле только async-экспорты: `'use server'` не допускает ничего другого, а `export const`
 * рядом роняет страницу молча (см. правило репозитория про server actions).
 */
import { revalidatePath } from 'next/cache';

import { ApiRequestError, errorText } from '@/lib/api';
import { backfillProductionDocumentForOrder } from '@/lib/production-documents-api';

export async function buildProductionDocumentAction(
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
          : 'Не удалось сформировать документ выпуска',
    };
  }
  // Блок документа живёт во вкладке «Производство» карточки заказа и в разделе документов —
  // обновляем оба, иначе кнопка «сработала», а на экране всё по-старому.
  revalidatePath(`/admin/orders/${orderId}`);
  revalidatePath('/admin/production-documents');
  return { ok: true };
}
