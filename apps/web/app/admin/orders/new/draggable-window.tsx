'use client';

/**
 * Универсальное «окно» для модалок проекта: рендерится в `document.body`
 * через portal, имеет:
 *   - draggable заголовок (захват за header → перетаскивание);
 *   - кнопки «Свернуть» / «Развернуть» / «Восстановить» / «Закрыть»;
 *   - три состояния (`normal | minimized | maximized`).
 *
 * Состояние позиции/размера живёт только в локальном state — закрытие
 * окна сбрасывает его.
 *
 * Не делает focus-trap / ESC-handler / body-scroll-lock — это
 * ответственность вызывающего компонента (на текущих окнах закрытие
 * только через кнопку «×», что нас устраивает).
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Minimize2, Maximize2, Minus, X } from 'lucide-react';
import { ModalPortal } from '@/components/modal-portal';

export type DraggableWindowState = 'normal' | 'minimized' | 'maximized';

interface Props {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Стартовая ширина окна в px (default 720). */
  initialWidth?: number;
  /** Стартовый Y-offset от верхнего края viewport (default 60). */
  initialY?: number;
}

export function DraggableWindow({
  title,
  onClose,
  children,
  initialWidth = 720,
  initialY = 60,
}: Props) {
  const [state, setState] = useState<DraggableWindowState>('normal');
  const [pos, setPos] = useState<{ x: number; y: number }>(() => ({
    x: 0,
    y: initialY,
  }));
  const [width, setWidth] = useState<number>(initialWidth);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);

  // Центрируем по горизонтали при первом монтировании.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const w = Math.min(width, window.innerWidth - 32);
    setWidth(w);
    setPos((p) => ({ ...p, x: Math.max(0, (window.innerWidth - w) / 2) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleHeaderMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (state !== 'normal') return;
      // Перехватываем только если кликнули по самой полосе заголовка,
      // не по дочерней кнопке (min/max/close) — у них stopPropagation.
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        origX: pos.x,
        origY: pos.y,
      };
      function onMove(ev: MouseEvent) {
        if (!dragRef.current) return;
        const nextX = dragRef.current.origX + (ev.clientX - dragRef.current.startX);
        const nextY = dragRef.current.origY + (ev.clientY - dragRef.current.startY);
        setPos({ x: nextX, y: nextY });
      }
      function onUp() {
        dragRef.current = null;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      }
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [state, pos.x, pos.y],
  );

  const cycleMinimize = useCallback(() => {
    setState((s) => (s === 'minimized' ? 'normal' : 'minimized'));
  }, []);
  const cycleMaximize = useCallback(() => {
    setState((s) => (s === 'maximized' ? 'normal' : 'maximized'));
  }, []);

  const stopBubble = (e: React.MouseEvent) => e.stopPropagation();

  const isNormal = state === 'normal';
  const isMin = state === 'minimized';
  const isMax = state === 'maximized';

  const style: React.CSSProperties = isMax
    ? {
        position: 'fixed',
        inset: 16,
        width: 'auto',
        height: 'auto',
        zIndex: 9500,
      }
    : isMin
      ? {
          position: 'fixed',
          left: pos.x,
          top: pos.y,
          width,
          height: 'auto',
          zIndex: 9500,
        }
      : {
          position: 'fixed',
          left: pos.x,
          top: pos.y,
          width,
          maxHeight: 'calc(100vh - 80px)',
          zIndex: 9500,
        };

  return (
    <ModalPortal>
      <div className="dw-overlay" aria-hidden={isMin} role="presentation">
        <div
          ref={containerRef}
          className={`dw-window ${isMax ? 'dw-window--max' : ''} ${isMin ? 'dw-window--min' : ''}`}
          role="dialog"
          aria-modal="true"
          aria-label={title}
          style={style}
        >
          <header
            className="dw-header"
            onMouseDown={handleHeaderMouseDown}
            style={{ cursor: isNormal ? 'move' : 'default' }}
          >
            <h2 className="dw-title">{title}</h2>
            <div className="dw-actions" onMouseDown={stopBubble}>
              <button
                type="button"
                className="dw-icon-btn"
                onClick={cycleMinimize}
                aria-label={isMin ? 'Восстановить' : 'Свернуть'}
                title={isMin ? 'Восстановить' : 'Свернуть'}
              >
                <Minus size={14} strokeWidth={1.8} aria-hidden />
              </button>
              <button
                type="button"
                className="dw-icon-btn"
                onClick={cycleMaximize}
                aria-label={isMax ? 'Восстановить' : 'Развернуть'}
                title={isMax ? 'Восстановить' : 'Развернуть'}
              >
                {isMax ? (
                  <Minimize2 size={14} strokeWidth={1.7} aria-hidden />
                ) : (
                  <Maximize2 size={14} strokeWidth={1.7} aria-hidden />
                )}
              </button>
              <button
                type="button"
                className="dw-icon-btn dw-icon-btn--danger"
                onClick={onClose}
                aria-label="Закрыть"
                title="Закрыть"
              >
                <X size={15} strokeWidth={1.8} aria-hidden />
              </button>
            </div>
          </header>
          {!isMin && <div className="dw-body">{children}</div>}
        </div>
        <DraggableWindowStyles />
      </div>
    </ModalPortal>
  );
}

function DraggableWindowStyles() {
  return (
    <style>{`
      .dw-overlay {
        position: fixed; inset: 0;
        background: rgba(15, 23, 42, 0.35);
        pointer-events: none;
        z-index: 9400;
      }
      .dw-window {
        pointer-events: auto;
        background: #fff;
        border-radius: 10px;
        box-shadow: 0 20px 50px rgba(15, 23, 42, 0.30);
        display: flex; flex-direction: column;
        overflow: hidden;
        border: 1px solid #e2e8f0;
      }
      .dw-window--min .dw-header { border-bottom: none; }
      .dw-window--max { border-radius: 8px; }
      .dw-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 8px 12px;
        background: #f8fafc;
        border-bottom: 1px solid #e2e8f0;
        user-select: none;
        flex: 0 0 auto;
      }
      .dw-title {
        margin: 0;
        font-size: 0.95rem;
        font-weight: 600;
        color: #0f172a;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .dw-actions { display: flex; gap: 4px; }
      .dw-icon-btn {
        background: transparent;
        border: 1px solid transparent;
        cursor: pointer;
        padding: 4px 6px;
        border-radius: 4px;
        color: #475569;
      }
      .dw-icon-btn:hover { background: #e2e8f0; }
      .dw-icon-btn--danger:hover { background: #fee2e2; color: #b91c1c; }
      .dw-body {
        flex: 1 1 auto;
        overflow: auto;
        padding: 16px 18px 18px;
      }
    `}</style>
  );
}
