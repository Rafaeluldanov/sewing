/**
 * Состояние форм блока «Отгрузка готовой продукции» в карточке заказа.
 * Вынесено из `'use server'` файла
 * `finished-goods-shipments-actions.ts`, т.к. серверный модуль может
 * экспортировать только async-функции — объект
 * `initialFinishedGoodsShipmentFormState` рядом с ними роняет рендер
 * страницы целиком («A "use server" file can only export async
 * functions, found object»).
 */

export interface FinishedGoodsShipmentFormState {
  ok?: boolean;
  error?: string;
  successMessage?: string;
  /** Id только что созданного документа — UI может показать ссылку. */
  createdId?: string;
  createdNumber?: string;
}

export const initialFinishedGoodsShipmentFormState: FinishedGoodsShipmentFormState =
  {};
