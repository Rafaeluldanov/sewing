'use server';

import { redirect } from 'next/navigation';
import { logoutAndClearSession, refreshSessionCookie } from '@/lib/auth-api';

/**
 * Server actions автовыхода по бездействию (см.
 * `apps/web/components/session/idle-logout-watcher.tsx`,
 * `apps/api/src/modules/auth/session-policy.ts`).
 *
 * Лежат рядом с `logout-action.ts` под route-группой `(auth)`: это
 * файл с server actions, публичного URL `/auth` он не создаёт.
 *
 * ВАЖНО: в файле с `'use server'` можно экспортировать только
 * async-функции — константы уронили бы страницу молча.
 */

/**
 * «Человек ещё здесь»: продлевает сессию на полное окно бездействия.
 *
 * Возвращает `false`, если сессия уже мертва (истекла, отозвана
 * кнопкой «Завершить все сеансы», сотрудника деактивировали) — сторож
 * по этому ответу уводит на форму входа, не дожидаясь своего таймера.
 *
 * Редиректом здесь не пользуемся сознательно: action зовётся из
 * обработчика активности, и увести человека со страницы в этот момент
 * (например, посреди заполнения формы) было бы хуже, чем дать сторожу
 * доиграть отсчёт и показать предупреждение.
 */
export async function touchSessionAction(): Promise<boolean> {
  return refreshSessionCookie();
}

/**
 * Выход по бездействию. Отличается от обычного `logoutAction` только
 * причиной в адресе: `/login?reason=idle` показывает объяснение, иначе
 * человек видит форму входа без всякого повода и решает, что систему
 * «выбросило само».
 */
export async function idleLogoutAction(): Promise<void> {
  await logoutAndClearSession();
  redirect('/login?reason=idle');
}
