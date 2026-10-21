import type { ReactNode } from 'react';
import { cn } from '../utils/helpers';

interface CardProps {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
}

export function Card({ children, className, onClick }: CardProps) {
  return (
    <div
      onClick={onClick}
      className={cn(
        'rounded-2xl bg-surface-card border border-border p-6 shadow-lg shadow-black/10 transition-all duration-200',
        onClick && 'cursor-pointer hover:border-primary-500/40 hover:shadow-primary-500/5',
        className
      )}
    >
      {children}
    </div>
  );
}

export function CardTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <h3 className={cn('text-sm font-medium text-text-secondary mb-1', className)}>{children}</h3>;
}

export function CardValue({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('text-2xl font-bold text-text-primary', className)}>{children}</p>;
}
