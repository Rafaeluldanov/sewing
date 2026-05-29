'use client';

import { useEffect, useRef, useState } from 'react';
import { ModalPortal } from '@/components/modal-portal';
import { triggerScanHaptic } from './feedback';

interface Props {
  onScan: (decodedText: string) => void;
  onClose: () => void;
}

const REGION_ID = 'qr-scanner-region';

type CameraErrorKind =
  | 'insecure'
  | 'unsupported'
  | 'denied'
  | 'no-device'
  | 'busy'
  | 'overconstrained'
  | 'unknown';

interface CameraError {
  kind: CameraErrorKind;
  detail: string;
}

// Подсказка пользователю по типу отказа. Заголовок «Нет доступа к камере»
// одинаковый, а вот действие — разное: запретили в настройках браузера vs
// камера занята vs HTTP вместо HTTPS — лечатся по-разному.
const HINT: Record<CameraErrorKind, string> = {
  insecure:
    'Камера работает только по защищённому соединению (HTTPS). Откройте страницу через https://… вместо http:// или IP-адреса.',
  unsupported:
    'Этот браузер не умеет включать камеру. Откройте сайт в Chrome/Safari вместо встроенного браузера приложения (Telegram, ВК и т.п.).',
  denied:
    'Доступ к камере запрещён в настройках браузера. Откройте настройки сайта (значок замка слева от адреса), включите камеру и перезагрузите страницу.',
  'no-device':
    'Камера не найдена. Проверьте, что у устройства есть камера и она не отключена в настройках системы.',
  busy: 'Камера занята другой вкладкой или приложением. Закройте их и попробуйте снова.',
  overconstrained:
    'Не удалось включить заднюю камеру. Попробуйте ещё раз — возможно, на устройстве доступна только фронтальная.',
  unknown: 'Не удалось включить камеру. Попробуйте ещё раз.',
};

function classifyError(e: unknown): CameraError {
  const detail =
    e instanceof Error && e.message
      ? e.message
      : typeof e === 'string'
        ? e
        : 'Неизвестная ошибка камеры';
  const name = e instanceof Error ? e.name : '';
  const lower = detail.toLowerCase();

  // html5-qrcode иногда оборачивает оригинальный DOMException в Error —
  // поэтому смотрим и на name, и на подстроку в сообщении.
  if (
    name === 'NotAllowedError' ||
    name === 'PermissionDeniedError' ||
    lower.includes('permission denied') ||
    lower.includes('not allowed')
  )
    return { kind: 'denied', detail };
  if (
    name === 'NotFoundError' ||
    name === 'DevicesNotFoundError' ||
    lower.includes('no camera') ||
    lower.includes('requested device not found')
  )
    return { kind: 'no-device', detail };
  if (
    name === 'NotReadableError' ||
    name === 'TrackStartError' ||
    lower.includes('in use') ||
    lower.includes('could not start')
  )
    return { kind: 'busy', detail };
  if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError')
    return { kind: 'overconstrained', detail };
  if (name === 'SecurityError') return { kind: 'insecure', detail };
  return { kind: 'unknown', detail };
}

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
  const [error, setError] = useState<CameraError | null>(null);
  const [starting, setStarting] = useState(true);
  // ModalPortal на первом рендере возвращает null (SSR-guard) и монтирует
  // содержимое только во втором рендере. Если стартовать сканер из обычного
  // useEffect, html5-qrcode не найдёт #qr-scanner-region в DOM. Поэтому
  // привязываемся к фактическому появлению элемента через callback-ref.
  const [region, setRegion] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!region) return;
    let cancelled = false;

    (async () => {
      // Быстрые pre-flight проверки до загрузки тяжёлой библиотеки —
      // даём пользователю понятную подсказку, не дожидаясь падения
      // getUserMedia с непрозрачным сообщением.
      if (typeof window !== 'undefined' && window.isSecureContext === false) {
        setError({ kind: 'insecure', detail: 'window.isSecureContext === false' });
        setStarting(false);
        return;
      }
      if (
        typeof navigator === 'undefined' ||
        !navigator.mediaDevices?.getUserMedia
      ) {
        setError({
          kind: 'unsupported',
          detail: 'navigator.mediaDevices.getUserMedia недоступен',
        });
        setStarting(false);
        return;
      }

      try {
        const mod = await import('html5-qrcode');
        if (cancelled) return;
        const instance = new mod.Html5Qrcode(REGION_ID, /* verbose */ false);
        scannerRef.current = instance;

        const onDecoded = (decodedText: string) => {
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
        };
        const startWith = (config: MediaTrackConstraints | string) =>
          instance.start(
            config,
            { fps: 10, qrbox: { width: 260, height: 260 }, aspectRatio: 1.0 },
            onDecoded,
            () => {
              // Кадр без QR — это норма, лог не нужен.
            },
          );

        // Каскад: пробуем заднюю камеру всё более мягкими способами.
        // 1) exact — гарантия задней, но iOS Safari/часть Android-WebView
        //    могут бросить NotAllowedError/OverconstrainedError на синтаксисе.
        // 2) ideal — подсказка браузеру; на большинстве устройств этого
        //    достаточно, но иногда выбирается фронталка.
        // 3) enumerateDevices — ищем камеру с «задней» меткой.
        // Сообщение «нет доступа» показываем только если ВСЕ три способа
        // провалились (т.е. это правда отказ пользователя / нет HTTPS).
        const attempts: Array<() => Promise<unknown>> = [
          () => startWith({ facingMode: { exact: 'environment' } }),
          () => startWith({ facingMode: 'environment' }),
          async () => {
            const cams = await mod.Html5Qrcode.getCameras();
            if (!cams || cams.length === 0) throw new Error('no cameras');
            const rear =
              cams.find((c) =>
                /back|rear|environment|задн|тыл/i.test(c.label),
              ) ?? cams[cams.length - 1];
            return startWith(rear.id);
          },
        ];
        let lastErr: unknown = null;
        let started = false;
        for (const tryStart of attempts) {
          if (cancelled) return;
          try {
            await tryStart();
            started = true;
            break;
          } catch (e: unknown) {
            lastErr = e;
          }
        }
        if (!started) throw lastErr;
        if (!cancelled) setStarting(false);
      } catch (e: unknown) {
        if (cancelled) return;
        setError(classifyError(e));
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
  }, [onScan, region]);

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
            <p className="qr-modal__hint">{HINT[error.kind]}</p>
            <p className="qr-modal__hint qr-modal__hint--mono">{error.detail}</p>
          </div>
        ) : (
          <p className="qr-modal__hint">
            {starting
              ? 'Запускаем камеру…'
              : 'Наведите камеру на QR-код паспорта.'}
          </p>
        )}

        <div id={REGION_ID} ref={setRegion} className="qr-modal__viewport" />

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
