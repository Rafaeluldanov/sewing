'use client';

/**
 * «Состав выпуска» — строки документа выпуска (расцветка × размер) с
 * раскрытием в номера паспортов.
 *
 * Клиентский компонент нужен ровно ради одного состояния — какие строки
 * раскрыты. Всё остальное готовит серверная карточка
 * (`page.tsx`): здесь ни одного запроса и ни одного действия, потому что
 * документ выпуска НЕЛЬЗЯ править — он собирается сам из фактов цеха.
 *
 * Паспорта показываем не для красоты: строка выпуска — это агрегат, и
 * единственный способ проверить её глазами — увидеть основание, то есть
 * номера паспортов, из которых она сложилась.
 *
 * Разметка таблицы руками (а не `AdminTable`), потому что нужна вторая
 * `<tr>` под `colSpan` — так же сделано в
 * `admin/production-cost/order/[orderId]/production-document-view.tsx`.
 * `.admin-table-wrap` здесь обязателен: его добавляет `AdminTable`, а мы
 * рисуем `<table>` сами.
 */
import { Fragment, useState } from 'react';
import { ChevronDown, ChevronRight, Layers } from 'lucide-react';
import type { ProductionDocumentLineDto } from '@sewing/shared/production-documents';
import { AdminEmptyState, AdminStatusBadge } from '@/components/admin';

/** Количества в документе штучные — дробей быть не может. */
function fmtInt(n: number): string {
  return new Intl.NumberFormat('ru-RU').format(n);
}

/** Колонок в таблице — нужно для `colSpan` раскрытой строки. */
const COLS = 7;

export function ProductionDocumentLines({
  lines,
}: {
  lines: ProductionDocumentLineDto[];
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (lines.length === 0) {
    return (
      <AdminEmptyState
        icon={<Layers size={24} strokeWidth={1.6} aria-hidden />}
        title="В документе нет строк"
        hint="Заказ закрыт, но ни один паспорт не дошёл до упаковки"
      />
    );
  }

  // Итог считаем здесь, а не берём из шапки: шапка — снимок, а сумма по
  // видимым строкам должна сходиться с тем, что человек видит глазами.
  const total = lines.reduce(
    (acc, l) => ({
      qtyGood: acc.qtyGood + l.qtyGood,
      qtyCut: acc.qtyCut + l.qtyCut,
      qtyDefect: acc.qtyDefect + l.qtyDefect,
      passports: acc.passports + l.passportNumbers.length,
    }),
    { qtyGood: 0, qtyCut: 0, qtyDefect: 0, passports: 0 },
  );

  return (
    <div className="admin-table-wrap">
      <table className="admin-table">
        <thead>
          <tr>
            <th />
            <th>Расцветка</th>
            <th>Размер</th>
            <th style={{ textAlign: 'right' }}>Годных</th>
            <th style={{ textAlign: 'right' }}>Раскроено</th>
            <th style={{ textAlign: 'right' }}>Брак</th>
            <th style={{ textAlign: 'right' }}>Паспортов</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => {
            const isOpen = open.has(line.id);
            return (
              <Fragment key={line.id}>
                <tr
                  onClick={() => toggle(line.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      toggle(line.id);
                    }
                  }}
                  tabIndex={0}
                  aria-expanded={isOpen}
                  style={{ cursor: 'pointer' }}
                >
                  <td
                    style={{
                      width: 28,
                      color: 'var(--admin-muted)',
                    }}
                  >
                    {isOpen ? (
                      <ChevronDown size={16} strokeWidth={1.8} aria-hidden />
                    ) : (
                      <ChevronRight size={16} strokeWidth={1.8} aria-hidden />
                    )}
                  </td>
                  <td data-label="Расцветка">
                    {line.color ? (
                      <strong>{line.color}</strong>
                    ) : (
                      <span className="admin-muted">—</span>
                    )}
                    {/* Образцы идут тем же тиражом, но считать их выпуском
                        нельзя — помечаем прямо в строке. */}
                    {line.isSample && (
                      <span style={{ marginLeft: 6 }}>
                        <AdminStatusBadge tone="info">образец</AdminStatusBadge>
                      </span>
                    )}
                  </td>
                  <td data-label="Размер">
                    {line.sizeCode ?? <span className="admin-muted">—</span>}
                  </td>
                  <td data-label="Годных" style={{ textAlign: 'right' }}>
                    <strong>{fmtInt(line.qtyGood)}</strong>
                  </td>
                  <td data-label="Раскроено" style={{ textAlign: 'right' }}>
                    {fmtInt(line.qtyCut)}
                  </td>
                  <td data-label="Брак" style={{ textAlign: 'right' }}>
                    {line.qtyDefect > 0 ? (
                      <span style={{ color: 'var(--admin-danger, #d23b3b)' }}>
                        {fmtInt(line.qtyDefect)}
                      </span>
                    ) : (
                      <span className="admin-muted">0</span>
                    )}
                  </td>
                  <td data-label="Паспортов" style={{ textAlign: 'right' }}>
                    {fmtInt(line.passportNumbers.length)}
                  </td>
                </tr>
                {isOpen && (
                  <tr>
                    <td
                      colSpan={COLS}
                      style={{ background: 'var(--admin-soft, #f1f1ef)' }}
                    >
                      {line.passportNumbers.length === 0 ? (
                        <span className="admin-muted" style={{ fontSize: 12 }}>
                          Паспортов в основании строки нет — количество
                          пришло корректировкой.
                        </span>
                      ) : (
                        <>
                          <div
                            className="admin-muted"
                            style={{ fontSize: 12, marginBottom: 6 }}
                          >
                            Основание строки — паспорта:
                          </div>
                          <ul className="admin-chip-list">
                            {line.passportNumbers.map((number) => (
                              <li key={number} className="admin-chip">
                                {number}
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <td />
            <td colSpan={2} style={{ fontWeight: 700 }}>
              Итого
            </td>
            <td style={{ textAlign: 'right', fontWeight: 700 }}>
              {fmtInt(total.qtyGood)}
            </td>
            <td style={{ textAlign: 'right', fontWeight: 700 }}>
              {fmtInt(total.qtyCut)}
            </td>
            <td style={{ textAlign: 'right', fontWeight: 700 }}>
              {fmtInt(total.qtyDefect)}
            </td>
            <td style={{ textAlign: 'right', fontWeight: 700 }}>
              {fmtInt(total.passports)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
