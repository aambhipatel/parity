import { cn } from '../utils/helpers';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
}

export function Input({ label, error, className, id, ...props }: InputProps) {
  const inputId = id || label.toLowerCase().replace(/\s/g, '-');
  return (
    <div className="space-y-1.5">
      <label htmlFor={inputId} className="block text-sm font-medium text-text-secondary">
        {label}
      </label>
      <input
        id={inputId}
        className={cn(
          'w-full px-3 py-2.5 rounded-xl bg-surface border border-border text-text-primary',
          'placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary-500/40 focus:border-primary-500',
          'transition-all duration-150',
          error && 'border-danger-500 focus:ring-danger-500/40',
          className
        )}
        {...props}
      />
      {error && <p className="text-xs text-danger-400">{error}</p>}
    </div>
  );
}

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  options: { value: string; label: string }[];
  error?: string;
}

export function Select({ label, options, error, className, id, ...props }: SelectProps) {
  const selectId = id || label.toLowerCase().replace(/\s/g, '-');
  return (
    <div className="space-y-1.5">
      <label htmlFor={selectId} className="block text-sm font-medium text-text-secondary">
        {label}
      </label>
      <select
        id={selectId}
        className={cn(
          'w-full px-3 py-2.5 rounded-xl bg-surface border border-border text-text-primary',
          'focus:outline-none focus:ring-2 focus:ring-primary-500/40 focus:border-primary-500',
          'transition-all duration-150 appearance-none',
          error && 'border-danger-500',
          className
        )}
        {...props}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      {error && <p className="text-xs text-danger-400">{error}</p>}
    </div>
  );
}

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md';
}

export function Button({ variant = 'primary', size = 'md', className, children, ...props }: ButtonProps) {
  const base = 'inline-flex items-center justify-center gap-2 font-medium rounded-xl transition-all duration-150 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed';
  const sizes = {
    sm: 'px-3 py-1.5 text-sm',
    md: 'px-4 py-2.5 text-sm',
  };
  const variants = {
    primary: 'bg-primary-600 text-white hover:bg-primary-500 shadow-md shadow-primary-500/20',
    secondary: 'bg-surface-lighter text-text-primary hover:bg-surface-lighter/80 border border-border',
    danger: 'bg-danger-600 text-white hover:bg-danger-500',
    ghost: 'text-text-secondary hover:text-text-primary hover:bg-surface-lighter',
  };
  return (
    <button className={cn(base, sizes[size], variants[variant], className)} {...props}>
      {children}
    </button>
  );
}
