import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ClipboardList } from 'lucide-react';
import { ApiRequestError } from '@/lib/api';
import { listPatterns } from '@/lib/patterns-api';
import { getTechCard } from '@/lib/tech-cards-api';
import {
  AdminCard,
  AdminPageShell,
  AdminSectionHeader,
  AdminStatusBadge,
  AdminTechInfo,
} from '@/components/admin';
import { formatStatus, statusTone } from '@/lib/admin-labels';
import { TechCardForm } from '../tech-card-form';

export const dynamic = 'force-dynamic';

interface Params {
  params: { id: string };
}

/**
 * Карточка техкарты (Admin UI 2.5, ADR-0022).
 *
 * Backend / DTO не меняем — `TechCardForm` остаётся прежним. UI
 * приведён к единому стандарту: AdminPageShell + AdminCard +
 * AdminTechInfo, без длинных описаний и technical clutter в основном
 * экране.
 */
export default async function AdminTechCardDetailPage({ params }: Params) {
  let template;
  try {
    template = await getTechCard(params.id);
  } catch (e) {
    if (e instanceof ApiRequestError && e.statusCode === 404) {
      notFound();
    }
    throw e;
  }
  // Этап «Подтянуть из номенклатуры» (см. ТЗ §1, §4): подгружаем
  // активные номенклатуры (`PatternItem`) — кнопка «Подтянуть из
  // номенклатуры» в форме тянет конкретные используемые параметры
  // выбранной номенклатуры через её `PatternItemParameterNorm`.
  // Любой fail (API down, 401, не-массив в ответе) → пустой
  // массив; форма всё равно открывается, просто без блока pull.
  // Передаём в client component ТОЛЬКО plain `{ id, name, article }`
  // — без Decimal/Date/BigInt/полного DTO (см. ТЗ «Если page.tsx
  // передаёт данные в client component»).
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

  return (
    <AdminPageShell
      icon={<ClipboardList size={22} strokeWidth={1.6} aria-hidden />}
      title={template.name}
      subtitle={`${template.materialLines.length} материалов · ${template.outsourceLines.length} внешних`}
      actions={
        <>
          <Link href="/admin/tech-cards" className="admin-btn admin-btn--ghost">
            <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />
            К списку
          </Link>
          <AdminStatusBadge tone={statusTone(template.isActive)}>
            {formatStatus(template.isActive)}
          </AdminStatusBadge>
        </>
      }
    >
      <AdminCard>
        <AdminSectionHeader
          title="Параметры и строки техкарты"
          hint="Snapshot фиксируется на заказе при запуске"
        />
        <TechCardForm
          mode="edit"
          template={template}
          patternItems={patternItems}
        />
      </AdminCard>

      <AdminTechInfo
        items={[
          { label: 'ID', value: <code>{template.id}</code> },
          { label: 'Код', value: <code>{template.code}</code> },
          { label: 'Материалов', value: template.materialLines.length },
          { label: 'Внешних', value: template.outsourceLines.length },
          {
            label: 'Обновлена',
            value: new Date(template.updatedAt).toLocaleString('ru-RU'),
          },
        ]}
      />
    </AdminPageShell>
  );
}
