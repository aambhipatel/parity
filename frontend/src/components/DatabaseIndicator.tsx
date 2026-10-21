import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Database, ChevronDown, Check, RefreshCw, ArrowRight, HardDrive, Edit2, Shield, Lock, Star } from 'lucide-react';
import {
  getCurrentDatabase,
  listDatabases,
  switchDatabase,
  renameDatabase,
  setDefaultDatabase,
  resetToDefaultDatabase,
} from '../services/api';
import type { DatabaseInfo } from '../types';
import { cn } from '../utils/helpers';

export function DatabaseIndicator() {
  const [currentDb, setCurrentDb] = useState<DatabaseInfo | null>(null);
  const [databases, setDatabases] = useState<DatabaseInfo[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isSwitching, setIsSwitching] = useState(false);
  const [renameTarget, setRenameTarget] = useState<DatabaseInfo | null>(null);
  const [newDisplayName, setNewDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [unlockTarget, setUnlockTarget] = useState<DatabaseInfo | null>(null);
  const [unlockPassword, setUnlockPassword] = useState('');
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  const loadData = async () => {
    try {
      const [curr, list] = await Promise.all([
        getCurrentDatabase(),
        listDatabases(),
      ]);
      setCurrentDb(curr);
      setDatabases(list.databases || []);
      setError(null);
    } catch (err: any) {
      console.error('Failed to load database status:', err);
    }
  };

  useEffect(() => {
    loadData();

    const handleDbChange = () => {
      loadData();
    };

    window.addEventListener('database-changed', handleDbChange);
    return () => window.removeEventListener('database-changed', handleDbChange);
  }, []);

  // Close dropdown on click outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setRenameTarget(null);
        setUnlockTarget(null);
        setUnlockPassword('');
        setUnlockError(null);
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  const handleInitiateSwitch = (db: DatabaseInfo) => {
    if (currentDb?.filename === db.filename || isSwitching) return;
    if (db.is_protected) {
      setUnlockTarget(db);
      setUnlockPassword('');
      setUnlockError(null);
      setRenameTarget(null);
    } else {
      handleSwitch(db.filename);
    }
  };

  const handleSwitch = async (filename: string, password?: string) => {
    if (isSwitching) return;
    setIsSwitching(true);
    setError(null);
    setUnlockError(null);
    try {
      const res = await switchDatabase(filename, password);
      setCurrentDb(res.database);
      setIsOpen(false);
      setUnlockTarget(null);
      setUnlockPassword('');
      window.dispatchEvent(new CustomEvent('database-changed', { detail: { filename, database: res.database } }));
      await loadData();
    } catch (err: any) {
      const isProtectedErr = err.message?.toLowerCase().includes('password protected') || err.message?.toLowerCase().includes('password required');
      if (isProtectedErr) {
        const dbObj = databases.find(d => d.filename === filename);
        if (dbObj) {
          setUnlockTarget(dbObj);
          setUnlockPassword('');
          setUnlockError(err.message);
        } else {
          setError(err.message);
        }
      } else if (unlockTarget) {
        setUnlockError(err.message || 'Incorrect password.');
      } else {
        setError(err.message || 'Failed to switch database');
      }
    } finally {
      setIsSwitching(false);
    }
  };

  const handleSetDefault = async (filename: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await setDefaultDatabase(filename);
      await loadData();
      window.dispatchEvent(new CustomEvent('database-changed'));
    } catch (err: any) {
      setError(err.message || 'Failed to set default database');
    }
  };

  const handleResetToDefault = async () => {
    if (isSwitching) return;
    setIsSwitching(true);
    setError(null);
    try {
      const res = await resetToDefaultDatabase();
      setCurrentDb(res.database);
      setIsOpen(false);
      window.dispatchEvent(new CustomEvent('database-changed', { detail: { filename: res.database.filename, database: res.database } }));
      await loadData();
    } catch (err: any) {
      if (err.message?.toLowerCase().includes('password')) {
        const defaultDb = databases.find(d => d.is_default);
        if (defaultDb) {
          setUnlockTarget(defaultDb);
          setUnlockPassword('');
          setUnlockError(err.message);
        }
      } else {
        setError(err.message || 'Failed to reset to default database');
      }
    } finally {
      setIsSwitching(false);
    }
  };

  const handleQuickRename = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!renameTarget || !newDisplayName.trim()) return;
    try {
      await renameDatabase(renameTarget.filename, newDisplayName.trim());
      setRenameTarget(null);
      setNewDisplayName('');
      await loadData();
      window.dispatchEvent(new CustomEvent('database-changed'));
    } catch (err: any) {
      setError(err.message || 'Failed to rename database');
    }
  };

  const formatBytes = (bytes: number) => {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Pill Badge */}
      <button
        type="button"
        onClick={() => {
          setIsOpen(!isOpen);
          if (!isOpen) loadData();
        }}
        className={cn(
          'flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium transition-all duration-200 select-none border',
          isOpen
            ? 'bg-surface-lighter text-text-primary border-primary-500/50 shadow-md shadow-primary-500/10'
            : 'bg-surface-card/80 hover:bg-surface-lighter text-text-secondary hover:text-text-primary border-border/80 hover:border-border'
        )}
        title="Active SQLite Database • Click to view or switch"
        aria-label="Active SQLite Database"
      >
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success-400 opacity-75"></span>
          <span className="relative inline-flex rounded-full h-2 w-2 bg-success-500"></span>
        </span>

        <Database size={13} className="text-primary-400 shrink-0" />

        <span className="font-semibold text-text-primary truncate max-w-[130px] sm:max-w-[180px]">
          {currentDb ? currentDb.display_name : 'Loading...'}
        </span>

        {currentDb?.is_default && (
          <span className="inline-flex items-center text-amber-400" title="Default Database (loads on start/reload)">
            <Star size={11} className="fill-amber-400" />
          </span>
        )}

        {currentDb?.is_protected && (
          <span className="inline-flex items-center text-amber-400" title="Password Protected">
            <Lock size={11} />
          </span>
        )}

        <span className="hidden sm:inline-block font-mono text-[10px] text-text-muted px-1.5 py-0.5 rounded bg-surface/60 border border-border/40 shrink-0">
          {currentDb ? currentDb.filename : '...'}
        </span>

        <ChevronDown
          size={12}
          className={cn('text-text-muted transition-transform duration-200 shrink-0', isOpen && 'rotate-180 text-text-primary')}
        />
      </button>

      {/* Dropdown Menu */}
      {isOpen && (
        <div className="absolute right-0 mt-2 w-80 sm:w-96 rounded-2xl bg-surface-card border border-border shadow-2xl z-50 overflow-hidden animate-in fade-in slide-in-from-top-2 duration-150">
          {/* Header */}
          <div className="p-3.5 border-b border-border/60 bg-surface/50">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <HardDrive size={15} className="text-primary-400" />
                <span className="text-xs font-bold text-text-primary uppercase tracking-wider">Active Database</span>
              </div>
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-success-400 bg-success-500/10 px-2 py-0.5 rounded-full border border-success-500/20">
                <Check size={11} /> Connected
              </span>
            </div>

            {currentDb && (
              <div className="mt-2.5 p-2.5 rounded-xl bg-surface-card border border-border/70 space-y-1">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="font-semibold text-sm text-text-primary truncate">{currentDb.display_name}</span>
                    {currentDb.is_default && (
                      <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-500/15 text-amber-400 border border-amber-500/30 shrink-0">
                        <Star size={9} className="fill-amber-400" /> Default
                      </span>
                    )}
                    {currentDb.is_protected && (
                      <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-500/15 text-amber-400 border border-amber-500/30 shrink-0">
                        <Lock size={9} /> Protected
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    {!currentDb.is_default && (
                      <button
                        type="button"
                        onClick={(e) => handleSetDefault(currentDb.filename, e)}
                        className="px-2 py-0.5 text-[10px] rounded font-medium text-amber-400 hover:bg-amber-500/10 border border-amber-500/30 flex items-center gap-1 transition-colors"
                        title="Make this the default database to load on server start and page reload"
                      >
                        <Star size={9} />
                        <span>Set Default</span>
                      </button>
                    )}
                    <button
                      onClick={() => {
                        setRenameTarget(currentDb);
                        setNewDisplayName(currentDb.display_name);
                      }}
                      className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-surface-lighter transition-colors"
                      title="Rename this database"
                    >
                      <Edit2 size={12} />
                    </button>
                  </div>
                </div>
                <div className="font-mono text-[11px] text-text-muted truncate">{currentDb.filename}</div>
                <div className="flex items-center gap-3 text-[11px] text-text-secondary pt-1">
                  <span>Size: {formatBytes(currentDb.size_bytes)}</span>
                  <span>•</span>
                  <span>{currentDb.accounts_count || 0} accounts</span>
                  <span>•</span>
                  <span>{currentDb.transactions_count || 0} transactions</span>
                </div>

                {/* Return to Default DB Shortcut */}
                {!currentDb.is_default && (
                  <button
                    type="button"
                    disabled={isSwitching}
                    onClick={handleResetToDefault}
                    className="w-full mt-2 py-1 px-2 rounded-lg bg-surface border border-border hover:border-amber-500/50 text-[11px] font-medium text-text-secondary hover:text-amber-400 flex items-center justify-center gap-1.5 transition-colors"
                  >
                    <RefreshCw size={11} className={isSwitching ? 'animate-spin' : ''} />
                    <span>Return to Default Database</span>
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Quick Unlock Form */}
          {unlockTarget && (
            <div className="p-3 border-b border-amber-500/30 bg-amber-500/10 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-text-primary">
                  <Lock size={12} className="text-amber-400" />
                  <span>Unlock {unlockTarget.display_name}</span>
                </div>
                <span className="font-mono text-[10px] text-text-muted">{unlockTarget.filename}</span>
              </div>
              <p className="text-[11px] text-text-secondary">
                This database is password protected. Enter password to switch.
              </p>
              {unlockError && (
                <div className="text-[11px] text-danger-400 font-medium">{unlockError}</div>
              )}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleSwitch(unlockTarget.filename, unlockPassword);
                }}
                className="space-y-2"
              >
                <input
                  type="password"
                  value={unlockPassword}
                  onChange={(e) => setUnlockPassword(e.target.value)}
                  placeholder="Enter database password"
                  className="w-full px-2.5 py-1.5 text-xs rounded-lg bg-surface border border-border text-text-primary focus:outline-none focus:border-amber-500"
                  autoFocus
                />
                <div className="flex justify-end gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      setUnlockTarget(null);
                      setUnlockPassword('');
                      setUnlockError(null);
                    }}
                    className="px-2.5 py-1 text-xs text-text-muted hover:text-text-primary"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={isSwitching || !unlockPassword}
                    className="px-3 py-1 text-xs font-medium bg-amber-500 hover:bg-amber-600 text-white rounded-lg transition-colors flex items-center gap-1 disabled:opacity-50"
                  >
                    {isSwitching ? <RefreshCw size={11} className="animate-spin" /> : <Lock size={11} />}
                    <span>Unlock & Switch</span>
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* Quick Rename Form */}
          {renameTarget && (
            <form onSubmit={handleQuickRename} className="p-3 border-b border-border bg-primary-500/5 space-y-2">
              <div className="text-xs font-semibold text-text-primary">
                Rename <span className="font-mono text-primary-400">{renameTarget.filename}</span>
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newDisplayName}
                  onChange={(e) => setNewDisplayName(e.target.value)}
                  placeholder="Enter display name"
                  className="flex-1 px-2.5 py-1.5 text-xs rounded-lg bg-surface border border-border text-text-primary focus:outline-none focus:border-primary-500"
                  autoFocus
                />
                <button
                  type="submit"
                  className="px-3 py-1.5 text-xs font-medium bg-primary-500 hover:bg-primary-600 text-white rounded-lg transition-colors"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => setRenameTarget(null)}
                  className="px-2 py-1.5 text-xs text-text-muted hover:text-text-primary"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          {/* Error Message */}
          {error && (
            <div className="px-3 py-2 text-xs text-danger-400 bg-danger-500/10 border-b border-danger-500/20">
              {error}
            </div>
          )}

          {/* Database Switcher List */}
          <div className="p-2 max-h-60 overflow-y-auto space-y-1">
            <div className="px-2 py-1 text-[11px] font-semibold text-text-muted uppercase tracking-wider">
              Available Database Files ({databases.length})
            </div>

            {databases.map((db) => {
              const isActive = db.filename === currentDb?.filename;
              return (
                <div
                  key={db.filename}
                  className={cn(
                    'flex items-center justify-between p-2 rounded-xl transition-colors text-xs',
                    isActive
                      ? 'bg-primary-500/10 border border-primary-500/20 text-text-primary'
                      : 'hover:bg-surface-lighter text-text-secondary hover:text-text-primary'
                  )}
                >
                  <div className="min-w-0 pr-2">
                    <div className="flex items-center gap-1.5">
                      <span className="font-semibold text-text-primary truncate">{db.display_name}</span>
                      {db.is_default && (
                        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.2 rounded text-[9px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30">
                          <Star size={8} className="fill-amber-300" /> DEFAULT
                        </span>
                      )}
                      {db.is_protected && (
                        <span title="Password Protected" className="inline-flex items-center">
                          <Lock size={11} className="text-amber-400 shrink-0" />
                        </span>
                      )}
                      {isActive && (
                        <span className="px-1.5 py-0.2 rounded text-[9px] font-bold bg-primary-500/20 text-primary-300">
                          ACTIVE
                        </span>
                      )}
                    </div>
                    <div className="font-mono text-[10px] text-text-muted truncate">
                      {db.filename} • {formatBytes(db.size_bytes)}
                    </div>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={(e) => handleSetDefault(db.filename, e)}
                      className={cn(
                        'p-1 rounded transition-colors',
                        db.is_default
                          ? 'text-amber-400 bg-amber-500/10'
                          : 'text-text-muted hover:text-amber-400 hover:bg-surface'
                      )}
                      title={db.is_default ? 'Default Database (loads on startup/reload)' : 'Set as Default Database (loads on startup/reload)'}
                    >
                      <Star size={12} className={db.is_default ? 'fill-amber-400' : ''} />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setRenameTarget(db);
                        setNewDisplayName(db.display_name);
                      }}
                      className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-surface transition-colors"
                      title="Rename"
                    >
                      <Edit2 size={12} />
                    </button>
                    {!isActive ? (
                      <button
                        type="button"
                        disabled={isSwitching}
                        onClick={() => handleInitiateSwitch(db)}
                        className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-surface-lighter hover:bg-primary-500 hover:text-white text-text-primary border border-border hover:border-primary-500 transition-all flex items-center gap-1"
                      >
                        {isSwitching && unlockTarget?.filename === db.filename ? (
                          <RefreshCw size={11} className="animate-spin" />
                        ) : db.is_protected ? (
                          <>
                            <Lock size={10} />
                            <span>Unlock</span>
                          </>
                        ) : (
                          'Switch'
                        )}
                      </button>
                    ) : (
                      <span className="p-1 text-primary-400">
                        <Check size={14} />
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Footer Action */}
          <div className="p-2.5 border-t border-border/60 bg-surface/40 flex items-center justify-between">
            <button
              type="button"
              onClick={() => {
                setIsOpen(false);
                navigate('/admin');
              }}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold text-text-secondary hover:text-text-primary bg-surface-lighter/60 hover:bg-surface-lighter transition-colors"
            >
              <Shield size={13} className="text-warning-400" />
              <span>Full Database Management in Admin Panel</span>
              <ArrowRight size={13} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
