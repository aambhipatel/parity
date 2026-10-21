import { Loader2 } from 'lucide-react';

export function LoadingSpinner({ message = 'Loading...' }: { message?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-3 text-text-secondary">
      <Loader2 size={28} className="animate-spin text-primary-400" />
      <p className="text-sm">{message}</p>
    </div>
  );
}

export function ErrorMessage({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="text-center py-12">
      <p className="text-danger-400 mb-3">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="text-sm text-primary-400 hover:text-primary-300 underline"
        >
          Try again
        </button>
      )}
    </div>
  );
}
