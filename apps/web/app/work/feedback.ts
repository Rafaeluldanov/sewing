'use client';

/**
 * Тактильное и звуковое подтверждение в seamstress flow на /work.
 *
 * Только best-effort: ни вибрация, ни звук не должны бросать ошибки
 * и не должны блокировать UI. Если устройство/браузер не поддерживает
 * Vibration API или не разрешает воспроизведение — UX продолжается
 * штатно.
 *
 * Где используется:
 *   - `triggerScanHaptic()` — после успешного распознавания QR
 *     паспорта (`qr-scanner-modal.tsx`).
 *   - `playCutAcceptedSound()` — после backend SUCCESS на «Принять»
 *     в `seamstress-active-panel.tsx` (action
 *     `acceptPassportForIssueAction`).
 *
 * Звук лежит в `/public/sounds/cut-accepted.wav` — короткий (~180 мс)
 * мелодичный «дзынь», не раздражающий и без длинного хвоста. Формат
 * WAV выбран сознательно: ассет генерируется детерминированно, без
 * внешних кодеков, и поддерживается всеми целевыми браузерами PWA
 * (Chromium, Safari, Firefox).
 */

const SOUND_URL = '/sounds/cut-accepted.wav';

const SCAN_VIBRATION_MS = 40;

/**
 * Короткая вибрация после успешного скана QR паспорта.
 * Молча ничего не делает, если Vibration API недоступен.
 */
export function triggerScanHaptic(): void {
  if (typeof navigator === 'undefined') return;
  try {
    navigator.vibrate?.(SCAN_VIBRATION_MS);
  } catch {
    /* fail-soft: вибрация — необязательная роскошь */
  }
}

/**
 * Звуковое подтверждение успешного приёма кроя.
 *
 * Вызывается строго в контексте user gesture (клик «Принять»),
 * поэтому autoplay-политика браузеров пропускает воспроизведение.
 * Любые ошибки воспроизведения (отказ браузера, отсутствие звука,
 * 404) подавляются — UI всё равно показывает success-state.
 */
export function playCutAcceptedSound(): void {
  if (typeof window === 'undefined' || typeof Audio === 'undefined') return;
  try {
    const audio = new Audio(SOUND_URL);
    audio.volume = 0.6;
    const result = audio.play();
    if (result && typeof result.catch === 'function') {
      result.catch(() => {
        /* fail-soft: звук — только подтверждение */
      });
    }
  } catch {
    /* fail-soft */
  }
}

/**
 * Звуковое подтверждение успешного завершения операции (ТЗ §4).
 *
 * Сознательно другое звучание, чем у `playCutAcceptedSound`:
 *   - «приняли» — короткий восходящий «дзынь» (WAV-ассет);
 *   - «завершили» — мягкий нисходящий двухтоновый арпеджио,
 *     чтобы швея ухом отличала «взяла» от «сдала» даже не глядя
 *     на экран.
 *
 * Генерируется Web Audio API на лету: дополнительный бинарный ассет
 * не нужен, синтез детерминированный, никаких сетевых запросов и
 * 404 на проде. В браузерах без Web Audio (или без разрешения на
 * воспроизведение) fail-soft — UI всё равно покажет success-state.
 */
export function playOperationCompletedSound(): void {
  if (typeof window === 'undefined') return;
  // Web Audio доступен в типобезопасном виде не во всех lib.dom
  // (iOS Safari ≤ 14 знает только webkitAudioContext). Проверяем
  // оба имени и мягко выходим, если нет ни одного.
  const Ctor: typeof AudioContext | undefined =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) return;
  try {
    const ctx = new Ctor();
    const now = ctx.currentTime;

    // Нисходящее «до-соль» с коротким хвостом: 660 Гц → 440 Гц,
    // общая длительность ~220 мс. Синусоида — чтобы звук был мягким,
    // не резал ухо в цеху поверх жужжания машин.
    const freqs: [number, number][] = [
      [0.0, 660],
      [0.1, 440],
    ];
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.35, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
    gain.connect(ctx.destination);

    for (const [offset, freq] of freqs) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + offset);
      osc.connect(gain);
      osc.start(now + offset);
      osc.stop(now + offset + 0.12);
    }

    // Закрываем контекст после воспроизведения, чтобы не держать
    // аудио-пайплайн зажатым на каждую модалку (Safari ругается на
    // «too many AudioContexts» при десятках открытий за сессию).
    window.setTimeout(() => {
      ctx.close().catch(() => {
        /* fail-soft */
      });
    }, 400);
  } catch {
    /* fail-soft: звук — только подтверждение */
  }
}

// ---------------------------------------------------------------------------
// Тревога «пришёл брак от ОТК» (см. `seamstress-active-panel.tsx`,
// секция переделок + поллинг `/shifts/my-rework`).
//
// Отличие от подтверждающих звуков выше: этот сигнал должен ПЕРЕБИВАТЬ
// рутину — швея может в этот момент шить другой паспорт и не смотреть
// на экран. Поэтому тембр громче и узнаваемо «тревожный» (три
// восходящих гудка square-волной), а вибрация — длинный паттерн, а не
// короткий тычок скана.
//
// Важная тонкость про autoplay: этот звук играет НЕ в момент user
// gesture (его триггерит фоновый поллинг), поэтому браузер по
// умолчанию заглушит свежесозданный AudioContext. Решение —
// переиспользуем один общий контекст и «разблокируем» (resume) его на
// первом же касании экрана через `armReworkAudio()`. После любого
// тапа швеи (а она всё равно жмёт «Взять крой»/сканирует) контекст
// остаётся «живым» на весь сеанс страницы.
// ---------------------------------------------------------------------------

interface WebkitWindow {
  webkitAudioContext?: typeof AudioContext;
}

let sharedAlertCtx: AudioContext | null = null;
let alertAudioArmed = false;

function getSharedAlertCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor: typeof AudioContext | undefined =
    window.AudioContext ?? (window as unknown as WebkitWindow).webkitAudioContext;
  if (!Ctor) return null;
  if (!sharedAlertCtx) {
    try {
      sharedAlertCtx = new Ctor();
    } catch {
      return null;
    }
  }
  return sharedAlertCtx;
}

/**
 * Один раз навешивает обработчики на первые жесты пользователя, чтобы
 * «разбудить» общий AudioContext тревоги. Без этого браузерная
 * autoplay-политика молча глушит звук, который играет вне контекста
 * клика (а тревога о браке прилетает из фонового поллинга).
 *
 * Идемпотентно: вызывать можно из любого числа эффектов — реальная
 * подписка ставится единожды. Возвращает функцию-отписку (для cleanup
 * в useEffect), хотя слушатели намеренно живут весь сеанс /work.
 */
export function armReworkAudio(): () => void {
  if (typeof window === 'undefined' || alertAudioArmed) return () => {};
  alertAudioArmed = true;
  const unlock = () => {
    const ctx = getSharedAlertCtx();
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(() => {
        /* fail-soft */
      });
    }
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('touchstart', unlock);
  window.addEventListener('keydown', unlock);
  return () => {
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('touchstart', unlock);
    window.removeEventListener('keydown', unlock);
    alertAudioArmed = false;
  };
}

/**
 * Тревожный сигнал «пришёл брак»: три коротких восходящих гудка
 * (880 → 880 → 1175 Гц) square-волной, общая длительность ~0.5 с.
 * Громче и резче подтверждающих звуков — чтобы пробить шум цеха и
 * привлечь внимание. Общий контекст не закрываем (он переиспользуется
 * для повторов сигнала, пока открыт модал тревоги).
 */
export function playReworkAlertSound(): void {
  const ctx = getSharedAlertCtx();
  if (!ctx) return;
  try {
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {
        /* fail-soft */
      });
    }
    const now = ctx.currentTime;
    const beeps: [number, number][] = [
      [0.0, 880],
      [0.18, 880],
      [0.36, 1175],
    ];
    for (const [offset, freq] of beeps) {
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.setValueAtTime(freq, now + offset);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.4, now + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.14);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.16);
    }
  } catch {
    /* fail-soft: тревога — поверх визуального модала, не критично */
  }
}

/**
 * Длинная вибрация-тревога «пришёл брак» (паттерн с паузами, ~0.8 с).
 * Заметно отличается от короткого `triggerScanHaptic`. Молча ничего
 * не делает там, где Vibration API недоступен (iOS Safari, десктоп).
 */
export function triggerReworkHaptic(): void {
  if (typeof navigator === 'undefined') return;
  try {
    navigator.vibrate?.([200, 100, 200, 100, 200]);
  } catch {
    /* fail-soft */
  }
}
