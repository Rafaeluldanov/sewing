'use client';

import { useEffect, useRef, useState } from 'react';
import { ModalPortal } from '@/components/modal-portal';
import { triggerScanHaptic } from './feedback';

interface Props {
  onScan: (decodedText: string) => void;
  onClose: () => void;
}

const REGION_ID = 'qr-scanner-region';

/**
 * Модальное окно со сканером QR через камеру устройства.
 *
 * Используется на /work для автозаполнения поля «Код паспорта».
 * Работает только в HTTPS-контексте (требование getUserMedia).
 *
 * Подробнее об ограничениях см. README библиотеки `html5-qrcode`.
 */
export function QrScannerModal({ onScan, onClose }: Props) {
  const scannerRef = useRef<unknown>(null);
  const handledRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(true);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const mod = await import('html5-qrcode');
        if (cancelled) return;
        const instance = new mod.Html5Qrcode(REGION_ID, /* verbose */ false);
        scannerRef.current = instance;

        await instance.start(
          { facingMode: 'environment' },
          {
            fps: 10,
            qrbox: { width: 260, height: 260 },
            aspectRatio: 1.0,
          },
          (decodedText: string) => {
            if (handledRef.current) return;
            handledRef.current = true;
            // Тактильный сигнал даём максимально близко к моменту
            // распознавания (синхронно, ещё до stop/onScan), чтобы
            // швея чувствовала подтверждение «поймали» сразу.
            triggerScanHaptic();
            // Стопаем камеру до того, как закроем окно — иначе на iOS
            // диод/индикатор может «висеть» до следующего рендера.
            instance
              .stop()
              .catch(() => {})
              .finally(() => {
                onScan(decodedText);
              });
          },
          () => {
            // Кадр без QR — это норма, лог не нужен.
          },
        );
        if (!cancelled) setStarting(false);
      } catch (e: unknown) {
        if (cancelled) return;
        const msg =
          e instanceof Error && e.message
            ? e.message
            : 'Не удалось получить доступ к камере';
        setError(msg);
        setStarting(false);
      }
    })();

    return () => {
      cancelled = true;
      const s = scannerRef.current as
        | { isScanning?: boolean; stop: () => Promise<void>; clear: () => void }
        | null;
      if (!s) return;
      const finalize = () => {
        try {
          s.clear();
        } catch {
          /* ignore */
        }
      };
      if (s.isScanning) {
        s.stop().then(finalize).catch(finalize);
      } else {
        finalize();
      }
    };
  }, [onScan]);

  return (
    <ModalPortal>
    <div
      className="qr-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Сканировать QR-код"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="qr-modal__card">
        <div className="qr-modal__header">
          <h3 className="qr-modal__title">Сканирование QR</h3>
          <button
            type="button"
            className="qr-modal__close"
            onClick={onClose}
            aria-label="Закрыть"
          >
            ×
          </button>
        </div>

        {error ? (
          <div className="qr-modal__error" role="alert">
            <p className="qr-modal__error-title">Нет доступа к камере</p>
            <p className="qr-modal__hint">
              Разрешите доступ в настройках браузера и откройте экран по HTTPS.
            </p>
            <p className="qr-modal__hint qr-modal__hint--mono">{error}</p>
          </div>
        ) : (
          <p className="qr-modal__hint">
            {starting
              ? 'Запускаем камеру…'
              : 'Наведите камеру на QR-код паспорта.'}
          </p>
        )}

        <div id={REGION_ID} className="qr-modal__viewport" />

        <button
          type="button"
          className="btn btn-block qr-modal__cancel"
          onClick={onClose}
        >
          Закрыть
        </button>
      </div>
    </div>
    </ModalPortal>
  );
}
