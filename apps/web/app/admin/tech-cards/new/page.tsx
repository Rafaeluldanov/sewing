import Link from 'next/link';
import { ArrowLeft, ClipboardList } from 'lucide-react';
import {
  AdminCard,
  AdminPageShell,
  AdminSectionHeader,
} from '@/components/admin';
import { listPatterns } from '@/lib/patterns-api';
import { listPatternCategories } from '@/lib/pattern-categories-api';
import { TechCardForm } from '../tech-card-form';

export const dynamic = 'force-dynamic';

/**
 * Создание техкарты (Admin UI 2.5).
 *
 * Backend / DTO не меняем. Минимум — код и название; строки можно
 * добавить позже на карточке.
 *
 * Этап «Подтянуть из номенклатуры» (см. ТЗ §1, §4): подгружаем
 * активные номенклатуры (`PatternItem`) — кнопка «Подтянуть из
 * номенклатуры» в форме тянет конкретные используемые параметры
 * выбранной номенклатуры через её `PatternItemParameterNorm`
 * (`qtyPerItem > 0`). Категории напрямую больше не используются —
 * только через PatternItem (см. ТЗ §1 «Не тянуть просто список ролей
 * из категории»).
 */
export default async function AdminTechCardsNewPage() {
  // Подгружаем активные номенклатуры. Любой fail (API down, 401,
  // невалидный ответ, list = null) НЕ должен крашить рендер — новая
  // техкарта обязана открываться даже когда номенклатур нет вообще.
  // Поэтому:
  //   - try/catch гасит ошибки сети/HTTP;
  //   - `Array.isArray` страхует от случая, когда API вернул
  //     не-массив (например, JSON-ошибку без статуса 5xx);
  //   - в client component уходит ТОЛЬКО plain-объект `{ id, name,
  //     article }` — без Date / Decimal / BigInt / DTO целиком,
  //     которые Next.js не сможет сериализовать через RSC-границу.
  let patternItems: { id: string; name: string; article: string }[] = [];
  try {
    const list = await listPatterns({ status: 'ACTIVE' });
    if (Array.isArray(list)) {
      patternItems = list.map((p) => ({
        id: String(p?.id ?? ''),
        name: String(p?.name ?? ''),
        article: String(p?.article ?? ''),
      }));
    }
  } catch {
    patternItems = [];
  }
  // Активные группы номенклатур для кнопки «Подтянуть из группы».
  // Те же гарантии сериализации: только plain `{ id, name }`, без
  // Date/DTO целиком.
  let patternCategories: { id: string; name: string }[] = [];
  try {
    const list = await listPatternCategories({ status: 'ACTIVE' });
    if (Array.isArray(list)) {
      patternCategories = list.map((c) => ({
        id: String(c?.id ?? ''),
        name: String(c?.name ?? ''),
      }));
    }
  } catch {
    patternCategories = [];
  }
  return (
    <AdminPageShell
      icon={<ClipboardList size={22} strokeWidth={1.6} aria-hidden />}
      title="Новая техкарта"
      subtitle="Код, название и опциональные строки"
      actions={
        <Link href="/admin/tech-cards" className="admin-btn admin-btn--ghost">
          <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />
          К списку
        </Link>
      }
    >
      <AdminCard>
        <AdminSectionHeader title="Параметры" />
        <TechCardForm
          mode="create"
          patternItems={patternItems}
          patternCategories={patternCategories}
        />
      </AdminCard>
    </AdminPageShell>
  );
}
