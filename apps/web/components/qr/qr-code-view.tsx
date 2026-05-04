'use client';

/**
 * Единый frontend-компонент рендера QR.
 *
 * Контракт:
 *   - Используется ТОЛЬКО клиентский SVG-рендер `qrcode.react`
 *     (named export `QRCodeSVG`). Default-импорт `qrcode.react`
 *     не существует в v4 и ломает сборку — поэтому он явно запрещён
 *     smoke-тестом `tests/smoke/qr-rendering-regression.smoke.test.ts`.
 *   - Любой другой компонент frontend'а, которому нужно показать QR,
 *     должен идти через этот файл (см. тот же smoke-тест:
 *     «никто кроме QrCodeView не импортирует qrcode.react»).
 *   - Внешние QR-API (публичные image-сервисы) запрещены: payload
 *     содержит идентификаторы внутренних сущностей и не должен
 *     покидать периметр. Регрессионный smoke перечисляет конкретные
 *     хосты, которые мы охраняем.
 *
 * Поведение для пустого/невалидного value:
 *   `null` / `undefined` / пустая строка не должны валить рендер —
 *   вместо этого показываем читаемый fallback «QR-код недоступен»
 *   с пометкой `data-testid="qr-code-view"`. Так модалки и табы
 *   остаются открываемыми, даже если backend ответил без `qrPayload`.
 */

import { QRCodeSVG } from 'qrcode.react';

export interface QrCodeViewProps {
  /**
   * Payload, который попадёт в QR. Принимаем `string | null | undefined`,
   * чтобы вызывающий мог пробрасывать «сырые» данные с backend без
   * собственных проверок — нормализация происходит здесь.
   */
  value: string | null | undefined;
  /** Размер стороны QR в пикселях. По умолчанию 220 (под модалку). */
  size?: number;
  /** `<title>` внутри SVG — нужен для accessibility. */
  title?: string;
  /** Дополнительный CSS-класс на корневом контейнере. */
  className?: string;
}

export function QrCodeView({
  value,
  size,
  title,
  className,
}: QrCodeViewProps) {
  const normalizedValue = typeof value === 'string' ? value.trim() : '';

  if (normalizedValue.length === 0) {
    const wrapperClass = ['qr-code-view', 'qr-code-view--empty', className]
      .filter(Boolean)
      .join(' ');
    return (
      <div
        className={wrapperClass}
        role="status"
        data-testid="qr-code-view"
      >
        QR-код недоступен
      </div>
    );
  }

  const wrapperClass = ['qr-code-view', className].filter(Boolean).join(' ');
  return (
    <div className={wrapperClass} data-testid="qr-code-view">
      <QRCodeSVG
        value={normalizedValue}
        size={size ?? 220}
        level="M"
        title={title ?? 'QR-код'}
        data-testid="qr-code-svg"
      />
    </div>
  );
}
