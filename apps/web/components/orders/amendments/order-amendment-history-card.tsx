/**
 * `OrderAmendmentHistoryCard` — read-only «Журнал правок после расчёта»
 * на вкладке «Производство» карточки заказа. Показывает применённые
 * amendment-события (`ORDER_QTY_AMENDED` / `ORDER_SIZE_AMENDED` /
 * `ORDER_OPERATION_ADDED` / `ORDER_TECH_CARD_AMENDED`): когда, кто, что
 * и почему.
 *
 * Presentation-слой: `summary` уже собран на backend (коды размеров и имя
 * операции подставлены). Рендерится только когда есть записи — иначе
 * карточку не показываем, чтобы не шуметь.
 *
 * ВАЖНО: дата форматируется с `timeZone: 'Europe/Moscow'` — иначе RSC
 * (UTC) и клиент (Москва) разойдутся и сломают гидрацию.
 */
import { History } from 'lucide-react';
import type { AmendmentHistoryEntryDto } from '@sewing/shared';
import { AdminCard, AdminSectionHeader } from '@/components/admin';

interface Props {
  entries: AmendmentHistoryEntryDto[];
}

const KIND_LABEL: Record<AmendmentHistoryEntryDto['kind'], string> = {
  quantity: 'Количество',
  size: 'Размерность',
  operation: 'Операция',
  materials: 'Материалы',
  application: 'Нанесение',
};

function formatMoscow(iso: string): string {
  try {
    return new Date(iso).toLocaleString('ru-RU', {
      timeZone: 'Europe/Moscow',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '—';
  }
}

export function OrderAmendmentHistoryCard({ entries }: Props) {
  if (entries.length === 0) return null;

  return (
    <AdminCard>
      <AdminSectionHeader
        icon={<History size={18} strokeWidth={1.7} aria-hidden />}
        title="Журнал правок после расчёта"
        hint={`${entries.length} ${pluralEntries(entries.length)}`}
      />
      <div style={{ overflowX: 'auto' }}>
        <table className="admin-table">
          <thead>
            <tr>
              <th>Когда</th>
              <th>Кто</th>
              <th>Что</th>
              <th>Причина</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {formatMoscow(e.occurredAt)}
                </td>
                <td>{e.actorName ?? <span className="admin-muted">—</span>}</td>
                <td>
                  <span className="admin-muted" style={{ marginRight: 6 }}>
                    {KIND_LABEL[e.kind]}:
                  </span>
                  {stripKindPrefix(e.summary)}
                </td>
                <td>{e.reason ?? <span className="admin-muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AdminCard>
  );
}

/** `summary` уже содержит «Количество: …»/«Размерность: …» — не дублируем метку. */
function stripKindPrefix(summary: string): string {
  const i = summary.indexOf(': ');
  return i >= 0 ? summary.slice(i + 2) : summary;
}

/** Плюрализация «1 правка / 3 правки / 5 правок». */
function pluralEntries(n: number): string {
  const abs = Math.abs(n) % 100;
  const tail = abs % 10;
  if (abs >= 11 && abs <= 14) return 'правок';
  if (tail === 1) return 'правка';
  if (tail >= 2 && tail <= 4) return 'правки';
  return 'правок';
}
