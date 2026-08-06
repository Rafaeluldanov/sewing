import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ArrowRight, MonitorSmartphone } from 'lucide-react';
import type { CompanyDivisionDto } from '@sewing/shared/company-divisions';
import type { DisplayScreenDetailDto } from '@sewing/shared/display-screens';
import { ApiRequestError } from '@/lib/api';
import { getDisplayScreen } from '@/lib/display-screens-api';
import { listCompanyDivisions } from '@/lib/company-settings-api';
import {
  AdminCard,
  AdminPageShell,
  AdminSectionHeader,
  AdminStatusBadge,
  AdminTechInfo,
} from '@/components/admin';
import { DisplayScreenMainForm, DisplayScreenPinForm } from './edit-form';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: { id: string };
}

/**
 * Дата-время для технической врезки. `timeZone` указан ЯВНО: без него
 * сервер форматирует по TZ контейнера, клиент — по TZ браузера, и
 * React роняет hydration на этой строке (а заодно гасит обработчики у
 * соседних узлов). Вся админка живёт в московском времени.
 */
function formatMsk(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Что этот экран показывает в зале (см. `screenBoardHref` в списке). */
function boardHref(s: DisplayScreenDetailDto): string {
  return s.companyDivision
    ? `/shopfloor/display?divisionCode=${encodeURIComponent(
        s.companyDivision.code,
      )}`
    : '/shopfloor/display';
}

/**
 * Карточка display-экрана (`/admin/display-screens/[id]`).
 *
 * Зачем она появилась: экран живёт в цехе годами, а его атрибуты
 * меняются — подразделение переехало на другой монитор, железку
 * переименовали, PIN забыли. Раньше карточки не было вовсе, и
 * единственным способом что-либо поменять было «удалить экран и
 * завести заново» — это уносило DISPLAY-учётку вместе с её логином
 * (уникальный индекс) и историю событий монитора.
 *
 * Состав:
 *   - «Основное» — название, подразделение, логин учётки (одна
 *     транзакция на `DisplayScreenConfig` + `Employee`, см.
 *     `DisplayScreensService.update`);
 *   - «PIN монитора» — отдельная форма, чтобы сохранение названия не
 *     могло сбросить код, по которому железка логинится;
 *   - техническая врезка с id'шниками и датами.
 *
 * Включение/выключение и удаление экрана сюда сознательно НЕ вынесены:
 * этим заведует контур архива на списке (он гасит и зажигает
 * DISPLAY-учётку вместе с конфигом, а purge освобождает логин).
 */
export default async function AdminDisplayScreenDetailPage({
  params,
}: PageProps) {
  let screen: DisplayScreenDetailDto;
  try {
    screen = await getDisplayScreen(params.id);
  } catch (e) {
    if (e instanceof ApiRequestError && e.statusCode === 404) notFound();
    throw e;
  }

  let companyDivisions: CompanyDivisionDto[] = [];
  try {
    companyDivisions = await listCompanyDivisions();
  } catch {
    companyDivisions = [];
  }

  return (
    <AdminPageShell
      icon={<MonitorSmartphone size={22} strokeWidth={1.6} aria-hidden />}
      title={screen.name}
      subtitle={`${
        screen.companyDivision?.name ?? 'подразделение не указано'
      } · логин ${screen.employeeLogin}`}
      actions={
        <>
          <Link
            href="/admin/display-screens"
            className="admin-btn admin-btn--ghost"
          >
            <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />К списку
          </Link>
          <Link href={boardHref(screen)} className="admin-btn admin-btn--ghost">
            Монитор
            <ArrowRight size={16} strokeWidth={1.6} aria-hidden />
          </Link>
        </>
      }
    >
      <AdminCard>
        <AdminSectionHeader
          title="Основное"
          hint="Название, подразделение и логин учётки монитора"
          actions={
            <AdminStatusBadge tone={screen.isActive ? 'success' : 'muted'}>
              {screen.isActive ? 'активен' : 'в архиве'}
            </AdminStatusBadge>
          }
        />
        <DisplayScreenMainForm
          screen={screen}
          companyDivisions={companyDivisions}
        />
      </AdminCard>

      <AdminCard>
        <AdminSectionHeader
          title="PIN монитора"
          hint="Текущий PIN не хранится в открытом виде — его можно только задать заново"
        />
        <DisplayScreenPinForm screen={screen} />
      </AdminCard>

      <AdminTechInfo
        items={[
          { label: 'ID экрана', value: <code>{screen.id}</code> },
          { label: 'ID учётки', value: <code>{screen.employeeId}</code> },
          {
            label: 'Подразделение',
            value: screen.companyDivision
              ? `${screen.companyDivision.name} (${screen.companyDivision.code})`
              : '— не указано —',
          },
          { label: 'Создан', value: formatMsk(screen.createdAt) },
          { label: 'Изменён', value: formatMsk(screen.updatedAt) },
        ]}
      />
    </AdminPageShell>
  );
}
