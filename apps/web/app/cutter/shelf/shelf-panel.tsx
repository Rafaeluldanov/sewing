'use client';

/**
 * Клиентская обёртка над `ShelfPlacementPanel` для вкладки «Стеллаж»
 * кабинета раскройщика (`/cutter/shelf`).
 *
 * Зачем обёртка: сам flow размещения кроя в ячейку — это готовый
 * клиентский компонент `apps/web/app/work/shelf-placement-panel.tsx`
 * (камера → confirm ячейки → сессия сканов паспортов, backend
 * `/cells/by-code` → `/passports/by-code` → `/passports/:id/place`).
 * Он требует проп `onClose: () => void`, а страница-вкладка серверная,
 * поэтому колбэк живёт здесь. Логику размещения НЕ дублируем и НЕ
 * трогаем: та же панель работает у помощника раскройщика на `/work`
 * (`active-shift-panel.tsx`), поведение обеих ролей обязано совпадать.
 *
 * Что значит «закрыть» на вкладке: у раскройщика стеллаж — это отдельная
 * вкладка верхнего уровня, а не модалка поверх задачи. Поэтому «Готово»
 * (и отмена скана ячейки) = работа со стеллажом кончилась → уводим
 * раскройщика на вкладку «Раскрой» (`/cutter`), чтобы он не остался на
 * пустом экране: панель в стадии `idle` рендерит `null`.
 *
 * `closing` нужен только для мгновенного read-out на время перехода
 * (RSC-навигация не моментальна) — панель в этот момент уже размонтирована,
 * чтобы повторный клик не открыл камеру заново.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ShelfPlacementPanel } from '@/app/work/shelf-placement-panel';

export function CutterShelfPanel() {
  const router = useRouter();
  const [closing, setClosing] = useState(false);

  if (closing) {
    return (
      <p className="scan-card__hint cutter-shelf__hint" role="status">
        Размещение завершено — возвращаемся к раскрою…
      </p>
    );
  }

  return (
    <ShelfPlacementPanel
      onClose={() => {
        setClosing(true);
        router.push('/cutter');
      }}
    />
  );
}
