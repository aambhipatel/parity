import { useState, useEffect, useRef } from 'react';
import { Card, CardTitle } from '../components/Card';
import { Input, Button } from '../components/FormControls';
import { Modal } from '../components/Modal';
import {
  getAdminStatus,
  setAdminPassword,
  verifyAdminPassword,
  changeAdminPassword,
  wipeDatabase,
  listDatabases,
  switchDatabase,
  renameDatabase,
  createDatabase,
  deleteDatabase,
  uploadDatabase,
  protectDatabase,
  unprotectDatabase,
  setDefaultDatabase,
} from '../services/api';
import type { DatabaseInfo } from '../types';
import {
  Shield,
  ShieldCheck,
  AlertTriangle,
  Key,
  KeyRound,
  Trash2,
  Lock,
  Unlock,
  Database,
  RefreshCw,
  Plus,
  Check,
  Edit2,
  Copy,
  HardDrive,
  Upload,
  Star,
} from 'lucide-react';
import { cn } from '../utils/helpers';

type AdminState = 'loading' | 'setup' | 'locked' | 'unlocked';

export function AdminPage() {
  const [state, setState] = useState<AdminState>('loading');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [settingDefaultDb, setSettingDefaultDb] = useState<string | null>(null);

  // Change password form
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmNewPw, setConfirmNewPw] = useState('');

  // Wipe form
  const [wipePw, setWipePw] = useState('');
  const [wipeConfirm, setWipeConfirm] = useState('');

  // Database Management
  const [databases, setDatabases] = useState<DatabaseInfo[]>([]);
  const [loadingDbs, setLoadingDbs] = useState(false);
  const [switchingDb, setSwitchingDb] = useState<string | null>(null);

  // Modals
  const [renameModalOpen, setRenameModalOpen] = useState(false);
  const [targetDb, setTargetDb] = useState<DatabaseInfo | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [newFilename, setNewFilename] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [copyFromCurrent, setCopyFromCurrent] = useState(true);
  const [createDbPassword, setCreateDbPassword] = useState('');
  const [createSetAsDefault, setCreateSetAsDefault] = useState(false);

  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [dbToDelete, setDbToDelete] = useState<DatabaseInfo | null>(null);

  // Database Password Protection Modal State
  const [protectModalOpen, setProtectModalOpen] = useState(false);
  const [protectTargetDb, setProtectTargetDb] = useState<DatabaseInfo | null>(null);
  const [dbCurrentPassword, setDbCurrentPassword] = useState('');
  const [dbNewPassword, setDbNewPassword] = useState('');
  const [dbConfirmNewPassword, setDbConfirmNewPassword] = useState('');
  const [protectAction, setProtectAction] = useState<'set' | 'change' | 'remove'>('set');
  const [protectSubmitting, setProtectSubmitting] = useState(false);
  const [protectError, setProtectError] = useState('');

  // Switch Unlock Modal State
  const [unlockSwitchModalOpen, setUnlockSwitchModalOpen] = useState(false);
  const [unlockSwitchTarget, setUnlockSwitchTarget] = useState<DatabaseInfo | null>(null);
  const [unlockSwitchPassword, setUnlockSwitchPassword] = useState('');
  const [unlockSwitchError, setUnlockSwitchError] = useState('');

  // Upload Modal State
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadDisplayName, setUploadDisplayName] = useState('');
  const [uploadSwitchNow, setUploadSwitchNow] = useState(true);
  const [uploadDbPassword, setUploadDbPassword] = useState('');
  const [uploadSetAsDefault, setUploadSetAsDefault] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getAdminStatus()
      .then((res) => {
        if (!res.password_set) {
          sessionStorage.removeItem('parity_admin_unlocked');
          setState('setup');
        } else {
          const isUnlocked = sessionStorage.getItem('parity_admin_unlocked') === 'true';
          setState(isUnlocked ? 'unlocked' : 'locked');
        }
      })
      .catch(() => setState('setup'));
  }, []);

  const loadDbList = async () => {
    setLoadingDbs(true);
    try {
      const res = await listDatabases();
      setDatabases(res.databases || []);
    } catch (e: any) {
      console.error('Failed to load databases:', e);
    } finally {
      setLoadingDbs(false);
    }
  };

  useEffect(() => {
    if (state === 'unlocked') {
      loadDbList();
    }

    const handleDbChange = () => {
      if (state === 'unlocked') {
        loadDbList();
      }
    };
    window.addEventListener('database-changed', handleDbChange);
    return () => window.removeEventListener('database-changed', handleDbChange);
  }, [state]);

  const handleSetPassword = async () => {
    setError('');
    setSuccess('');
    if (password.length < 4) {
      setError('Password must be at least 4 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    try {
      await setAdminPassword(password);
      sessionStorage.setItem('parity_admin_unlocked', 'true');
      setSuccess('Admin password set! You are now logged in.');
      setState('unlocked');
      setPassword('');
      setConfirmPassword('');
    } catch (e: any) {
      setError(e.message || 'Failed to set admin password.');
    }
  };

  const handleVerify = async () => {
    setError('');
    try {
      const res = await verifyAdminPassword(password);
      if (res.verified) {
        sessionStorage.setItem('parity_admin_unlocked', 'true');
        setState('unlocked');
        setPassword('');
      } else {
        setError('Incorrect password.');
      }
    } catch (e: any) {
      if (e.message && e.message.includes('No admin password set')) {
        sessionStorage.removeItem('parity_admin_unlocked');
        setState('setup');
        setError('No password has been set yet. Please configure a password.');
      } else {
        setError(e.message || 'Incorrect password.');
      }
    }
  };

  const handleLock = () => {
    sessionStorage.removeItem('parity_admin_unlocked');
    setState('locked');
  };

  const handleChangePassword = async () => {
    setError('');
    setSuccess('');
    if (newPw.length < 4) {
      setError('New password must be at least 4 characters.');
      return;
    }
    if (newPw !== confirmNewPw) {
      setError('New passwords do not match.');
      return;
    }
    try {
      await changeAdminPassword(currentPw, newPw);
      setSuccess('Password changed successfully.');
      setCurrentPw('');
      setNewPw('');
      setConfirmNewPw('');
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleWipe = async () => {
    setError('');
    setSuccess('');
    if (wipeConfirm !== 'WIPE') {
      setError('Type WIPE to confirm.');
      return;
    }
    try {
      const res = await wipeDatabase(wipePw);
      setSuccess(res.message);
      setWipePw('');
      setWipeConfirm('');
      loadDbList();
    } catch (e: any) {
      setError(e.message);
    }
  };

  // Switch Database
  const handleInitiateSwitchDb = (db: DatabaseInfo) => {
    if (db.is_protected) {
      setUnlockSwitchTarget(db);
      setUnlockSwitchPassword('');
      setUnlockSwitchError('');
      setUnlockSwitchModalOpen(true);
    } else {
      handleSwitchDb(db.filename);
    }
  };

  const handleSwitchDb = async (filename: string, password?: string) => {
    setError('');
    setSuccess('');
    setUnlockSwitchError('');
    setSwitchingDb(filename);
    try {
      const res = await switchDatabase(filename, password);
      setSuccess(`Active database switched to: ${res.database.display_name} (${res.database.filename})`);
      setUnlockSwitchModalOpen(false);
      setUnlockSwitchTarget(null);
      setUnlockSwitchPassword('');
      window.dispatchEvent(new CustomEvent('database-changed', { detail: { filename, database: res.database } }));
      await loadDbList();
    } catch (e: any) {
      const isProtectedErr = e.message?.toLowerCase().includes('password protected') || e.message?.toLowerCase().includes('password required');
      if (isProtectedErr) {
        const targetDbObj = databases.find(d => d.filename === filename);
        if (targetDbObj) {
          setUnlockSwitchTarget(targetDbObj);
          setUnlockSwitchPassword('');
          setUnlockSwitchError(e.message);
          setUnlockSwitchModalOpen(true);
        } else {
          setError(e.message);
        }
      } else if (unlockSwitchModalOpen) {
        setUnlockSwitchError(e.message || 'Incorrect database password.');
      } else {
        setError(e.message || 'Failed to switch database');
      }
    } finally {
      setSwitchingDb(null);
    }
  };

  // Open Protect Password Modal
  const openProtectModal = (db: DatabaseInfo) => {
    setProtectTargetDb(db);
    setDbCurrentPassword('');
    setDbNewPassword('');
    setDbConfirmNewPassword('');
    setProtectError('');
    setProtectAction(db.is_protected ? 'change' : 'set');
    setProtectModalOpen(true);
  };

  // Submit Password Protection
  const handleSaveProtection = async () => {
    if (!protectTargetDb) return;
    setProtectError('');
    setError('');
    setSuccess('');

    if (protectAction === 'remove') {
      if (!dbCurrentPassword) {
        setProtectError('Please enter current password to remove protection.');
        return;
      }
      setProtectSubmitting(true);
      try {
        const res = await unprotectDatabase(protectTargetDb.filename, dbCurrentPassword);
        setSuccess(res.message);
        setProtectModalOpen(false);
        await loadDbList();
        window.dispatchEvent(new CustomEvent('database-changed'));
      } catch (err: any) {
        setProtectError(err.message || 'Failed to remove password protection.');
      } finally {
        setProtectSubmitting(false);
      }
      return;
    }

    // Set or Change Password
    if (!dbNewPassword || dbNewPassword.length < 4) {
      setProtectError('Password must be at least 4 characters long.');
      return;
    }
    if (dbNewPassword !== dbConfirmNewPassword) {
      setProtectError('New passwords do not match.');
      return;
    }
    if (protectAction === 'change' && !dbCurrentPassword) {
      setProtectError('Please enter current password.');
      return;
    }

    setProtectSubmitting(true);
    try {
      const res = await protectDatabase(
        protectTargetDb.filename,
        dbNewPassword,
        protectAction === 'change' ? dbCurrentPassword : undefined
      );
      setSuccess(res.message);
      setProtectModalOpen(false);
      await loadDbList();
      window.dispatchEvent(new CustomEvent('database-changed'));
    } catch (err: any) {
      setProtectError(err.message || 'Failed to update database password.');
    } finally {
      setProtectSubmitting(false);
    }
  };

  // Open Rename Modal
  const openRenameModal = (db: DatabaseInfo) => {
    setTargetDb(db);
    setRenameValue(db.display_name);
    setRenameModalOpen(true);
  };

  // Submit Rename
  const handleSaveRename = async () => {
    if (!targetDb || !renameValue.trim()) return;
    setError('');
    setSuccess('');
    try {
      await renameDatabase(targetDb.filename, renameValue.trim());
      setSuccess(`Database "${targetDb.filename}" renamed to "${renameValue.trim()}".`);
      setRenameModalOpen(false);
      setTargetDb(null);
      await loadDbList();
      window.dispatchEvent(new CustomEvent('database-changed'));
    } catch (e: any) {
      setError(e.message || 'Failed to rename database');
    }
  };

  // Open Create Modal
  const openCreateModal = (cloneCurrent = true) => {
    setCopyFromCurrent(cloneCurrent);
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    setNewFilename(`finance_${cloneCurrent ? 'clone' : 'new'}_${dateStr}.db`);
    setNewDisplayName(cloneCurrent ? 'Cloned Portfolio' : 'New Database');
    setCreateDbPassword('');
    setCreateSetAsDefault(false);
    setCreateModalOpen(true);
  };

  // Submit Create
  const handleSaveCreate = async () => {
    if (!newFilename.trim()) return;
    setError('');
    setSuccess('');
    try {
      let finalName = newFilename.trim();
      if (!finalName.endsWith('.db')) finalName += '.db';
      await createDatabase(
        finalName,
        newDisplayName.trim(),
        copyFromCurrent,
        createDbPassword ? createDbPassword : undefined,
        createSetAsDefault
      );
      setSuccess(`Database "${finalName}" created successfully!`);
      setCreateModalOpen(false);
      await loadDbList();
      window.dispatchEvent(new CustomEvent('database-changed'));
    } catch (e: any) {
      setError(e.message || 'Failed to create database');
    }
  };

  // Submit Delete
  const handleConfirmDelete = async () => {
    if (!dbToDelete) return;
    setError('');
    setSuccess('');
    try {
      await deleteDatabase(dbToDelete.filename);
      setSuccess(`Database "${dbToDelete.filename}" deleted.`);
      setDeleteModalOpen(false);
      setDbToDelete(null);
      await loadDbList();
      window.dispatchEvent(new CustomEvent('database-changed'));
    } catch (e: any) {
      setError(e.message || 'Failed to delete database');
    }
  };

  // Open Upload Modal
  const openUploadModal = () => {
    setSelectedFile(null);
    setUploadDisplayName('');
    setUploadSwitchNow(true);
    setUploadDbPassword('');
    setUploadSetAsDefault(false);
    setUploadModalOpen(true);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  // Handle File Input Selection
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (!file.name.toLowerCase().endsWith('.db')) {
        setError('Please select a valid SQLite .db file.');
        return;
      }
      setSelectedFile(file);
      const suggested = file.name.replace(/\.db$/i, '').replace(/[_-]/g, ' ');
      setUploadDisplayName(suggested.charAt(0).toUpperCase() + suggested.slice(1));
    }
  };

  // Submit Upload
  const handleUploadDb = async () => {
    if (!selectedFile) return;
    setError('');
    setSuccess('');
    setIsUploading(true);
    try {
      const res = await uploadDatabase(
        selectedFile,
        uploadDisplayName.trim() || undefined,
        uploadSwitchNow,
        uploadDbPassword ? uploadDbPassword : undefined,
        uploadSetAsDefault
      );
      setSuccess(`Database "${res.database.display_name}" (${res.database.filename}) uploaded successfully!`);
      setUploadModalOpen(false);
      setSelectedFile(null);
      await loadDbList();
      window.dispatchEvent(new CustomEvent('database-changed', { detail: { filename: res.database.filename, database: res.database } }));
    } catch (e: any) {
      setError(e.message || 'Failed to upload database file');
    } finally {
      setIsUploading(false);
    }
  };

  // Set Default Database
  const handleSetDefaultDb = async (filename: string) => {
    setError('');
    setSuccess('');
    setSettingDefaultDb(filename);
    try {
      const res = await setDefaultDatabase(filename);
      setSuccess(res.message);
      await loadDbList();
      window.dispatchEvent(new CustomEvent('database-changed'));
    } catch (e: any) {
      setError(e.message || 'Failed to set default database');
    } finally {
      setSettingDefaultDb(null);
    }
  };

  const formatBytes = (bytes: number) => {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  // Loading state
  if (state === 'loading') {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin w-8 h-8 border-2 border-primary-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  // First-time setup: no password exists
  if (state === 'setup') {
    return (
      <div className="max-w-md mx-auto mt-16">
        <Card>
          <div className="flex flex-col items-center text-center mb-6">
            <div className="w-16 h-16 rounded-2xl bg-primary-500/10 flex items-center justify-center mb-4">
              <Shield className="text-primary-400" size={32} />
            </div>
            <h1 className="text-xl font-bold text-text-primary">Set Admin Password</h1>
            <p className="text-text-secondary text-sm mt-2">
              No admin password has been configured yet. Set one now to protect the admin panel.
            </p>
          </div>

          <div className="space-y-4">
            <Input
              label="Password"
              type="password"
              placeholder="Enter a password (min 4 characters)"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <Input
              label="Confirm Password"
              type="password"
              placeholder="Confirm your password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />

            {error && (
              <div className="flex items-center gap-2 text-danger-400 text-sm bg-danger-500/10 border border-danger-500/20 px-3 py-2 rounded-xl">
                <AlertTriangle size={14} />
                {error}
              </div>
            )}
            {success && (
              <div className="flex items-center gap-2 text-success-400 text-sm bg-success-500/10 border border-success-500/20 px-3 py-2 rounded-xl">
                <ShieldCheck size={14} />
                {success}
              </div>
            )}

            <Button onClick={handleSetPassword} className="w-full">
              <Key size={16} />
              Set Admin Password
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  // Locked: password exists but not verified this session
  if (state === 'locked') {
    return (
      <div className="max-w-md mx-auto mt-16">
        <Card>
          <div className="flex flex-col items-center text-center mb-6">
            <div className="w-16 h-16 rounded-2xl bg-warning-500/10 flex items-center justify-center mb-4">
              <Lock className="text-warning-400" size={32} />
            </div>
            <h1 className="text-xl font-bold text-text-primary">Admin Panel Locked</h1>
            <p className="text-text-secondary text-sm mt-2">
              Enter your admin password to access the admin panel.
            </p>
          </div>

          <div className="space-y-4">
            <Input
              label="Admin Password"
              type="password"
              placeholder="Enter your admin password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleVerify()}
            />

            {error && (
              <div className="flex items-center gap-2 text-danger-400 text-sm bg-danger-500/10 border border-danger-500/20 px-3 py-2 rounded-xl">
                <AlertTriangle size={14} />
                {error}
              </div>
            )}

            <Button onClick={handleVerify} className="w-full">
              <ShieldCheck size={16} />
              Unlock
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  // Unlocked: full admin panel
  const activeDb = databases.find((d) => d.is_active);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-success-500/10 flex items-center justify-center">
            <ShieldCheck className="text-success-400" size={22} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Admin Panel</h1>
            <p className="text-text-secondary text-sm">
              Manage database files, switch active data storage, and configure system settings.
            </p>
          </div>
        </div>

        <Button variant="ghost" size="sm" onClick={handleLock}>
          <Lock size={14} />
          Lock Panel
        </Button>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-danger-400 text-sm bg-danger-500/10 border border-danger-500/20 px-3 py-2.5 rounded-xl">
          <AlertTriangle size={14} />
          {error}
        </div>
      )}
      {success && (
        <div className="flex items-center gap-2 text-success-400 text-sm bg-success-500/10 border border-success-500/20 px-3 py-2.5 rounded-xl">
          <ShieldCheck size={14} />
          {success}
        </div>
      )}

      {/* ─── Database Management Section ─── */}
      <Card className="border border-border/80 shadow-lg">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6 pb-4 border-b border-border/60">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-primary-500/10 flex items-center justify-center text-primary-400">
              <Database size={18} />
            </div>
            <div>
              <CardTitle className="!mb-0 text-lg">Database Management</CardTitle>
              <p className="text-xs text-text-muted mt-0.5">
                Switch active database files, customize display labels, or clone datasets for testing.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => loadDbList()}
              disabled={loadingDbs}
              title="Refresh database list"
            >
              <RefreshCw size={13} className={loadingDbs ? 'animate-spin' : ''} />
              <span>Refresh</span>
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => openUploadModal()}
              title="Upload an existing SQLite .db file"
            >
              <Upload size={13} />
              <span>Upload .db</span>
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => openCreateModal(true)}
              title="Clone active database into a new file"
            >
              <Copy size={13} />
              <span>Clone Current</span>
            </Button>
            <Button
              size="sm"
              onClick={() => openCreateModal(false)}
              title="Create a new empty database with schema"
            >
              <Plus size={13} />
              <span>New Database</span>
            </Button>
          </div>
        </div>

        {/* Active DB Spotlight Banner */}
        {activeDb && (
          <div className="mb-6 p-4 rounded-xl bg-surface-card border border-border flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-lg bg-primary-500/15 text-primary-400 border border-primary-500/25 flex items-center justify-center shrink-0 mt-0.5">
                <Check size={16} />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold uppercase tracking-wider text-text-secondary">Current Active Database</span>
                  <span className="text-xs text-text-muted font-mono bg-surface/80 px-2 py-0.5 rounded border border-border/40">
                    {activeDb.filename}
                  </span>
                  {activeDb.is_default ? (
                    <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-400 bg-amber-500/15 px-2 py-0.5 rounded-full border border-amber-500/30">
                      <Star size={10} className="fill-amber-400 text-amber-400" /> Default Database
                    </span>
                  ) : (
                    <button
                      onClick={() => handleSetDefaultDb(activeDb.filename)}
                      disabled={!!settingDefaultDb}
                      className="inline-flex items-center gap-1 text-[11px] font-medium text-text-muted hover:text-amber-400 bg-surface/80 hover:bg-amber-500/10 px-2 py-0.5 rounded-full border border-border/40 hover:border-amber-500/30 transition-colors"
                      title="Set this database as the default to load on startup and reload"
                    >
                      <Star size={10} /> Set as Default
                    </button>
                  )}
                  {activeDb.is_protected && (
                    <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-400 bg-amber-500/15 px-2 py-0.5 rounded-full border border-amber-500/30">
                      <Lock size={10} /> Password Protected
                    </span>
                  )}
                </div>
                <h3 className="text-lg font-bold text-text-primary mt-1 flex items-center gap-2">
                  {activeDb.display_name}
                  <button
                    onClick={() => openRenameModal(activeDb)}
                    className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-surface-lighter transition-colors"
                    title="Rename active database"
                  >
                    <Edit2 size={13} />
                  </button>
                  <button
                    onClick={() => openProtectModal(activeDb)}
                    className="p-1 rounded text-text-muted hover:text-amber-400 hover:bg-amber-500/10 transition-colors"
                    title={activeDb.is_protected ? "Manage active database password" : "Set active database password"}
                  >
                    <KeyRound size={13} />
                  </button>
                </h3>
                <div className="flex flex-wrap items-center gap-3 text-xs text-text-secondary mt-1">
                  <span>Size: {formatBytes(activeDb.size_bytes)}</span>
                  <span>•</span>
                  <span>{activeDb.accounts_count || 0} Accounts</span>
                  <span>•</span>
                  <span>{activeDb.transactions_count || 0} Transactions</span>
                  <span>•</span>
                  <span>{activeDb.positions_count || 0} Positions</span>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <span className="px-3 py-1 rounded-full text-xs font-bold bg-success-500/20 text-success-400 border border-success-500/30">
                ACTIVE IN RUNTIME
              </span>
            </div>
          </div>
        )}

        {/* Database List Table */}
        <div className="overflow-x-auto rounded-xl border border-border/60">
          <table className="w-full text-left text-xs">
            <thead className="bg-surface/70 text-text-muted uppercase tracking-wider border-b border-border/60">
              <tr>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4">Display Name</th>
                <th className="py-3 px-4">Filename</th>
                <th className="py-3 px-4">Security</th>
                <th className="py-3 px-4">Size</th>
                <th className="py-3 px-4">Records</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40">
              {databases.map((db) => {
                const isActive = db.is_active;
                const isBusy = switchingDb === db.filename;
                return (
                  <tr
                    key={db.filename}
                    className={cn(
                      'transition-colors',
                      isActive ? 'bg-primary-500/5' : 'hover:bg-surface-lighter/50'
                    )}
                  >
                    {/* Status */}
                    <td className="py-3 px-4">
                      <div className="flex flex-col gap-1 items-start">
                        {isActive ? (
                          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-bold bg-success-500/20 text-success-400 border border-success-500/30">
                            <Check size={11} /> Active
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium text-text-muted bg-surface/60 border border-border/40">
                            Inactive
                          </span>
                        )}
                        {db.is_default && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold text-amber-400 bg-amber-500/15 border border-amber-500/30">
                            <Star size={9} className="fill-amber-400" /> Default
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Display Name */}
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-1.5">
                        <span className="font-semibold text-text-primary text-sm">{db.display_name}</span>
                        <button
                          onClick={() => openRenameModal(db)}
                          className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-surface-lighter transition-colors"
                          title="Rename database"
                        >
                          <Edit2 size={12} />
                        </button>
                      </div>
                    </td>

                    {/* Filename */}
                    <td className="py-3 px-4">
                      <span className="font-mono text-text-muted">{db.filename}</span>
                    </td>

                    {/* Security */}
                    <td className="py-3 px-4">
                      {db.is_protected ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-500/15 text-amber-400 border border-amber-500/30">
                          <Lock size={10} /> Protected
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-normal text-text-muted bg-surface/60 border border-border/40">
                          <Unlock size={10} /> None
                        </span>
                      )}
                    </td>

                    {/* Size */}
                    <td className="py-3 px-4 text-text-secondary">
                      {formatBytes(db.size_bytes)}
                    </td>

                    {/* Records */}
                    <td className="py-3 px-4 text-text-secondary">
                      <div className="flex items-center gap-2">
                        <span>{db.accounts_count || 0} accs</span>
                        <span className="text-text-muted">•</span>
                        <span>{db.transactions_count || 0} tx</span>
                      </div>
                    </td>

                    {/* Actions */}
                    <td className="py-3 px-4 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        {db.is_default ? (
                          <span
                            className="p-1.5 rounded-lg text-amber-400 bg-amber-500/10 cursor-default"
                            title="Default database on server start & page reload"
                          >
                            <Star size={13} className="fill-amber-400" />
                          </span>
                        ) : (
                          <button
                            onClick={() => handleSetDefaultDb(db.filename)}
                            disabled={!!settingDefaultDb}
                            className="p-1.5 rounded-lg text-text-muted hover:text-amber-400 hover:bg-amber-500/10 transition-colors"
                            title="Set as default database to load on server start & page reload"
                          >
                            <Star size={13} />
                          </button>
                        )}

                        {!isActive ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={isBusy || !!switchingDb}
                            onClick={() => handleInitiateSwitchDb(db)}
                            className="text-xs h-7 px-2.5 hover:bg-primary-500 hover:text-white hover:border-primary-500"
                          >
                            {isBusy ? (
                              <RefreshCw size={11} className="animate-spin" />
                            ) : db.is_protected ? (
                              <>
                                <Lock size={11} className="text-amber-400" />
                                <span>Unlock</span>
                              </>
                            ) : (
                              <>
                                <HardDrive size={11} />
                                <span>Switch</span>
                              </>
                            )}
                          </Button>
                        ) : (
                          <span className="text-xs text-text-muted italic px-2">Current</span>
                        )}

                        <button
                          onClick={() => openProtectModal(db)}
                          className="p-1.5 rounded-lg text-text-muted hover:text-amber-400 hover:bg-amber-500/10 transition-colors"
                          title={db.is_protected ? "Manage Database Password" : "Set Database Password"}
                        >
                          <KeyRound size={13} />
                        </button>

                        <button
                          onClick={() => openRenameModal(db)}
                          className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-lighter transition-colors"
                          title="Rename database"
                        >
                          <Edit2 size={13} />
                        </button>

                        {/* Delete button (disallowed for active db and default finance.db) */}
                        {!isActive && db.filename !== 'finance.db' && (
                          <button
                            onClick={() => {
                              setDbToDelete(db);
                              setDeleteModalOpen(true);
                            }}
                            className="p-1.5 rounded-lg text-danger-400/70 hover:text-danger-400 hover:bg-danger-500/10 transition-colors"
                            title="Delete database file"
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {/* ─── Rename Modal ─── */}
      <Modal
        open={renameModalOpen}
        onClose={() => setRenameModalOpen(false)}
        title="Rename Database"
        maxWidth="max-w-md"
      >
        <div className="space-y-4 pt-1">
          <p className="text-xs text-text-secondary">
            Assign a human-friendly display label to this database file. The physical filename on disk will remain{' '}
            <span className="font-mono text-primary-400 font-semibold">{targetDb?.filename}</span>.
          </p>

          <Input
            label="Display Name"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            placeholder="e.g. Main Portfolio, 2026 Strategy Sandbox"
            autoFocus
          />

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" size="sm" onClick={() => setRenameModalOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSaveRename} disabled={!renameValue.trim()}>
              Save Name
            </Button>
          </div>
        </div>
      </Modal>

      {/* ─── Create / Clone Modal ─── */}
      <Modal
        open={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        title={copyFromCurrent ? 'Clone Active Database' : 'Create New Database'}
        maxWidth="max-w-md"
      >
        <div className="space-y-4 pt-1">
          <div className="space-y-2">
            <label className="text-xs font-semibold text-text-secondary">Mode</label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setCopyFromCurrent(true)}
                className={cn(
                  'p-2.5 rounded-xl border text-left text-xs transition-colors flex flex-col gap-1',
                  copyFromCurrent
                    ? 'border-primary-500 bg-primary-500/10 text-text-primary'
                    : 'border-border bg-surface text-text-muted hover:text-text-secondary'
                )}
              >
                <span className="font-bold">Clone Active Data</span>
                <span className="text-[10px]">Copy all accounts, trades & positions</span>
              </button>
              <button
                type="button"
                onClick={() => setCopyFromCurrent(false)}
                className={cn(
                  'p-2.5 rounded-xl border text-left text-xs transition-colors flex flex-col gap-1',
                  !copyFromCurrent
                    ? 'border-primary-500 bg-primary-500/10 text-text-primary'
                    : 'border-border bg-surface text-text-muted hover:text-text-secondary'
                )}
              >
                <span className="font-bold">Empty Database</span>
                <span className="text-[10px]">Fresh start with initialized schema</span>
              </button>
            </div>
          </div>

          <Input
            label="Database Filename (.db)"
            value={newFilename}
            onChange={(e) => setNewFilename(e.target.value)}
            placeholder="e.g. sandbox_2026.db"
          />

          <Input
            label="Display Name / Label"
            value={newDisplayName}
            onChange={(e) => setNewDisplayName(e.target.value)}
            placeholder="e.g. 2026 Strategy Sandbox"
          />

          <Input
            label="Database Password (Optional)"
            type="password"
            value={createDbPassword}
            onChange={(e) => setCreateDbPassword(e.target.value)}
            placeholder="Leave blank for no password protection"
          />

          <label className="flex items-center gap-2.5 cursor-pointer select-none text-xs text-text-primary pt-1">
            <input
              type="checkbox"
              checked={createSetAsDefault}
              onChange={(e) => setCreateSetAsDefault(e.target.checked)}
              className="rounded border-border text-primary-500 focus:ring-primary-500 bg-surface h-4 w-4"
            />
            <span className="flex items-center gap-1.5">
              <Star size={12} className="text-amber-400" />
              Set as default database to load on page reload and server start
            </span>
          </label>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" size="sm" onClick={() => setCreateModalOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSaveCreate} disabled={!newFilename.trim()}>
              Create Database
            </Button>
          </div>
        </div>
      </Modal>

      {/* ─── Delete Confirmation Modal ─── */}
      <Modal
        open={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        title="Delete Database File"
        maxWidth="max-w-md"
      >
        <div className="space-y-4 pt-1">
          <div className="p-3 rounded-xl bg-danger-500/10 border border-danger-500/20 text-xs text-danger-300">
            Are you sure you want to permanently delete{' '}
            <span className="font-mono font-bold text-white">{dbToDelete?.filename}</span>? All data in this file will be lost.
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" size="sm" onClick={() => setDeleteModalOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" size="sm" onClick={handleConfirmDelete}>
              <Trash2 size={13} />
              Delete Permanently
            </Button>
          </div>
        </div>
      </Modal>

      {/* ─── Upload Database Modal ─── */}
      <Modal
        open={uploadModalOpen}
        onClose={() => !isUploading && setUploadModalOpen(false)}
        title="Upload SQLite Database (.db)"
        maxWidth="max-w-md"
      >
        <div className="space-y-4 pt-1">
          <p className="text-xs text-text-secondary">
            Select an existing SQLite database file (<code className="font-mono text-primary-400">.db</code>) from your computer to import into Parity.
          </p>

          {/* File Dropzone / Picker */}
          <div
            onClick={() => fileInputRef.current?.click()}
            className={cn(
              "border-2 border-dashed rounded-xl p-5 text-center cursor-pointer transition-all",
              selectedFile
                ? "border-primary-500/60 bg-primary-500/5"
                : "border-border hover:border-primary-500/40 hover:bg-surface-lighter/30"
            )}
          >
            <input
              type="file"
              ref={fileInputRef}
              accept=".db,application/x-sqlite3"
              onChange={handleFileChange}
              className="hidden"
            />
            <div className="flex flex-col items-center justify-center gap-2">
              <div className="w-10 h-10 rounded-full bg-primary-500/10 flex items-center justify-center text-primary-400">
                <Upload size={20} />
              </div>
              {selectedFile ? (
                <div>
                  <p className="text-xs font-semibold text-text-primary font-mono">{selectedFile.name}</p>
                  <p className="text-[11px] text-text-muted mt-0.5">{formatBytes(selectedFile.size)}</p>
                </div>
              ) : (
                <div>
                  <p className="text-xs font-semibold text-text-primary">Click to browse or drag & drop</p>
                  <p className="text-[11px] text-text-muted mt-0.5">Accepts standard SQLite .db files</p>
                </div>
              )}
            </div>
          </div>

          <Input
            label="Display Name / Label (Optional)"
            value={uploadDisplayName}
            onChange={(e) => setUploadDisplayName(e.target.value)}
            placeholder="e.g. 2026 Financial History"
          />

          <Input
            label="Database Password (Optional)"
            type="password"
            value={uploadDbPassword}
            onChange={(e) => setUploadDbPassword(e.target.value)}
            placeholder="Set a password for this database (optional)"
          />

          <label className="flex items-center gap-2.5 cursor-pointer select-none text-xs text-text-primary pt-1">
            <input
              type="checkbox"
              checked={uploadSwitchNow}
              onChange={(e) => setUploadSwitchNow(e.target.checked)}
              className="rounded border-border text-primary-500 focus:ring-primary-500 bg-surface h-4 w-4"
            />
            <span>Switch to this database immediately after upload</span>
          </label>

          <label className="flex items-center gap-2.5 cursor-pointer select-none text-xs text-text-primary pt-1">
            <input
              type="checkbox"
              checked={uploadSetAsDefault}
              onChange={(e) => setUploadSetAsDefault(e.target.checked)}
              className="rounded border-border text-primary-500 focus:ring-primary-500 bg-surface h-4 w-4"
            />
            <span className="flex items-center gap-1.5">
              <Star size={12} className="text-amber-400" />
              Set as default database to load on page reload and server start
            </span>
          </label>

          <div className="flex justify-end gap-2 pt-2 border-t border-border/60">
            <Button
              variant="ghost"
              size="sm"
              disabled={isUploading}
              onClick={() => setUploadModalOpen(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!selectedFile || isUploading}
              onClick={handleUploadDb}
            >
              {isUploading ? (
                <>
                  <RefreshCw size={13} className="animate-spin" />
                  <span>Uploading & Verifying...</span>
                </>
              ) : (
                <>
                  <Upload size={13} />
                  <span>Upload Database</span>
                </>
              )}
            </Button>
          </div>
        </div>
      </Modal>

      {/* ─── Switch Unlock Modal ─── */}
      <Modal
        open={unlockSwitchModalOpen}
        onClose={() => setUnlockSwitchModalOpen(false)}
        title="Unlock Database"
        maxWidth="max-w-md"
      >
        <div className="space-y-4 pt-1">
          <div className="flex items-center gap-3 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs text-text-primary">
            <div className="w-8 h-8 rounded-lg bg-amber-500/20 text-amber-400 flex items-center justify-center shrink-0">
              <Lock size={16} />
            </div>
            <div>
              <p className="font-semibold">{unlockSwitchTarget?.display_name}</p>
              <p className="text-[11px] text-text-muted font-mono">{unlockSwitchTarget?.filename}</p>
            </div>
          </div>

          <p className="text-xs text-text-secondary">
            This database is password protected. Enter the password to switch to it and make it the active runtime database.
          </p>

          {unlockSwitchError && (
            <div className="p-2.5 rounded-lg bg-danger-500/10 border border-danger-500/20 text-xs text-danger-300">
              {unlockSwitchError}
            </div>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (unlockSwitchTarget) {
                handleSwitchDb(unlockSwitchTarget.filename, unlockSwitchPassword);
              }
            }}
            className="space-y-4"
          >
            <Input
              label="Database Password"
              type="password"
              value={unlockSwitchPassword}
              onChange={(e) => setUnlockSwitchPassword(e.target.value)}
              placeholder="Enter database password"
              autoFocus
            />

            <div className="flex justify-end gap-2 pt-2 border-t border-border/60">
              <Button
                variant="ghost"
                size="sm"
                type="button"
                onClick={() => setUnlockSwitchModalOpen(false)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                type="submit"
                disabled={!unlockSwitchPassword || switchingDb === unlockSwitchTarget?.filename}
              >
                {switchingDb === unlockSwitchTarget?.filename ? (
                  <>
                    <RefreshCw size={12} className="animate-spin" />
                    <span>Unlocking...</span>
                  </>
                ) : (
                  <>
                    <Lock size={12} />
                    <span>Unlock & Switch</span>
                  </>
                )}
              </Button>
            </div>
          </form>
        </div>
      </Modal>

      {/* ─── Manage Database Password Protection Modal ─── */}
      <Modal
        open={protectModalOpen}
        onClose={() => !protectSubmitting && setProtectModalOpen(false)}
        title={protectTargetDb?.is_protected ? "Manage Database Password" : "Set Database Password"}
        maxWidth="max-w-md"
      >
        <div className="space-y-4 pt-1">
          <div className="flex items-center justify-between p-3 rounded-xl bg-surface border border-border text-xs">
            <div>
              <span className="font-semibold text-text-primary text-sm">{protectTargetDb?.display_name}</span>
              <div className="font-mono text-[11px] text-text-muted">{protectTargetDb?.filename}</div>
            </div>
            {protectTargetDb?.is_protected ? (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-500/15 text-amber-400 border border-amber-500/30">
                <Lock size={10} /> Protected
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-normal text-text-muted bg-surface/60 border border-border/40">
                <Unlock size={10} /> Unprotected
              </span>
            )}
          </div>

          {protectTargetDb?.is_protected && (
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  setProtectAction('change');
                  setProtectError('');
                }}
                className={cn(
                  'p-2 rounded-xl border text-xs font-semibold transition-colors',
                  protectAction === 'change'
                    ? 'border-amber-500 bg-amber-500/10 text-amber-400'
                    : 'border-border bg-surface text-text-muted hover:text-text-secondary'
                )}
              >
                Change Password
              </button>
              <button
                type="button"
                onClick={() => {
                  setProtectAction('remove');
                  setProtectError('');
                }}
                className={cn(
                  'p-2 rounded-xl border text-xs font-semibold transition-colors',
                  protectAction === 'remove'
                    ? 'border-danger-500 bg-danger-500/10 text-danger-400'
                    : 'border-border bg-surface text-text-muted hover:text-text-secondary'
                )}
              >
                Remove Password
              </button>
            </div>
          )}

          {protectError && (
            <div className="p-2.5 rounded-lg bg-danger-500/10 border border-danger-500/20 text-xs text-danger-300">
              {protectError}
            </div>
          )}

          <div className="space-y-3">
            {protectTargetDb?.is_protected && (
              <Input
                label="Current Password"
                type="password"
                value={dbCurrentPassword}
                onChange={(e) => setDbCurrentPassword(e.target.value)}
                placeholder="Enter current database password"
                autoFocus
              />
            )}

            {protectAction !== 'remove' && (
              <>
                <Input
                  label={protectTargetDb?.is_protected ? "New Password" : "Password"}
                  type="password"
                  value={dbNewPassword}
                  onChange={(e) => setDbNewPassword(e.target.value)}
                  placeholder="At least 4 characters"
                  autoFocus={!protectTargetDb?.is_protected}
                />
                <Input
                  label={protectTargetDb?.is_protected ? "Confirm New Password" : "Confirm Password"}
                  type="password"
                  value={dbConfirmNewPassword}
                  onChange={(e) => setDbConfirmNewPassword(e.target.value)}
                  placeholder="Re-enter password"
                />
              </>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-border/60">
            <Button
              variant="ghost"
              size="sm"
              disabled={protectSubmitting}
              onClick={() => setProtectModalOpen(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant={protectAction === 'remove' ? 'danger' : 'primary'}
              disabled={protectSubmitting}
              onClick={handleSaveProtection}
            >
              {protectSubmitting ? (
                <>
                  <RefreshCw size={12} className="animate-spin" />
                  <span>Processing...</span>
                </>
              ) : protectAction === 'remove' ? (
                <>
                  <Unlock size={12} />
                  <span>Remove Protection</span>
                </>
              ) : (
                <>
                  <Lock size={12} />
                  <span>{protectTargetDb?.is_protected ? 'Update Password' : 'Set Password'}</span>
                </>
              )}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Change Password */}
      <Card>
        <div className="flex items-center gap-3 mb-4">
          <div className="w-8 h-8 rounded-lg bg-primary-500/10 flex items-center justify-center">
            <Key className="text-primary-400" size={16} />
          </div>
          <CardTitle className="!mb-0 text-base">Change Admin Password</CardTitle>
        </div>

        <div className="space-y-3 max-w-sm">
          <Input
            label="Current Password"
            type="password"
            value={currentPw}
            onChange={(e) => setCurrentPw(e.target.value)}
          />
          <Input
            label="New Password"
            type="password"
            value={newPw}
            onChange={(e) => setNewPw(e.target.value)}
          />
          <Input
            label="Confirm New Password"
            type="password"
            value={confirmNewPw}
            onChange={(e) => setConfirmNewPw(e.target.value)}
          />
          <Button onClick={handleChangePassword} size="sm">
            Update Password
          </Button>
        </div>
      </Card>

      {/* Wipe Database */}
      <Card className="!border-danger-500/30">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-8 h-8 rounded-lg bg-danger-500/10 flex items-center justify-center">
            <Trash2 className="text-danger-400" size={16} />
          </div>
          <div>
            <CardTitle className="!mb-0 text-base !text-danger-400">Wipe Data & Accounts</CardTitle>
            <p className="text-xs text-text-muted mt-0.5">
              Deletes all transactions, option trades, import history, and accounts in the currently active database (
              <span className="font-mono text-white">{activeDb?.filename}</span>). Institutions will be preserved.
            </p>
          </div>
        </div>

        <div className="space-y-3 max-w-sm">
          <Input
            label="Admin Password"
            type="password"
            placeholder="Re-enter your admin password"
            value={wipePw}
            onChange={(e) => setWipePw(e.target.value)}
          />
          <Input
            label='Type "WIPE" to confirm'
            type="text"
            placeholder="WIPE"
            value={wipeConfirm}
            onChange={(e) => setWipeConfirm(e.target.value)}
          />
          <Button variant="danger" onClick={handleWipe} size="sm">
            <Trash2 size={14} />
            Wipe All Data
          </Button>
        </div>
      </Card>
    </div>
  );
}
