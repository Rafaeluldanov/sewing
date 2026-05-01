'use server';

import { redirect } from 'next/navigation';
import { logoutAndClearSession } from '@/lib/auth-api';

/**
 * Server action для выхода из системы. Расположен под `(auth)`
 * route-группой, чтобы не создавать публичный URL `/auth` —
 * это просто файл с server action, импортируемый из layout/header.
 */
export async function logoutAction(): Promise<void> {
  await logoutAndClearSession();
  redirect('/login');
}
