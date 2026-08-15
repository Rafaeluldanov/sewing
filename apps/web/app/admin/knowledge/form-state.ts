/**
 * Типы и initial state форм раздела «База знаний».
 *
 * Вынесено из `./actions.ts`: файл с `'use server'` может
 * экспортировать только async-функции — `export const` роняет страницу
 * молча (см. `app/admin/clients/form-state.ts`).
 */

export interface CreateKnowledgeArticleState {
  ok?: boolean;
  successMessage?: string;
  error?: string;
  errorRequestId?: string;
}

export const initialCreateKnowledgeArticleState: CreateKnowledgeArticleState =
  {};

export interface UpdateKnowledgeArticleState {
  ok?: boolean;
  successMessage?: string;
  error?: string;
  errorRequestId?: string;
}

export const initialUpdateKnowledgeArticleState: UpdateKnowledgeArticleState =
  {};
