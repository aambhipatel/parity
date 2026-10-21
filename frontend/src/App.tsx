import { lazy, Suspense, useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Layout } from './components/Layout';
import { LoadingSpinner } from './components/StatusIndicators';
import { resetToDefaultDatabase } from './services/api';
import { ThemeProvider } from './context/ThemeContext';

const DashboardPage = lazy(() => import('./pages/DashboardPage').then(m => ({ default: m.DashboardPage })));
const AccountsPage = lazy(() => import('./pages/AccountsPage').then(m => ({ default: m.AccountsPage })));
const TransactionsPage = lazy(() => import('./pages/TransactionsPage').then(m => ({ default: m.TransactionsPage })));
const ReportsPage = lazy(() => import('./pages/ReportsPage').then(m => ({ default: m.ReportsPage })));
const InvestmentsPage = lazy(() => import('./pages/InvestmentsPage').then(m => ({ default: m.InvestmentsPage })));
const OptionsPage = lazy(() => import('./pages/OptionsPage').then(m => ({ default: m.OptionsPage })));
const AdminPage = lazy(() => import('./pages/AdminPage').then(m => ({ default: m.AdminPage })));

export default function App() {
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    // Ensure default database is loaded on page reload, fresh session, or server restart
    resetToDefaultDatabase()
      .catch((err) => {
        console.warn('Default database initialization on load:', err.message);
      })
      .finally(() => {
        setInitialized(true);
      });
  }, []);

  if (!initialized) {
    return (
      <ThemeProvider>
        <div className="h-screen w-screen flex items-center justify-center bg-surface">
          <LoadingSpinner message="Initializing workspace..." />
        </div>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider>
      <BrowserRouter>
        <Suspense fallback={<div className="h-screen w-screen flex items-center justify-center bg-surface"><LoadingSpinner message="Loading workspace..." /></div>}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/accounts" element={<AccountsPage />} />
            <Route path="/transactions" element={<TransactionsPage />} />
            <Route path="/reports" element={<ReportsPage />} />
            <Route path="/investments" element={<InvestmentsPage />} />
            <Route path="/options" element={<OptionsPage />} />
            <Route path="/admin" element={<AdminPage />} />
          </Route>
        </Routes>
      </Suspense>
    </BrowserRouter>
    </ThemeProvider>
  );
}
