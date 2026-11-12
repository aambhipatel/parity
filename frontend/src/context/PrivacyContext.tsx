import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { setGlobalHideAmounts } from '../utils/helpers';

interface PrivacyContextType {
  hideAmounts: boolean;
  setHideAmounts: (hide: boolean) => void;
  toggleHideAmounts: () => void;
}

const PrivacyContext = createContext<PrivacyContextType | undefined>(undefined);

export function PrivacyProvider({ children }: { children: ReactNode }) {
  const [hideAmounts, setHideAmountsState] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      try {
        return localStorage.getItem('parity-hide-amounts') === 'true';
      } catch {
        return false;
      }
    }
    return false;
  });

  useEffect(() => {
    setGlobalHideAmounts(hideAmounts);
    const root = document.documentElement;
    if (hideAmounts) {
      root.classList.add('privacy-mode');
    } else {
      root.classList.remove('privacy-mode');
    }
    try {
      localStorage.setItem('parity-hide-amounts', String(hideAmounts));
    } catch {
      // ignore
    }
    window.dispatchEvent(new CustomEvent('privacy-mode-changed', { detail: { hideAmounts } }));
  }, [hideAmounts]);

  // Global keyboard shortcut: Alt+H or Ctrl+Shift+H to toggle privacy mode
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Do not trigger if user is actively typing in an input, textarea, or select
      const target = e.target as HTMLElement;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (
        (e.altKey && (e.key === 'h' || e.key === 'H')) ||
        ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'h' || e.key === 'H'))
      ) {
        e.preventDefault();
        setHideAmountsState((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const setHideAmounts = (hide: boolean) => {
    setHideAmountsState(hide);
  };

  const toggleHideAmounts = () => {
    setHideAmountsState((prev) => !prev);
  };

  return (
    <PrivacyContext.Provider value={{ hideAmounts, setHideAmounts, toggleHideAmounts }}>
      {children}
    </PrivacyContext.Provider>
  );
}

export function usePrivacy() {
  const context = useContext(PrivacyContext);
  if (!context) {
    throw new Error('usePrivacy must be used within a PrivacyProvider');
  }
  return context;
}
