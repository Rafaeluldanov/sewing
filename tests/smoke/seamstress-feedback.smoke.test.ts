/**
 * Smoke-тест tactile/audio фидбека швеи на /work.
 *
 * Полноценного React-рендерера у нас нет (vitest идёт в Node, без
 * jsdom + RTL), поэтому идём тем же путём, что и
 * `frontend-rbac.smoke.test.ts`: фиксируем поведение текстовыми
 * проверками исходников и helper-модуля + smoke-вызовами хелпера в
 * замоканном окружении.
 *
 * Покрываем:
 *   1. Вибрация при успешном скане QR паспорта вызывается синхронно
 *      внутри success-callback `Html5Qrcode.start` — до `onScan` и до
 *      открытия модалки подтверждения.
 *   2. Звук «крой принят» проигрывается ТОЛЬКО после backend SUCCESS
 *      (action `acceptPassportForIssueAction`) и не зовётся ни на
 *      открытии модалки, ни на cancel, ни на error-ветке, ни в
 *      lookup-ветке.
 *   3. Хелперы fail-soft: молчат, когда `navigator.vibrate` или
 *      `Audio` не доступны.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

describe('seamstress feedback wiring (/work)', () => {
  test('qr-scanner-modal импортирует и зовёт triggerScanHaptic в success-колбэке', () => {
    const src = readFileSync(
      path.join(repoRoot, 'apps/web/app/work/qr-scanner-modal.tsx'),
      'utf8',
    );
    expect(src).toMatch(/from '\.\/feedback'/);
    expect(src).toMatch(/triggerScanHaptic\(\)/);

    // Хаптик должен происходить внутри success-колбэка распознавания
    // (после `handledRef.current = true`) и до `instance.stop().*onScan`
    // — иначе вибрация запоздает или вообще пройдёт после закрытия
    // модалки сканера.
    const idxHandled = src.indexOf('handledRef.current = true');
    const idxHaptic = src.indexOf('triggerScanHaptic()');
    const idxStop = src.indexOf('instance\n              .stop()');
    expect(idxHandled).toBeGreaterThan(0);
    expect(idxHaptic).toBeGreaterThan(idxHandled);
    expect(idxStop).toBeGreaterThan(idxHaptic);
  });

  test('seamstress-active-panel зовёт playCutAcceptedSound только после backend SUCCESS', () => {
    const src = readFileSync(
      path.join(repoRoot, 'apps/web/app/work/seamstress-active-panel.tsx'),
      'utf8',
    );
    expect(src).toMatch(/from '\.\/feedback'/);
    // Звук вызывается ровно один раз — на success-ветке `handleAccept`.
    const matches = src.match(/playCutAcceptedSound\(\)/g) ?? [];
    expect(matches.length).toBe(1);

    // Должен идти ПОСЛЕ early-return на ошибку (`if (res.error)`),
    // т.е. ниже соответствующего `return;`.
    const idxErrorReturn = src.indexOf('if (res.error)');
    const idxSound = src.indexOf('playCutAcceptedSound()');
    expect(idxErrorReturn).toBeGreaterThan(0);
    expect(idxSound).toBeGreaterThan(idxErrorReturn);

    // И вызов сидит именно внутри `handleAccept` — за его пределами
    // (в `lookup`, `handleScan`, `handleCancelConfirm`) playCutAcceptedSound
    // не вызывается.
    const handleAcceptStart = src.indexOf('const handleAccept');
    const handleAcceptEnd = src.indexOf(
      'const handleCancelConfirm',
      handleAcceptStart,
    );
    expect(handleAcceptStart).toBeGreaterThan(0);
    expect(handleAcceptEnd).toBeGreaterThan(handleAcceptStart);
    const handleAcceptBlock = src.slice(handleAcceptStart, handleAcceptEnd);
    expect(handleAcceptBlock).toContain('playCutAcceptedSound()');
  });

  test('feedback.ts: triggerScanHaptic — fail-soft без navigator.vibrate', async () => {
    vi.resetModules();
    // jsdom-окружения нет, navigator есть только если объявлен
    // глобально; гарантируем чистое состояние.
    const originalNavigator = (globalThis as { navigator?: unknown }).navigator;
    (globalThis as { navigator?: unknown }).navigator = {};
    try {
      const mod = await import(
        path.join(repoRoot, 'apps/web/app/work/feedback.ts')
      );
      expect(() => mod.triggerScanHaptic()).not.toThrow();
    } finally {
      (globalThis as { navigator?: unknown }).navigator = originalNavigator;
    }
  });

  test('feedback.ts: triggerScanHaptic зовёт navigator.vibrate ровно один раз', async () => {
    vi.resetModules();
    const vibrate = vi.fn();
    const originalNavigator = (globalThis as { navigator?: unknown }).navigator;
    (globalThis as { navigator?: unknown }).navigator = { vibrate } as unknown;
    try {
      const mod = await import(
        path.join(repoRoot, 'apps/web/app/work/feedback.ts')
      );
      mod.triggerScanHaptic();
      expect(vibrate).toHaveBeenCalledTimes(1);
      // Короткий импульс — проверяем диапазон, а не точное значение,
      // чтобы было место для UX-тюнинга.
      const ms = vibrate.mock.calls[0][0];
      expect(typeof ms).toBe('number');
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThanOrEqual(100);
    } finally {
      (globalThis as { navigator?: unknown }).navigator = originalNavigator;
    }
  });

  test('feedback.ts: playCutAcceptedSound — fail-soft без Audio API', async () => {
    vi.resetModules();
    const originalAudio = (globalThis as { Audio?: unknown }).Audio;
    delete (globalThis as { Audio?: unknown }).Audio;
    try {
      const mod = await import(
        path.join(repoRoot, 'apps/web/app/work/feedback.ts')
      );
      expect(() => mod.playCutAcceptedSound()).not.toThrow();
    } finally {
      if (originalAudio !== undefined) {
        (globalThis as { Audio?: unknown }).Audio = originalAudio;
      }
    }
  });

  test('feedback.ts: playCutAcceptedSound — глотает rejected play() promise', async () => {
    vi.resetModules();
    const playMock = vi.fn(() => Promise.reject(new Error('NotAllowedError')));
    class FakeAudio {
      volume = 1;
      constructor(public src: string) {}
      play() {
        return playMock();
      }
    }
    const originalAudio = (globalThis as { Audio?: unknown }).Audio;
    const originalWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { Audio?: unknown }).Audio = FakeAudio as unknown;
    (globalThis as { window?: unknown }).window = {};
    try {
      const mod = await import(
        path.join(repoRoot, 'apps/web/app/work/feedback.ts')
      );
      // Не должен бросать ни синхронно, ни через unhandled rejection.
      expect(() => mod.playCutAcceptedSound()).not.toThrow();
      // Дать микротаску шанс отработать catch.
      await Promise.resolve();
      expect(playMock).toHaveBeenCalledTimes(1);
    } finally {
      if (originalAudio !== undefined) {
        (globalThis as { Audio?: unknown }).Audio = originalAudio;
      } else {
        delete (globalThis as { Audio?: unknown }).Audio;
      }
      if (originalWindow !== undefined) {
        (globalThis as { window?: unknown }).window = originalWindow;
      } else {
        delete (globalThis as { window?: unknown }).window;
      }
    }
  });

  test('звуковой ассет лежит в public/sounds/ и не пустой', () => {
    const buf = readFileSync(
      path.join(repoRoot, 'apps/web/public/sounds/cut-accepted.wav'),
    );
    // Sanity: файл реально является RIFF/WAV и не нулевой длины.
    expect(buf.length).toBeGreaterThan(1024);
    expect(buf.slice(0, 4).toString('ascii')).toBe('RIFF');
    expect(buf.slice(8, 12).toString('ascii')).toBe('WAVE');
  });
});

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});
