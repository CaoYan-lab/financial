import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
import {
  KeyRound,
  Link2,
  Loader2,
  Lock,
  ShieldCheck,
  UserCog,
  Users,
  X,
} from 'lucide-react'
import {
  changeOwnPassword,
  createUser,
  disconnectLongbridge,
  loadFutuAccess,
  loadLongbridgeConnection,
  loadMultiUserSession,
  loadUsers,
  lockFutu,
  resetUserPassword,
  saveLongbridgeConnection,
  setFutuSecondaryPassword,
  unlockFutu,
  updateLongbridgeLiveGate,
  updateUserStatus,
  type ManagedUserProfile,
  type MultiUserProfile,
  type SafeConnection,
} from './api/multiUserApi'
import { installMultiUserFetchGuard, MULTIUSER_EVENT, type MultiUserAction } from './fetchGuard'

type Dialog = 'menu' | 'users' | 'password' | 'futu-unlock' | 'futu-setup' | 'longbridge' | null

export default function MultiUserShell({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<MultiUserProfile | null>()
  const [dialog, setDialog] = useState<Dialog>(null)
  const [notice, setNotice] = useState<string>()
  const [futuStatus, setFutuStatus] = useState<string>()

  useEffect(() => {
    installMultiUserFetchGuard()
    void loadMultiUserSession().then((value) => {
      setProfile(value)
      if (value?.mustChangePassword) setDialog('password')
      if (value?.role === 'owner') {
        void loadFutuAccess().then(setFutuStatus).catch(() => undefined)
      }
    })
    const listener = (event: Event) => {
      const action = (event as CustomEvent<MultiUserAction>).detail
      if (action === 'forbidden') {
        setNotice('当前账号无权访问 Futu 账户。')
        return
      }
      const target: Partial<Record<MultiUserAction, Dialog>> = {
        'futu-unlock': 'futu-unlock',
        'futu-setup': 'futu-setup',
        'longbridge-connect': 'longbridge',
        'password-change': 'password',
      }
      setDialog(target[action] ?? null)
    }
    window.addEventListener(MULTIUSER_EVENT, listener)
    return () => window.removeEventListener(MULTIUSER_EVENT, listener)
  }, [])

  if (profile === null) return <>{children}</>

  const refreshProfile = async () => {
    const next = await loadMultiUserSession()
    setProfile(next)
    if (!next?.mustChangePassword) setDialog(null)
  }

  return (
    <>
      {children}
      {profile ? (
        <nav
          aria-label="账户管理"
          className="fixed bottom-20 right-3 z-[9998] flex items-center gap-2 rounded-3xl border border-slate-200 bg-white/95 p-2 shadow-xl shadow-slate-900/10 backdrop-blur sm:right-5"
        >
          {profile.role === 'owner' ? (
            <button
              type="button"
              onClick={() => setDialog('users')}
              className="inline-flex h-10 items-center gap-2 rounded-2xl bg-sky-600 px-3 text-sm font-black text-white hover:bg-sky-700"
            >
              <Users size={17} />
              用户管理
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setDialog('menu')}
            className="inline-flex h-10 items-center gap-2 rounded-2xl border border-slate-200 px-3 text-sm font-black text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-700"
          >
            <UserCog size={17} />
            账户与安全
          </button>
        </nav>
      ) : null}
      {notice ? (
        <div className="fixed inset-x-4 top-4 z-[10010] mx-auto flex max-w-xl items-center justify-between rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-bold text-rose-700 shadow-lg">
          <span>{notice}</span>
          <button type="button" title="关闭" onClick={() => setNotice(undefined)}>
            <X size={16} />
          </button>
        </div>
      ) : null}

      {dialog === 'menu' && profile ? (
        <Modal title="账户与安全" onClose={() => setDialog(null)}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Action icon={<KeyRound size={18} />} label="修改登录密码" onClick={() => setDialog('password')} />
            <Action icon={<Link2 size={18} />} label="长桥账户连接" onClick={() => setDialog('longbridge')} />
            {profile.role === 'owner' ? (
              <>
                <Action icon={<Users size={18} />} label="用户管理" onClick={() => setDialog('users')} />
                <Action
                  icon={<ShieldCheck size={18} />}
                  label={futuStatus === 'unlocked' ? '锁定 Futu' : futuStatus === 'setup_required' ? '设置 Futu 二次密码' : '解锁 Futu'}
                  onClick={() => {
                    if (futuStatus === 'unlocked') {
                      void lockFutu().then(() => {
                        setFutuStatus('locked')
                        setDialog(null)
                      })
                    } else {
                      setDialog(futuStatus === 'setup_required' ? 'futu-setup' : 'futu-unlock')
                    }
                  }}
                />
              </>
            ) : null}
          </div>
          <p className="mt-5 text-xs font-semibold text-slate-500">
            当前用户：{profile.displayName}（{profile.username}）
          </p>
        </Modal>
      ) : null}

      {dialog === 'password' && profile ? (
        <PasswordDialog
          required={profile.mustChangePassword}
          onClose={profile.mustChangePassword ? undefined : () => setDialog(null)}
          onSuccess={refreshProfile}
        />
      ) : null}
      {dialog === 'users' && profile?.role === 'owner' ? (
        <UserManagementDialog onClose={() => setDialog(null)} />
      ) : null}
      {dialog === 'futu-unlock' && profile?.role === 'owner' ? (
        <FutuUnlockDialog
          onClose={() => setDialog(null)}
          onSuccess={() => {
            setFutuStatus('unlocked')
            window.location.reload()
          }}
        />
      ) : null}
      {dialog === 'futu-setup' && profile?.role === 'owner' ? (
        <FutuSetupDialog
          onClose={() => setDialog(null)}
          onSuccess={() => {
            setFutuStatus('locked')
            setDialog('futu-unlock')
          }}
        />
      ) : null}
      {dialog === 'longbridge' && profile ? (
        <LongbridgeConnectionDialog
          onClose={() => setDialog(null)}
          owner={profile.role === 'owner'}
        />
      ) : null}
    </>
  )
}

function Modal({
  title,
  children,
  onClose,
}: {
  title: string
  children: ReactNode
  onClose?: () => void
}) {
  const titleId = useId()
  return (
    <div className="fixed inset-0 z-[10000] grid place-items-center bg-slate-950/35 p-4 backdrop-blur-sm">
      <section
        className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-3xl border border-slate-200 bg-white p-6 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="mb-5 flex items-center justify-between gap-4">
          <h2 id={titleId} className="text-xl font-black text-slate-950">{title}</h2>
          {onClose ? (
            <button type="button" title="关闭" onClick={onClose} className="grid h-9 w-9 place-items-center rounded-full text-slate-500 hover:bg-slate-100">
              <X size={18} />
            </button>
          ) : null}
        </header>
        {children}
      </section>
    </div>
  )
}

function Action({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-14 items-center gap-3 rounded-2xl border border-slate-200 px-4 text-left text-sm font-black text-slate-800 hover:border-sky-300 hover:bg-sky-50"
    >
      <span className="text-sky-600">{icon}</span>
      {label}
    </button>
  )
}

function PasswordDialog({
  required,
  onClose,
  onSuccess,
}: {
  required: boolean
  onClose?: () => void
  onSuccess: () => Promise<void>
}) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(undefined)
    try {
      await changeOwnPassword(currentPassword, newPassword)
      await onSuccess()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '密码修改失败')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal title={required ? '首次登录修改密码' : '修改登录密码'} onClose={onClose}>
      <form className="space-y-4" onSubmit={submit}>
        <PasswordInput label="当前密码" value={currentPassword} onChange={setCurrentPassword} />
        <PasswordInput label="新密码" value={newPassword} onChange={setNewPassword} />
        <ErrorText error={error} />
        <SubmitButton busy={busy} label="确认修改" />
      </form>
    </Modal>
  )
}

function FutuUnlockDialog({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  return (
    <Modal title="Futu 二次验证" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          setBusy(true)
          setError(undefined)
          void unlockFutu(password)
            .then(onSuccess)
            .catch((failure) => setError(failure instanceof Error ? failure.message : '验证失败'))
            .finally(() => setBusy(false))
        }}
      >
        <PasswordInput label="Futu 独立密码" value={password} onChange={setPassword} />
        <ErrorText error={error} />
        <SubmitButton busy={busy} label="解锁账户" />
      </form>
    </Modal>
  )
}

function FutuSetupDialog({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [secondaryPassword, setSecondaryPassword] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  return (
    <Modal title="设置 Futu 二次密码" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          setBusy(true)
          setError(undefined)
          void setFutuSecondaryPassword(currentPassword, secondaryPassword)
            .then(onSuccess)
            .catch((failure) => setError(failure instanceof Error ? failure.message : '设置失败'))
            .finally(() => setBusy(false))
        }}
      >
        <PasswordInput label="当前登录密码" value={currentPassword} onChange={setCurrentPassword} />
        <PasswordInput label="新的 Futu 独立密码" value={secondaryPassword} onChange={setSecondaryPassword} />
        <ErrorText error={error} />
        <SubmitButton busy={busy} label="保存二次密码" />
      </form>
    </Modal>
  )
}

function LongbridgeConnectionDialog({ onClose, owner }: { onClose: () => void; owner: boolean }) {
  const [connection, setConnection] = useState<SafeConnection | null>()
  const [appKey, setAppKey] = useState('')
  const [appSecret, setAppSecret] = useState('')
  const [accessToken, setAccessToken] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void loadLongbridgeConnection().then(setConnection).catch((failure) => {
      setError(failure instanceof Error ? failure.message : '连接状态加载失败')
    })
  }, [])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(undefined)
    try {
      const saved = await saveLongbridgeConnection({ appKey, appSecret, accessToken })
      setConnection(saved)
      setAppKey('')
      setAppSecret('')
      setAccessToken('')
      window.location.reload()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '长桥凭据验证失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="长桥账户连接" onClose={onClose}>
      {connection ? (
        <div className="mb-5 rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm font-bold text-sky-800">
          当前状态：已连接{connection.accountFingerprint ? ` · ${connection.accountFingerprint}` : ''}
        </div>
      ) : null}
      <form className="space-y-4" onSubmit={submit}>
        <p className="text-sm font-semibold leading-6 text-slate-600">
          凭据不会回显。提交后先验证新凭据，验证成功才会替换当前连接。
        </p>
        <TextInput label="App Key" value={appKey} onChange={setAppKey} />
        <PasswordInput label="App Secret" value={appSecret} onChange={setAppSecret} />
        <PasswordInput label="Access Token" value={accessToken} onChange={setAccessToken} />
        <ErrorText error={error} />
        <SubmitButton
          busy={busy}
          label={connection ? '验证并刷新凭据' : '验证并保存凭据'}
        />
        {!owner && connection ? (
          <button
            type="button"
            className="w-full rounded-2xl border border-rose-200 px-4 py-3 text-sm font-black text-rose-700 hover:bg-rose-50"
            onClick={() => {
              setBusy(true)
              void disconnectLongbridge()
                .then(() => setConnection(null))
                .catch((failure) => setError(failure instanceof Error ? failure.message : '断开失败'))
                .finally(() => setBusy(false))
            }}
          >
            断开当前连接
          </button>
        ) : null}
      </form>
    </Modal>
  )
}

function UserManagementDialog({ onClose }: { onClose: () => void }) {
  const [users, setUsers] = useState<ManagedUserProfile[]>([])
  const [updatingGateUserId, setUpdatingGateUserId] = useState<string>()
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [temporaryPassword, setTemporaryPassword] = useState('')
  const [error, setError] = useState<string>()
  const refresh = () => loadUsers().then(setUsers).catch((failure) => {
    setError(failure instanceof Error ? failure.message : '用户列表加载失败')
  })
  useEffect(() => {
    void refresh()
  }, [])
  return (
    <Modal title="用户管理" onClose={onClose}>
      <form
        className="grid gap-3 border-b border-slate-200 pb-5 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault()
          setError(undefined)
          void createUser({ username, displayName, temporaryPassword })
            .then(() => {
              setUsername('')
              setDisplayName('')
              setTemporaryPassword('')
              return refresh()
            })
            .catch((failure) => setError(failure instanceof Error ? failure.message : '创建用户失败'))
        }}
      >
        <TextInput label="用户名" value={username} onChange={setUsername} />
        <TextInput label="显示名" value={displayName} onChange={setDisplayName} />
        <div className="sm:col-span-2">
          <PasswordInput label="临时密码" value={temporaryPassword} onChange={setTemporaryPassword} />
        </div>
        <div className="sm:col-span-2"><SubmitButton busy={false} label="创建用户" /></div>
      </form>
      <ErrorText error={error} />
      <div className="mt-5 divide-y divide-slate-100">
        {users.map((user) => (
          <div key={user.userId} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div>
              <p className="font-black text-slate-900">{user.displayName}</p>
              <p className="text-xs font-semibold text-slate-500">
                {user.username} · {user.role === 'owner' ? '所有者' : user.active ? '已启用' : '已停用'} ·
                长桥 {connectionStatusLabel(user.longbridgeConnection)}
                {user.role === 'member' ? ` · 实盘${user.longbridgeLiveGate?.liveTradingEnabled ? '已批准' : '未批准'}` : ''}
              </p>
            </div>
            {user.role === 'member' ? (
              <div className="flex flex-wrap gap-2">
                {user.longbridgeConnection?.status === 'verified' ? (
                  <button
                    type="button"
                    className={`rounded-xl border px-3 py-2 text-xs font-bold disabled:opacity-50 ${
                      user.longbridgeLiveGate?.liveTradingEnabled
                        ? 'border-rose-200 text-rose-700'
                        : 'border-sky-200 text-sky-700'
                    }`}
                    disabled={updatingGateUserId === user.userId}
                    onClick={() => {
                      const enabled = !user.longbridgeLiveGate?.liveTradingEnabled
                      if (enabled && !window.confirm(`确认 ${user.displayName} 已完成影子验收，并开放真实订单提交权限？`)) return
                      setUpdatingGateUserId(user.userId)
                      setError(undefined)
                      void updateLongbridgeLiveGate(user.userId, enabled)
                        .then(refresh)
                        .catch((failure) => setError(failure instanceof Error ? failure.message : '实盘权限更新失败'))
                        .finally(() => setUpdatingGateUserId(undefined))
                    }}
                  >
                    {updatingGateUserId === user.userId
                      ? '处理中'
                      : user.longbridgeLiveGate?.liveTradingEnabled
                        ? '关闭实盘'
                        : '批准实盘'}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold"
                  onClick={() => void updateUserStatus(user.userId, !user.active).then(refresh)}
                >
                  {user.active ? '停用' : '启用'}
                </button>
                <button
                  type="button"
                  className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold"
                  onClick={() => {
                    const password = window.prompt('请输入新的临时密码（至少 12 位，包含字母和数字）')
                    if (password) void resetUserPassword(user.userId, password).then(refresh)
                  }}
                >
                  重置密码
                </button>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </Modal>
  )
}

function connectionStatusLabel(connection?: SafeConnection | null): string {
  if (!connection) return '未连接'
  if (connection.status === 'verified') return '已连接'
  if (connection.status === 'pending') return '验证中'
  if (connection.status === 'invalid') return '验证失败'
  return '已断开'
}

function TextInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-black text-slate-600">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm font-semibold outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
      />
    </label>
  )
}

function PasswordInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-black text-slate-600">{label}</span>
      <div className="relative">
        <Lock className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          type="password"
          autoComplete="new-password"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="w-full rounded-2xl border border-slate-200 py-3 pl-10 pr-4 text-sm font-semibold outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
        />
      </div>
    </label>
  )
}

function ErrorText({ error }: { error?: string }) {
  return error ? <p className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-sm font-bold text-rose-700">{error}</p> : null
}

function SubmitButton({ busy, label }: { busy: boolean; label: string }) {
  return (
    <button
      type="submit"
      disabled={busy}
      className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-slate-950 px-4 py-3 text-sm font-black text-white hover:bg-slate-800 disabled:opacity-50"
    >
      {busy ? <Loader2 size={16} className="animate-spin" /> : null}
      {label}
    </button>
  )
}
