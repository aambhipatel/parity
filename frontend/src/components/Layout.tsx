import { useState, useEffect } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Landmark,
  ArrowLeftRight,
  FileText,
  ChevronRight,
  CircleDollarSign,
  TrendingUp,
  Shield,
  PanelLeftClose,
  PanelLeftOpen,
  Sun,
  Moon,
  Eye,
  EyeOff,
} from 'lucide-react';
import { cn } from '../utils/helpers';
import { Tooltip } from './Tooltip';
import { DatabaseIndicator } from './DatabaseIndicator';
import { useTheme } from '../context/ThemeContext';
import { usePrivacy } from '../context/PrivacyContext';

const navItems = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/accounts', icon: Landmark, label: 'Accounts' },
  { to: '/transactions', icon: ArrowLeftRight, label: 'Transactions' },
  { to: '/reports', icon: FileText, label: 'Reports' },
  { to: '/options', icon: TrendingUp, label: 'Options' },
];

export function Layout() {
  const location = useLocation();
  const [dbKey, setDbKey] = useState(0);
  const { theme, toggleTheme } = useTheme();
  const { hideAmounts, toggleHideAmounts } = usePrivacy();

  useEffect(() => {
    const handleDbChange = () => {
      // Re-render active page data without a full browser reload
      setDbKey((k) => k + 1);
    };
    const handlePrivacyChange = () => {
      setDbKey((k) => k + 1);
    };
    window.addEventListener('database-changed', handleDbChange);
    window.addEventListener('privacy-mode-changed', handlePrivacyChange);
    return () => {
      window.removeEventListener('database-changed', handleDbChange);
      window.removeEventListener('privacy-mode-changed', handlePrivacyChange);
    };
  }, []);

  const [isCollapsed, setIsCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('parity-sidebar-collapsed') === 'true';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem('parity-sidebar-collapsed', String(isCollapsed));
    } catch {
      // ignore
    }
  }, [isCollapsed]);

  // Keyboard shortcut: Ctrl+B or Cmd+B or Ctrl+[ or Cmd+[ to toggle sidebar
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'b' || e.key === '[')) {
        const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
        if (tag !== 'input' && tag !== 'textarea') {
          e.preventDefault();
          setIsCollapsed((prev) => !prev);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <div className="flex h-screen overflow-hidden flex-col md:flex-row">
      {/* Sidebar (Desktop) */}
      <aside
        className={cn(
          'hidden md:flex flex-shrink-0 bg-surface-card border-r border-border flex-col transition-[width] duration-300 ease-in-out relative z-30 select-none',
          isCollapsed ? 'w-[72px]' : 'w-64'
        )}
      >
        {/* Logo & Header */}
        <div
          className={cn(
            'border-b border-border/50 transition-all duration-300',
            isCollapsed ? 'py-4 px-2 flex flex-col items-center gap-3' : 'p-5 flex items-center justify-between'
          )}
        >
          <div className={cn('flex items-center gap-3 min-w-0', isCollapsed && 'justify-center')}>
            <Tooltip content="Parity Financial Intelligence" enabled={isCollapsed} side="right">
              <div
                onClick={() => isCollapsed && setIsCollapsed(false)}
                className={cn(
                  'w-9 h-9 rounded-xl bg-primary-600 flex items-center justify-center shadow-md shadow-primary-950/40 border border-primary-400/25 shrink-0',
                  isCollapsed && 'cursor-pointer hover:scale-105 transition-transform'
                )}
              >
                <CircleDollarSign size={20} className="text-white" />
              </div>
            </Tooltip>
            {!isCollapsed && (
              <div className="min-w-0 overflow-hidden">
                <h1 className="text-base font-bold text-text-primary tracking-tight truncate">Parity</h1>
                <p className="text-[10px] text-text-muted font-medium truncate">Financial Intelligence</p>
              </div>
            )}
          </div>

          <Tooltip
            content={isCollapsed ? 'Expand sidebar (Ctrl+B)' : 'Collapse sidebar (Ctrl+B)'}
            side={isCollapsed ? 'right' : 'bottom'}
          >
            <button
              type="button"
              onClick={() => setIsCollapsed(!isCollapsed)}
              className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-lighter/80 transition-colors shrink-0 focus:outline-none focus:ring-1 focus:ring-primary-500/40"
              aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              title={isCollapsed ? 'Expand sidebar (Ctrl+B)' : 'Collapse sidebar (Ctrl+B)'}
            >
              {isCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
            </button>
          </Tooltip>
        </div>

        {/* Navigation */}
        <nav className={cn('flex-1 space-y-1 mt-3', isCollapsed ? 'px-2' : 'px-3')}>
          {navItems.map(({ to, icon: Icon, label }) => (
            <Tooltip
              key={to}
              content={label}
              side="right"
              enabled={isCollapsed}
              className={isCollapsed ? 'w-full justify-center' : 'w-full'}
            >
              <NavLink
                to={to}
                end={to === '/'}
                className={({ isActive }) =>
                  cn(
                    'flex items-center rounded-xl text-sm font-medium transition-all duration-200 group relative',
                    isCollapsed
                      ? 'justify-center w-11 h-11 mx-auto'
                      : 'gap-3 px-3 py-2.5 w-full hover:translate-x-1',
                    isActive
                      ? 'bg-primary-500/15 text-primary-300 font-semibold shadow-sm shadow-primary-500/5'
                      : 'text-text-secondary hover:text-text-primary hover:bg-surface-lighter/60'
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    {isActive && (
                      <span className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-5 bg-primary-400 rounded-r-full shadow-sm shadow-primary-400/50" />
                    )}
                    <Icon
                      size={isCollapsed ? 19 : 18}
                      className={cn(
                        'transition-transform duration-200 shrink-0',
                        isActive
                          ? 'text-primary-400 scale-110'
                          : 'group-hover:scale-110 group-hover:text-primary-300'
                      )}
                    />
                    {!isCollapsed && (
                      <>
                        <span className="flex-1 truncate">{label}</span>
                        <ChevronRight
                          size={14}
                          className={cn(
                            'transition-all duration-200 shrink-0',
                            isActive
                              ? 'opacity-70 text-primary-400 translate-x-0.5'
                              : 'opacity-0 -translate-x-1 group-hover:opacity-40 group-hover:translate-x-0'
                          )}
                        />
                      </>
                    )}
                  </>
                )}
              </NavLink>
            </Tooltip>
          ))}
        </nav>

        {/* Footer */}
        <div
          className={cn(
            'border-t border-border/50 transition-all duration-300',
            isCollapsed ? 'p-2 space-y-2' : 'p-4 space-y-3'
          )}
        >
          <Tooltip
            content="Admin"
            side="right"
            enabled={isCollapsed}
            className={isCollapsed ? 'w-full justify-center' : 'w-full'}
          >
            <NavLink
              to="/admin"
              className={({ isActive }) =>
                cn(
                  'flex items-center rounded-xl text-xs font-medium transition-all duration-150 group',
                  isCollapsed ? 'justify-center w-11 h-11 mx-auto' : 'gap-3 px-3 py-2 w-full',
                  isActive
                    ? 'bg-warning-500/10 text-warning-400'
                    : 'text-text-muted hover:text-text-secondary hover:bg-surface-lighter/50'
                )
              }
            >
              <Shield size={isCollapsed ? 17 : 14} className="shrink-0" />
              {!isCollapsed && <span>Admin</span>}
            </NavLink>
          </Tooltip>

          <div
            className={cn(
              'flex items-center transition-all',
              isCollapsed ? 'flex-col gap-2' : 'justify-between gap-2 px-1'
            )}
          >
            <Tooltip
              content={
                <div className="text-left py-0.5">
                  <p className="font-semibold text-text-primary text-xs">User</p>
                  <p className="text-[10px] text-text-muted">default_user</p>
                </div>
              }
              side="right"
              enabled={isCollapsed}
              className={isCollapsed ? 'w-full justify-center' : 'min-w-0 flex-1'}
            >
              <div
                className={cn(
                  'flex items-center rounded-xl transition-all',
                  isCollapsed ? 'justify-center py-1' : 'gap-3 px-1 min-w-0 flex-1'
                )}
              >
                <div className="w-8 h-8 rounded-full bg-surface-lighter border border-border text-text-secondary flex items-center justify-center text-xs font-semibold shrink-0">
                  U
                </div>
                {!isCollapsed && (
                  <div className="flex-1 min-w-0 overflow-hidden">
                    <p className="text-sm font-medium text-text-primary truncate">User</p>
                    <p className="text-xs text-text-muted truncate">default_user</p>
                  </div>
                )}
              </div>
            </Tooltip>

            {/* Controls Group next to User: Privacy Mode & Theme Mode */}
            <div className={cn('flex items-center', isCollapsed ? 'flex-col gap-1.5' : 'gap-1.5 shrink-0')}>
              {/* Privacy Mode Toggle Button */}
              <Tooltip
                content={hideAmounts ? 'Show sensitive amounts (Alt+H)' : 'Hide sensitive amounts (Alt+H)'}
                side={isCollapsed ? 'right' : 'top'}
              >
                <button
                  type="button"
                  onClick={toggleHideAmounts}
                  aria-label={hideAmounts ? 'Show sensitive amounts' : 'Hide sensitive amounts'}
                  className={cn(
                    'relative p-2 rounded-xl border transition-all duration-200 shrink-0 focus:outline-none focus:ring-2 focus:ring-primary-500/40 cursor-pointer shadow-sm active:scale-95',
                    hideAmounts
                      ? 'bg-primary-500/15 border-primary-500/35 text-primary-400 hover:bg-primary-500/25'
                      : 'text-text-secondary hover:text-text-primary hover:bg-surface-lighter border-border/60 hover:border-border'
                  )}
                >
                  {hideAmounts ? (
                    <EyeOff size={16} className="text-primary-400" />
                  ) : (
                    <Eye size={16} className="text-text-secondary" />
                  )}
                </button>
              </Tooltip>

              {/* Dark / Light Mode Button next to User */}
              <Tooltip
                content={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
                side={isCollapsed ? 'right' : 'top'}
              >
                <button
                  type="button"
                  onClick={toggleTheme}
                  aria-label={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
                  className="relative p-2 rounded-xl text-text-secondary hover:text-text-primary hover:bg-surface-lighter border border-border/60 hover:border-border transition-all duration-200 shrink-0 focus:outline-none focus:ring-2 focus:ring-primary-500/40 cursor-pointer shadow-sm active:scale-95"
                >
                  {theme === 'dark' ? (
                    <Sun size={16} className="text-amber-400 transition-transform duration-300 hover:rotate-45" />
                  ) : (
                    <Moon size={16} className="text-primary-600 transition-transform duration-300 hover:-rotate-12" />
                  )}
                </button>
              </Tooltip>
            </div>
          </div>
        </div>
      </aside>

      {/* Main Content Area with Header */}
      <div className="flex-1 flex flex-col h-full overflow-hidden min-w-0">
        {/* Top Header Bar */}
        <header className="h-14 border-b border-border/60 bg-surface/70 backdrop-blur-md px-4 sm:px-6 md:px-8 flex items-center justify-between shrink-0 z-20">
          <div className="flex items-center gap-3">
            {/* Mobile Brand */}
            <div className="md:hidden flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-primary-600 flex items-center justify-center border border-primary-400/25">
                <CircleDollarSign size={16} className="text-white" />
              </div>
              <span className="font-bold text-sm text-text-primary tracking-tight">Parity</span>
            </div>
          </div>

          {/* Top Right Corner DB Indicator, Privacy Toggle, and Mobile Theme Toggle */}
          <div className="flex items-center gap-2 sm:gap-3">
            <button
              type="button"
              onClick={toggleHideAmounts}
              aria-label={hideAmounts ? 'Show sensitive amounts' : 'Hide sensitive amounts'}
              title={hideAmounts ? 'Show sensitive amounts (Alt+H)' : 'Hide sensitive amounts (Alt+H)'}
              className={cn(
                'md:hidden p-2 rounded-xl border transition-all focus:outline-none focus:ring-2 focus:ring-primary-500/40 cursor-pointer',
                hideAmounts
                  ? 'bg-primary-500/15 border-primary-500/35 text-primary-400'
                  : 'text-text-muted hover:text-text-primary hover:bg-surface-lighter border-border/50'
              )}
            >
              {hideAmounts ? (
                <EyeOff size={16} className="text-primary-400" />
              ) : (
                <Eye size={16} />
              )}
            </button>
            <button
              type="button"
              onClick={toggleTheme}
              aria-label={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
              className="md:hidden p-2 rounded-xl text-text-muted hover:text-text-primary hover:bg-surface-lighter border border-border/50 transition-all focus:outline-none focus:ring-2 focus:ring-primary-500/40 cursor-pointer"
            >
              {theme === 'dark' ? (
                <Sun size={16} className="text-amber-400" />
              ) : (
                <Moon size={16} className="text-primary-600" />
              )}
            </button>
            <DatabaseIndicator />
          </div>
        </header>

        {/* Page Content */}
        <main className="flex-1 overflow-y-auto pb-20 md:pb-0 min-w-0">
          <div className="max-w-7xl mx-auto p-4 sm:p-6 md:p-8">
            <Outlet key={location.pathname === '/admin' ? 'admin' : `page-${dbKey}`} />
          </div>
        </main>
      </div>

      {/* Mobile Bottom Nav */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-surface-card border-t border-border flex items-center justify-around z-50 pb-safe">
        {navItems.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              cn(
                'flex flex-col items-center justify-center w-full py-3 gap-1 text-[10px] font-medium transition-colors',
                isActive ? 'text-primary-400' : 'text-text-muted hover:text-text-secondary'
              )
            }
          >
            <Icon size={20} />
            <span className="truncate w-full text-center px-1">{label}</span>
          </NavLink>
        ))}
        <NavLink
          to="/admin"
          className={({ isActive }) =>
            cn(
              'flex flex-col items-center justify-center w-full py-3 gap-1 text-[10px] font-medium transition-colors',
              isActive ? 'text-warning-400' : 'text-text-muted hover:text-text-secondary'
            )
          }
        >
          <Shield size={20} />
          <span className="truncate w-full text-center px-1">Admin</span>
        </NavLink>
      </nav>
    </div>
  );
}
