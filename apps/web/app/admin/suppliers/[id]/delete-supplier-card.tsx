'use client';

/**
 * `DeleteSupplierCard` — блок «Удаление» на карточке поставщика
 * (`/admin/suppliers/[id]`). Физическое удаление: каскадом уходят
 * контакты и номенклатура, у потребностей цеха / приёмок ссылка
 * обнуляется.
 *
 * Backend блокирует удаление, если на поставщика выписаны заказы
 * (`SUPPLIER_HAS_PURCHASE_ORDERS`) — текст ошибки показываем inline,
 * предлагая архивацию (статус «Неактивен») вместо удаления.
 *
 * После успеха карточки больше нет — уводим в список (`router.push`).
 */
import { Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { deleteSupplierPageAction } from '../actions';

interface Props {
  supplierId: string;
  supplierName: string;
}

export function DeleteSupplierCard({ supplierId, supplierName }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const handleClick = () => {
    if (
      !window.confirm(
        `Удалить поставщика «${supplierName}»? Контакты и номенклатура будут ` +
          'удалены безвозвратно. Если на поставщика есть заказы — удаление ' +
          'не выполнится, используйте статус «Неактивен».',
      )
    ) {
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await deleteSupplierPageAction(supplierId);
        router.push('/admin/suppliers');
        router.refresh();
      } catch (e) {
        setError(
          e instanceof Error ? e.message : 'Не удалось удалить поставщика',
        );
      }
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <p className="admin-muted" style={{ margin: 0, fontSize: '0.85rem' }}>
        Полное удаление карточки вместе с контактами и номенклатурой. Чтобы
        просто скрыть поставщика из выбора (оставив историю), смените статус
        на «Неактивен» в форме выше.
      </p>
      <div className="admin-actions-row">
        <button
          type="button"
          className="admin-btn admin-btn--danger"
          onClick={handleClick}
          disabled={pending}
          aria-busy={pending}
        >
          <Trash2 size={16} strokeWidth={1.6} aria-hidden />
          {pending ? 'Удаляем…' : 'Удалить поставщика'}
        </button>
      </div>
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
