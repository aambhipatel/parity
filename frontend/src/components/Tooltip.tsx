import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../utils/helpers';

export function Tooltip({
  children,
  content,
  enabled = true,
  side = 'auto',
  className,
}: {
  children: React.ReactNode;
  content: React.ReactNode;
  enabled?: boolean;
  side?: 'auto' | 'top' | 'bottom' | 'right' | 'left';
  className?: string;
}) {
  const [isVisible, setIsVisible] = useState(false);
  const [coords, setCoords] = useState<{
    top: number;
    left: number;
    placeAbove: boolean;
    placement: 'top' | 'bottom' | 'right' | 'left' | 'auto';
  } | null>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const mousePosRef = useRef<{ x: number; y: number } | null>(null);

  const calculatePosition = useCallback((clientX?: number, clientY?: number) => {
    if (side === 'right' && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const left = rect.right + 10;
      const top = rect.top + rect.height / 2;
      return { left, top, placeAbove: false, placement: 'right' as const };
    }

    if (side === 'bottom' && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const left = rect.left + rect.width / 2;
      const top = rect.bottom + 8;
      return { left, top, placeAbove: false, placement: 'bottom' as const };
    }
    let cursorX: number;
    let cursorY: number;

    if (clientX !== undefined && clientY !== undefined) {
      cursorX = clientX;
      cursorY = clientY;
      mousePosRef.current = { x: cursorX, y: cursorY };
    } else if (mousePosRef.current) {
      cursorX = mousePosRef.current.x;
      cursorY = mousePosRef.current.y;
    } else if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      cursorX = rect.left + rect.width / 2;
      cursorY = rect.top;
    } else {
      return null;
    }

    const tooltipEl = tooltipRef.current;
    const tooltipHeight = tooltipEl ? tooltipEl.offsetHeight : 36;
    const tooltipWidth = tooltipEl ? tooltipEl.offsetWidth : 160;

    // Check if there is enough space above the cursor (at least tooltipHeight + 12px)
    const placeAbove = cursorY - tooltipHeight - 12 >= 0;

    // Clamp horizontal position so tooltip stays within viewport
    const halfWidth = tooltipWidth / 2;
    const minLeft = halfWidth + 16;
    const maxLeft = window.innerWidth - halfWidth - 16;
    const left = Math.max(minLeft, Math.min(maxLeft, cursorX));

    // Target top position: 8px above cursor when placeAbove, or 16px below cursor when placeBelow
    const top = placeAbove ? cursorY - 8 : cursorY + 16;

    return {
      left,
      top,
      placeAbove,
      placement: placeAbove ? ('top' as const) : ('bottom' as const),
    };
  }, [side]);

  const handleMouseEnter = (e: React.MouseEvent) => {
    const pos = calculatePosition(e.clientX, e.clientY);
    if (pos) setCoords(pos);
    setIsVisible(true);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const pos = calculatePosition(e.clientX, e.clientY);
    if (pos) setCoords(pos);
  };

  const handleMouseLeave = () => {
    setIsVisible(false);
    mousePosRef.current = null;
    setCoords(null);
  };

  const handleFocus = () => {
    mousePosRef.current = null;
    const pos = calculatePosition();
    if (pos) setCoords(pos);
    setIsVisible(true);
  };

  const handleBlur = () => {
    setIsVisible(false);
    mousePosRef.current = null;
    setCoords(null);
  };

  useEffect(() => {
    if (isVisible) {
      // Re-measure on next animation frame once rendered to adjust for exact dimensions
      requestAnimationFrame(() => {
        const pos = calculatePosition();
        if (pos) setCoords(pos);
      });

      const handleScroll = () => {
        const pos = calculatePosition();
        if (pos) setCoords(pos);
      };
      const handleResize = () => {
        const pos = calculatePosition();
        if (pos) setCoords(pos);
      };

      window.addEventListener('scroll', handleScroll, true);
      window.addEventListener('resize', handleResize);
      return () => {
        window.removeEventListener('scroll', handleScroll, true);
        window.removeEventListener('resize', handleResize);
      };
    }
  }, [isVisible, calculatePosition]);

  if (!enabled || !content) {
    return <>{children}</>;
  }

  return (
    <>
      <div
        ref={triggerRef}
        className={cn('relative inline-flex items-center', className)}
        onMouseEnter={handleMouseEnter}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onFocus={handleFocus}
        onBlur={handleBlur}
      >
        {children}
      </div>

      {isVisible && coords && typeof document !== 'undefined' && createPortal(
        <div
          ref={tooltipRef}
          style={{
            position: 'fixed',
            top: `${coords.top}px`,
            left: `${coords.left}px`,
            transform:
              coords.placement === 'right'
                ? 'translate(0, -50%)'
                : coords.placement === 'bottom'
                ? 'translate(-50%, 0)'
                : 'translate(-50%, -100%)',
          }}
          className="z-[99999] pointer-events-none px-3 py-2 text-xs font-medium text-text-primary bg-surface-card rounded-xl shadow-2xl w-max max-w-sm text-center border border-border transition-transform duration-75 animate-in fade-in"
        >
          {content}
          {coords.placement === 'right' ? (
            <div className="absolute right-full top-1/2 -translate-y-1/2 -mr-[1px] border-4 border-transparent border-r-surface-card" />
          ) : coords.placement === 'bottom' ? (
            <div className="absolute left-1/2 -translate-x-1/2 bottom-full -mb-[1px] border-4 border-transparent border-b-surface-card" />
          ) : (
            <div className="absolute left-1/2 -translate-x-1/2 top-full -mt-[1px] border-4 border-transparent border-t-surface-card" />
          )}
        </div>,
        document.body
      )}
    </>
  );
}
