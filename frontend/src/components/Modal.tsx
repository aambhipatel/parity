import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  centered?: boolean;
  maxWidth?: string;
}

export function Modal({
  open,
  onClose,
  title,
  children,
  centered = true,
  maxWidth = 'max-w-lg'
}: ModalProps) {
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className={`fixed inset-0 z-50 flex justify-center ${
        centered ? 'items-center' : 'items-start pt-16 md:pt-20'
      } p-4 overflow-y-auto`}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        className={`relative bg-surface-card border border-border rounded-2xl shadow-2xl w-full ${maxWidth} mx-auto ${
          centered ? 'my-auto' : 'my-0'
        } max-h-[90vh] overflow-y-auto animate-in fade-in zoom-in-95 duration-200 z-10`}
      >
        <div className="flex items-center justify-between p-6 border-b border-border sticky top-0 bg-surface-card/95 backdrop-blur z-10">
          <h2 className="text-lg font-semibold text-text-primary">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close dialog"
            className="p-1 rounded-lg hover:bg-surface-lighter text-text-secondary hover:text-text-primary transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500/40 cursor-pointer"
          >
            <X size={20} />
          </button>
        </div>
        <div className="p-6">{children}</div>
      </div>
    </div>,
    document.body
  );
}

