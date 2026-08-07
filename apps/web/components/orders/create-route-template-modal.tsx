'use client';

import { useEffect, useState } from 'react';
import type { OperationLiteDto } from '@sewing/shared/shifts';
import type { RouteTemplateDetailDto } from '@sewing/shared/routes';
import { AdminModal } from '@/components/admin/admin-modal';
import { RouteTemplateForm } from '@/app/admin/routes/route-template-form';
import { loadRouteFormOperationsAction } from '@/app/admin/routes/actions';

/**
 * «＋ Добавить маршрут…» из select-а шаблона маршрута в формах заказов.
 *
 * Переиспользует ПОЛНЫЙ конструктор шагов `RouteTemplateForm`
 * (inline-режим: без redirect, DTO через `onCreated`) в широкой
 * AdminModal. Список операций грузится при открытии модалки отдельным
 * read-action — страницы встройки не тянут `GET /shifts/meta` заранее.
 */
export function CreateRouteTemplateModal({
  zIndex,
  onCancel,
  onCreated,
}: {
  zIndex?: number;
  onCancel: () => void;
  onCreated: (template: RouteTemplateDetailDto) => void;
}) {
  const [operations, setOperations] = useState<OperationLiteDto[] | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    loadRouteFormOperationsAction().then((ops) => {
      if (!cancelled) setOperations(ops);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <AdminModal
      title="Новый шаблон маршрута"
      subtitle="Код, название и шаги. Шаблон появится и в /admin/routes."
      onClose={onCancel}
      width={720}
      zIndex={zIndex}
    >
      <div className="admin-size-plan-modal__body">
        {operations === null ? (
          <p className="admin-muted">Загружаем операции…</p>
        ) : (
          <RouteTemplateForm
            mode="create"
            operations={operations}
            inline
            onCreated={onCreated}
          />
        )}
      </div>
    </AdminModal>
  );
}
