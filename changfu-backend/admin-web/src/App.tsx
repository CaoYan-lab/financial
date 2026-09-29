import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import {
  Bot,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  KeyRound,
  LogOut,
  Package,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Users,
  X,
} from 'lucide-react'
import {
  ApiError,
  api,
  clearCsrf,
  login,
  type AdminSession,
  type OfficialModel,
  type Plan,
  type Subscription,
  type UserSummary,
} from './api/client'

type Section = 'users' | 'plans' | 'model'
type Dialog = 'create-user' | 'user-detail' | 'grant' | 'plan' | 'model' | null

const errorLabels: Record<string, string> = {
  ADMIN_LOGIN_REJECTED: '用户名或密码错误，或账号暂不可用',
  ADMIN_PASSWORD_CHANGE_REQUIRED: '首次登录必须先修改密码',
  ADMIN_CURRENT_PASSWORD_INVALID: '当前密码不正确',
  USERNAME_ALREADY_EXISTS: '用户名已存在',
  USER_PASSWORD_INVALID: '密码至少 12 位，需包含大小写字母、数字和符号',
  SUBSCRIPTION_VERSION_CONFLICT: '订阅已被其他操作更新，请刷新后重试',
  SUBSCRIPTION_IMPACT_CONFIRMATION_REQUIRED: '此操作会减少权益，请勾选影响确认',
  OFFICIAL_MODEL_TEST_REQUIRED: '配置必须先通过连通性测试',
  MODEL_ENDPOINT_NOT_ALLOWED: '接入点不符合公网 HTTPS 安全要求',
}

function errorText(error: unknown): string {
  if (error instanceof ApiError) return errorLabels[error.code] ?? `操作失败：${error.code}`
  return '操作未完成，请稍后重试'
}

function dateText(value: string | null | undefined): string {
  if (!value) return '-'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function idempotent(method: string, body?: unknown): RequestInit & { mutation: true } {
  return {
    method,
    mutation: true,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }
}

export function App() {
  const [session, setSession] = useState<AdminSession | null | undefined>(undefined)
  const [error, setError] = useState('')

  useEffect(() => {
    api<AdminSession>('/api/v1/admin/auth/session')
      .then(value => setSession(value))
      .catch(() => setSession(null))
  }, [])

  if (session === undefined) return <div className="center-state"><RefreshCw className="spin" />正在连接管理服务</div>
  if (!session) return <Login onSuccess={setSession} />
  if (session.mustChangePassword) {
    return <ChangePassword onDone={() => {
      clearCsrf()
      setSession(null)
    }} />
  }
  return (
    <AdminShell
      session={session}
      error={error}
      setError={setError}
      onLogout={async () => {
        try {
          await api('/api/v1/admin/auth/logout', idempotent('POST'))
        } finally {
          clearCsrf()
          setSession(null)
        }
      }}
    />
  )
}

function Login({ onSuccess }: { onSuccess: (session: AdminSession) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    setBusy(true)
    setError('')
    try {
      onSuccess(await login(String(data.get('username')), String(data.get('password'))))
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }
  return (
    <main className="auth-page">
      <section className="auth-panel">
        <div className="brand-mark">CF</div>
        <div>
          <h1>长富管理中心</h1>
          <p>内部运营与权益控制台</p>
        </div>
        <form onSubmit={submit}>
          <label>管理员账号<input name="username" defaultValue="admin" autoComplete="username" required /></label>
          <label>密码<input name="password" type="password" autoComplete="current-password" required /></label>
          {error && <div className="form-error">{error}</div>}
          <button className="primary wide" disabled={busy}><KeyRound size={16} />{busy ? '正在验证' : '登录'}</button>
        </form>
      </section>
    </main>
  )
}

function ChangePassword({ onDone }: { onDone: () => void }) {
  const [error, setError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const currentPassword = String(data.get('currentPassword'))
    const nextPassword = String(data.get('nextPassword'))
    if (nextPassword !== String(data.get('confirmPassword'))) {
      setError('两次输入的新密码不一致')
      return
    }
    try {
      await api('/api/v1/admin/auth/password', idempotent('POST', {
        currentPassword,
        nextPassword,
      }))
      onDone()
    } catch (caught) {
      setError(errorText(caught))
    }
  }
  return (
    <main className="auth-page">
      <section className="auth-panel">
        <ShieldCheck size={28} />
        <div><h1>设置管理员密码</h1><p>首次登录后必须更换初始密码</p></div>
        <form onSubmit={submit}>
          <label>当前密码<input name="currentPassword" type="password" required /></label>
          <label>新密码<input name="nextPassword" type="password" required /></label>
          <label>确认新密码<input name="confirmPassword" type="password" required /></label>
          {error && <div className="form-error">{error}</div>}
          <button className="primary wide"><KeyRound size={16} />确认修改</button>
        </form>
      </section>
    </main>
  )
}

function AdminShell(props: {
  session: AdminSession
  error: string
  setError: (value: string) => void
  onLogout: () => void
}) {
  const [section, setSection] = useState<Section>('users')
  const nav = [
    { id: 'users' as const, label: '用户与订阅', icon: Users },
    { id: 'plans' as const, label: '套餐目录', icon: Package },
    { id: 'model' as const, label: '长富Pro', icon: Bot },
  ]
  return (
    <div className="shell">
      <aside className="sidebar">
        <header><div className="brand-mark small">CF</div><div><strong>长富</strong><span>管理中心</span></div></header>
        <nav>{nav.map(item => (
          <button key={item.id} className={section === item.id ? 'active' : ''} onClick={() => {
            props.setError('')
            setSection(item.id)
          }}>
            <item.icon size={17} />{item.label}
          </button>
        ))}</nav>
        <footer>
          <div><span className="online-dot" />{props.session.username}</div>
          <button title="退出登录" onClick={props.onLogout}><LogOut size={17} /></button>
        </footer>
      </aside>
      <main className="workspace">
        {props.error && <div className="global-error">{props.error}<button onClick={() => props.setError('')}><X size={15} /></button></div>}
        {section === 'users' && <UsersPage onError={props.setError} />}
        {section === 'plans' && <PlansPage onError={props.setError} />}
        {section === 'model' && <OfficialModelPage onError={props.setError} />}
      </main>
    </div>
  )
}

function PageHeader(props: { title: string; meta: string; action?: React.ReactNode }) {
  return <header className="page-header"><div><h1>{props.title}</h1><p>{props.meta}</p></div>{props.action}</header>
}

function Status({ value }: { value: string }) {
  const labels: Record<string, string> = {
    ACTIVE: '生效中', FROZEN: '已冻结', CANCELLED: '已取消',
    DRAFT: '草稿', RETIRED: '已退役', SUCCEEDED: '测试通过',
    FAILED: '测试失败', UNTESTED: '未测试', EMPTY: '未绑定',
    GRANTED: '已授予', ADJUSTED: '已调整', RESTORED: '已恢复',
  }
  return <span className={`status status-${value.toLowerCase()}`}>{labels[value] ?? value}</span>
}

function Modal(props: { title: string; close: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={event => {
      if (event.target === event.currentTarget) props.close()
    }}>
      <section className={`modal ${props.wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true">
        <header><h2>{props.title}</h2><button className="icon-button" title="关闭" onClick={props.close}><X size={18} /></button></header>
        <div className="modal-body">{props.children}</div>
      </section>
    </div>
  )
}

function UsersPage({ onError }: { onError: (value: string) => void }) {
  const [items, setItems] = useState<UserSummary[]>([])
  const [total, setTotal] = useState(0)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [page, setPage] = useState(1)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [selected, setSelected] = useState<UserSummary | null>(null)
  const pageSize = 25
  const load = useCallback(async () => {
    try {
      const result = await api<{ items: UserSummary[]; total: number }>(
        `/api/v1/admin/users?query=${encodeURIComponent(query)}&status=${status}&page=${page}&pageSize=${pageSize}`,
      )
      setItems(result.items)
      setTotal(result.total)
    } catch (error) {
      onError(errorText(error))
    }
  }, [onError, page, query, status])
  useEffect(() => { void load() }, [load])

  return <>
    <PageHeader title="用户与订阅" meta={`${total} 个业务用户`} action={
      <button className="primary" onClick={() => setDialog('create-user')}><Plus size={16} />创建用户</button>
    } />
    <div className="toolbar">
      <div className="search"><Search size={16} /><input value={query} onChange={event => {
        setQuery(event.target.value); setPage(1)
      }} placeholder="搜索用户名或显示名" /></div>
      <div className="segmented">
        {[['all', '全部'], ['active', '启用'], ['disabled', '停用']].map(([value, label]) => (
          <button key={value} className={status === value ? 'active' : ''} onClick={() => {
            setStatus(value); setPage(1)
          }}>{label}</button>
        ))}
      </div>
      <button className="icon-button" title="刷新" onClick={() => void load()}><RefreshCw size={16} /></button>
    </div>
    <div className="table-wrap">
      <table><thead><tr><th>用户</th><th>状态</th><th>首次改密</th><th>最近登录</th><th>创建时间</th><th className="right">操作</th></tr></thead>
        <tbody>{items.map(user => <tr key={user.userId}>
          <td><strong>{user.displayName}</strong><small>{user.username}</small></td>
          <td><Status value={user.active ? 'ACTIVE' : 'FROZEN'} /></td>
          <td>{user.mustChangePassword ? '待完成' : '已完成'}</td>
          <td>{dateText(user.lastLoginAt)}</td><td>{dateText(user.createdAt)}</td>
          <td className="right"><button className="text-button" onClick={() => {
            setSelected(user); setDialog('user-detail')
          }}>查看详情</button></td>
        </tr>)}</tbody>
      </table>
      {items.length === 0 && <div className="empty">没有符合条件的用户</div>}
    </div>
    <div className="pagination"><span>第 {page} 页</span><button disabled={page === 1} onClick={() => setPage(page - 1)}><ChevronLeft size={16} /></button><button disabled={page * pageSize >= total} onClick={() => setPage(page + 1)}><ChevronRight size={16} /></button></div>
    {dialog === 'create-user' && <UserCreate close={() => setDialog(null)} done={() => {
      setDialog(null); void load()
    }} onError={onError} />}
    {dialog === 'user-detail' && selected && <UserDetail user={selected} close={() => setDialog(null)} refresh={load} onError={onError} />}
  </>
}

function UserCreate(props: { close: () => void; done: () => void; onError: (value: string) => void }) {
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = Object.fromEntries(new FormData(event.currentTarget))
    try {
      await api('/api/v1/admin/users', idempotent('POST', data))
      props.done()
    } catch (error) { props.onError(errorText(error)) }
  }
  return <Modal title="创建业务用户" close={props.close}><form className="form-grid" onSubmit={submit}>
    <label>用户名<input name="username" required minLength={3} /></label>
    <label>显示名<input name="displayName" required /></label>
    <label className="full">临时密码<input name="temporaryPassword" type="password" required /></label>
    <div className="form-actions full"><button type="button" onClick={props.close}>取消</button><button className="primary">创建</button></div>
  </form></Modal>
}

type UserDetailData = UserSummary & {
  activeDeviceCount: number
  brokerConnections: Array<{ connectionId: string; provider: string; status: string }>
  subscription: Subscription | null
}

type SubscriptionHistory = {
  grants: Array<{
    grantId: string
    status: string
    reason: string
    actorUsername: string
    createdAt: string
  }>
  events: Array<{
    subscriptionEventId: string
    eventType: string
    occurredAt: string
  }>
}

function UserDetail(props: { user: UserSummary; close: () => void; refresh: () => Promise<void>; onError: (value: string) => void }) {
  const [detail, setDetail] = useState<UserDetailData | null>(null)
  const [history, setHistory] = useState<SubscriptionHistory | null>(null)
  const [dialog, setDialog] = useState<'grant' | 'edit' | 'password' | 'slots' | null>(null)
  const load = useCallback(async () => {
    const [user, subscriptionHistory] = await Promise.all([
      api<UserDetailData>(`/api/v1/admin/users/${props.user.userId}`),
      api<SubscriptionHistory>(
        `/api/v1/admin/users/${props.user.userId}/subscription/history`,
      ),
    ])
    setDetail(user)
    setHistory(subscriptionHistory)
  }, [props.user.userId])
  useEffect(() => { load().catch(error => props.onError(errorText(error))) }, [load, props.onError])
  async function statusAction(action: 'disable' | 'enable' | 'freeze' | 'restore' | 'cancel') {
    const actionLabel = {
      disable: '停用用户并撤销全部登录会话',
      enable: '重新启用用户',
      freeze: '冻结订阅和全部已绑定槽位',
      restore: '恢复订阅及套餐额度内的槽位',
      cancel: '取消订阅并冻结全部槽位',
    }[action]
    if (!window.confirm(`确认${actionLabel}？此操作将写入审计记录。`)) return
    try {
      if (action === 'disable' || action === 'enable') {
        await api(`/api/v1/admin/users/${props.user.userId}/${action}`, idempotent('POST'))
      } else if (detail?.subscription) {
        await api(`/api/v1/admin/users/${props.user.userId}/subscription/${action}`, idempotent('POST', {
          expectedVersion: detail.subscription.version,
          reason: `管理员${action === 'freeze' ? '冻结' : action === 'restore' ? '恢复' : '取消'}订阅`,
        }))
      }
      await Promise.all([load(), props.refresh()])
    } catch (error) { props.onError(errorText(error)) }
  }
  return <Modal title="用户详情" close={props.close} wide>
    {!detail ? <div className="center-state compact"><RefreshCw className="spin" /></div> : <>
      <div className="detail-head"><div><h3>{detail.displayName}</h3><span>{detail.username} · 用户编号 {detail.userId}</span></div><div className="inline-actions"><button onClick={() => setDialog('edit')}>编辑资料</button><button onClick={() => setDialog('password')}>重置密码</button><Status value={detail.active ? 'ACTIVE' : 'FROZEN'} /></div></div>
      <div className="metrics"><div><span>活跃设备</span><strong>{detail.activeDeviceCount}</strong></div><div><span>券商连接</span><strong>{detail.brokerConnections.length}</strong></div><div><span>套餐槽位</span><strong>{detail.subscription ? `${detail.subscription.usedSlots}/${detail.subscription.totalSlots}` : '-'}</strong></div></div>
      <section className="detail-section"><header><h3>当前订阅</h3><div className="inline-actions">{detail.subscription && <button onClick={() => setDialog('slots')}>调整槽位</button>}<button className="primary subtle" onClick={() => setDialog('grant')}><CircleDollarSign size={15} />{detail.subscription ? '调整套餐' : '人工授予'}</button></div></header>
        {detail.subscription ? <div className="subscription-line"><div><strong>{detail.subscription.planDisplayName}</strong><span>{detail.subscription.planCode} v{detail.subscription.planVersion}</span></div><Status value={detail.subscription.status} /><span>{dateText(detail.subscription.startsAt)} 至 {dateText(detail.subscription.expiresAt)}</span><span>来源：{detail.subscription.source === 'ADMIN_GRANT' ? '人工授予' : '支付订单'}</span></div> : <div className="empty compact">尚未开通套餐</div>}
        {detail.subscription?.slots.map(slot => <div className="slot-row" key={slot.slotId}><span>槽位 {slot.slotOrdinal}</span><strong>{slot.providerId ?? '未绑定'}</strong><Status value={slot.status} /><span>{slot.nextRebindAt ? `可换绑 ${dateText(slot.nextRebindAt)}` : '-'}</span></div>)}
        {detail.subscription && <div className="inline-actions">
          {detail.subscription.status === 'ACTIVE' && <button onClick={() => void statusAction('freeze')}>冻结订阅</button>}
          {detail.subscription.status === 'FROZEN' && <button onClick={() => void statusAction('restore')}>恢复订阅</button>}
          <button className="danger" onClick={() => void statusAction('cancel')}>取消订阅</button>
        </div>}
      </section>
      <section className="detail-section"><h3>券商连接</h3>{detail.brokerConnections.map(item => <div className="slot-row" key={item.connectionId}><strong>{item.provider}</strong><span>{item.status}</span><code>{item.connectionId}</code></div>)}</section>
      <section className="detail-section"><h3>套餐变更记录</h3>{history?.grants.slice(0, 8).map(item => <div className="history-row" key={item.grantId}><Status value={item.status} /><span>{item.reason}</span><span>{item.actorUsername}</span><time>{dateText(item.createdAt)}</time></div>)}{history?.grants.length === 0 && <div className="empty compact">暂无人工变更记录</div>}</section>
      <div className="form-actions"><button onClick={() => void statusAction(detail.active ? 'disable' : 'enable')}>{detail.active ? '停用用户' : '启用用户'}</button></div>
      {dialog === 'grant' && <GrantDialog userId={detail.userId} subscription={detail.subscription} close={() => setDialog(null)} done={async () => {
        setDialog(null); await load()
      }} onError={props.onError} />}
      {dialog === 'edit' && <EditUserDialog user={detail} close={() => setDialog(null)} done={async () => {
        setDialog(null); await Promise.all([load(), props.refresh()])
      }} onError={props.onError} />}
      {dialog === 'password' && <ResetPasswordDialog userId={detail.userId} close={() => setDialog(null)} done={() => setDialog(null)} onError={props.onError} />}
      {dialog === 'slots' && detail.subscription && <SlotsDialog userId={detail.userId} subscription={detail.subscription} close={() => setDialog(null)} done={async () => {
        setDialog(null); await load()
      }} onError={props.onError} />}
    </>}
  </Modal>
}

function EditUserDialog(props: { user: UserDetailData; close: () => void; done: () => Promise<void>; onError: (value: string) => void }) {
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = Object.fromEntries(new FormData(event.currentTarget))
    try {
      await api(`/api/v1/admin/users/${props.user.userId}`, idempotent('PATCH', data))
      await props.done()
    } catch (error) { props.onError(errorText(error)) }
  }
  return <Modal title="编辑用户资料" close={props.close}><form className="form-grid" onSubmit={submit}>
    <label>用户名<input name="username" defaultValue={props.user.username} required minLength={3} /></label>
    <label>显示名<input name="displayName" defaultValue={props.user.displayName} required /></label>
    <div className="form-actions full"><button type="button" onClick={props.close}>取消</button><button className="primary">保存</button></div>
  </form></Modal>
}

function ResetPasswordDialog(props: { userId: string; close: () => void; done: () => void; onError: (value: string) => void }) {
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const temporaryPassword = String(data.get('temporaryPassword'))
    if (!window.confirm('确认重置密码并撤销该用户全部登录会话？')) return
    try {
      await api(`/api/v1/admin/users/${props.userId}/reset-password`, idempotent('POST', {
        temporaryPassword,
      }))
      props.done()
    } catch (error) { props.onError(errorText(error)) }
  }
  return <Modal title="重置用户密码" close={props.close}><form className="form-grid" onSubmit={submit}>
    <label className="full">临时密码<input name="temporaryPassword" type="password" required minLength={12} /></label>
    <div className="form-actions full"><button type="button" onClick={props.close}>取消</button><button className="primary">确认重置</button></div>
  </form></Modal>
}

function SlotsDialog(props: { userId: string; subscription: Subscription; close: () => void; done: () => Promise<void>; onError: (value: string) => void }) {
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    try {
      await api(`/api/v1/admin/users/${props.userId}/subscription/slots`, idempotent('PUT', {
        expectedVersion: props.subscription.version,
        providerIds: data.getAll('providerIds').map(String),
        reason: data.get('reason'),
        confirmImpact: data.get('confirmImpact') === 'on',
      }))
      await props.done()
    } catch (error) { props.onError(errorText(error)) }
  }
  return <Modal title="调整券商槽位" close={props.close}><form className="form-grid" onSubmit={submit}>
    <fieldset><legend>保留绑定</legend><label className="check"><input type="checkbox" name="providerIds" value="FUTU" defaultChecked={props.subscription.slots.some(s => s.status === 'ACTIVE' && s.providerId === 'FUTU')} />富途</label><label className="check"><input type="checkbox" name="providerIds" value="LONGBRIDGE" defaultChecked={props.subscription.slots.some(s => s.status === 'ACTIVE' && s.providerId === 'LONGBRIDGE')} />长桥</label></fieldset>
    <label className="full">操作原因<textarea name="reason" required minLength={3} /></label>
    <label className="check full"><input type="checkbox" name="confirmImpact" />确认移除绑定会冻结对应研究池</label>
    <div className="form-actions full"><button type="button" onClick={props.close}>取消</button><button className="primary">保存槽位</button></div>
  </form></Modal>
}

function GrantDialog(props: { userId: string; subscription: Subscription | null; close: () => void; done: () => Promise<void>; onError: (value: string) => void }) {
  const [plans, setPlans] = useState<Plan[]>([])
  useEffect(() => {
    api<Record<string, Plan[]>>('/api/v1/admin/plans').then(result => {
      setPlans(Object.values(result).flat().filter(item => item.status === 'ACTIVE'))
    }).catch(error => props.onError(errorText(error)))
  }, [props.onError])
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const providerIds = data.getAll('providerIds').map(String)
    const startsAt = new Date(String(data.get('startsAt'))).toISOString()
    const expiresAt = new Date(String(data.get('expiresAt'))).toISOString()
    try {
      await api(`/api/v1/admin/users/${props.userId}/${props.subscription ? 'subscription' : 'subscription-grants'}`, idempotent(props.subscription ? 'PATCH' : 'POST', {
        expectedVersion: props.subscription?.version ?? 0,
        planVersionId: data.get('planVersionId'),
        billingPeriod: data.get('billingPeriod'),
        startsAt,
        expiresAt,
        providerIds,
        reason: data.get('reason'),
        confirmImpact: data.get('confirmImpact') === 'on',
      }))
      await props.done()
    } catch (error) { props.onError(errorText(error)) }
  }
  const now = new Date()
  const nextYear = new Date(now); nextYear.setFullYear(nextYear.getFullYear() + 1)
  return <Modal title={props.subscription ? '调整用户套餐' : '人工授予套餐'} close={props.close}>
    <form className="form-grid" onSubmit={submit}>
      <label className="full">套餐版本<select name="planVersionId" defaultValue={props.subscription?.planVersionId} required>{plans.map(plan => <option key={plan.planVersionId} value={plan.planVersionId}>{plan.displayName} v{plan.version}</option>)}</select></label>
      <label>计费周期<select name="billingPeriod" defaultValue={props.subscription?.billingPeriod ?? 'YEARLY'}><option value="MONTHLY">月付</option><option value="QUARTERLY">季付</option><option value="YEARLY">年付</option></select></label>
      <label>开始时间<input name="startsAt" type="datetime-local" defaultValue={now.toISOString().slice(0, 16)} required /></label>
      <label>到期时间<input name="expiresAt" type="datetime-local" defaultValue={nextYear.toISOString().slice(0, 16)} required /></label>
      <fieldset><legend>绑定券商</legend><label className="check"><input type="checkbox" name="providerIds" value="FUTU" defaultChecked={props.subscription?.slots.some(s => s.providerId === 'FUTU')} />富途</label><label className="check"><input type="checkbox" name="providerIds" value="LONGBRIDGE" defaultChecked={props.subscription?.slots.some(s => s.providerId === 'LONGBRIDGE')} />长桥</label></fieldset>
      <label className="full">操作原因<textarea name="reason" required minLength={3} /></label>
      <label className="check full"><input type="checkbox" name="confirmImpact" />确认可能发生的槽位冻结、权益减少或期限缩短</label>
      <div className="form-actions full"><button type="button" onClick={props.close}>取消</button><button className="primary">确认执行</button></div>
    </form>
  </Modal>
}

function PlansPage({ onError }: { onError: (value: string) => void }) {
  const [plans, setPlans] = useState<Record<string, Plan[]>>({})
  const [editing, setEditing] = useState<Plan | null>(null)
  const load = useCallback(async () => {
    try { setPlans(await api<Record<string, Plan[]>>('/api/v1/admin/plans')) }
    catch (error) { onError(errorText(error)) }
  }, [onError])
  useEffect(() => { void load() }, [load])
  async function action(plan: Plan, actionName: 'publish' | 'retire') {
    const impact = actionName === 'publish'
      ? '发布后当前活动版本将退役，新购买和人工授予立即使用此版本'
      : '退役后该版本不能用于新购买或人工授予，历史订阅保持不变'
    if (!window.confirm(`确认${actionName === 'publish' ? '发布' : '退役'} ${plan.displayName} v${plan.version}？\n${impact}。`)) return
    try {
      await api(`/api/v1/admin/plans/${plan.planCode}/versions/${plan.planVersionId}/${actionName}`, idempotent('POST'))
      await load()
    } catch (error) { onError(errorText(error)) }
  }
  async function draft(code: string) {
    try {
      const result = await api<Plan>(`/api/v1/admin/plans/${code}/versions`, idempotent('POST'))
      await load(); setEditing(result)
    } catch (error) { onError(errorText(error)) }
  }
  return <>
    <PageHeader title="套餐目录" meta="固定三档套餐 · 版本化发布" />
    <div className="plan-grid">{(['LITE', 'PRO', 'FLAGSHIP'] as const).map(code => {
      const versions = plans[code] ?? []
      const active = versions.find(item => item.status === 'ACTIVE')
      return <section className="plan-panel" key={code}><header><div><span>{code}</span><h2>{active?.displayName ?? '无活动版本'}</h2></div><button className="icon-button" title="创建新版本" onClick={() => void draft(code)}><Plus size={17} /></button></header>
        {active && <div className="plan-stats"><div><span>券商槽位</span><strong>{active.brokerSlotLimit}</strong></div><div><span>单券商池容量</span><strong>{active.poolCapacityPerProvider ?? '不限'}</strong></div><div><span>月替换额度</span><strong>{active.monthlyReplacementLimit ?? '不限'}</strong></div></div>}
        <div className="version-list">{versions.map(plan => <div className="version-row" key={plan.planVersionId}><span>v{plan.version}</span><Status value={plan.status} /><span>{dateText(plan.effectiveFrom)}</span><div>
          {plan.status === 'DRAFT' && <><button onClick={() => setEditing(plan)}>编辑</button><button onClick={() => void action(plan, 'publish')}>发布</button></>}
          {plan.status !== 'RETIRED' && <button onClick={() => void action(plan, 'retire')}>退役</button>}
        </div></div>)}</div>
      </section>
    })}</div>
    {editing && <PlanDialog plan={editing} close={() => setEditing(null)} done={async () => {
      setEditing(null); await load()
    }} onError={onError} />}
  </>
}

function PlanDialog(props: { plan: Plan; close: () => void; done: () => Promise<void>; onError: (value: string) => void }) {
  const price = (period: string) => props.plan.prices.find(item => item.billingPeriod === period)?.amountMinor ?? 0
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const nullable = (name: string) => data.get(name) === '' ? null : Number(data.get(name))
    try {
      await api(`/api/v1/admin/plans/${props.plan.planCode}/versions/${props.plan.planVersionId}`, idempotent('PUT', {
        displayName: data.get('displayName'),
        effectiveFrom: new Date(String(data.get('effectiveFrom'))).toISOString(),
        brokerSlotLimit: Number(data.get('brokerSlotLimit')),
        poolCapacityPerProvider: nullable('poolCapacityPerProvider'),
        monthlyReplacementLimit: nullable('monthlyReplacementLimit'),
        features: {
          batchSize: Number(data.get('batchSize')),
          optionResearch: data.get('optionResearch') === 'on',
          optionTrading: data.get('optionTrading') === 'on',
        },
        prices: ['MONTHLY', 'QUARTERLY', 'YEARLY'].map(period => ({
          billingPeriod: period,
          amountMinor: Number(data.get(period)),
        })),
      }))
      await props.done()
    } catch (error) { props.onError(errorText(error)) }
  }
  return <Modal title={`编辑 ${props.plan.planCode} v${props.plan.version}`} close={props.close}>
    <form className="form-grid" onSubmit={submit}>
      <label className="full">展示名称<input name="displayName" defaultValue={props.plan.displayName} required /></label>
      <label>生效时间<input name="effectiveFrom" type="datetime-local" defaultValue={props.plan.effectiveFrom.slice(0, 16)} required /></label>
      <label>券商槽位<input name="brokerSlotLimit" type="number" min="1" max="100" defaultValue={props.plan.brokerSlotLimit} required /></label>
      <label>单券商池容量<input name="poolCapacityPerProvider" type="number" min="1" defaultValue={props.plan.poolCapacityPerProvider ?? ''} /></label>
      <label>月替换额度<input name="monthlyReplacementLimit" type="number" min="0" defaultValue={props.plan.monthlyReplacementLimit ?? ''} /></label>
      <label>批量上限<input name="batchSize" type="number" min="1" max="10000" defaultValue={props.plan.features.batchSize} required /></label>
      <label>月付价格（分）<input name="MONTHLY" type="number" min="1" defaultValue={price('MONTHLY')} required /></label>
      <label>季付价格（分）<input name="QUARTERLY" type="number" min="1" defaultValue={price('QUARTERLY')} required /></label>
      <label>年付价格（分）<input name="YEARLY" type="number" min="1" defaultValue={price('YEARLY')} required /></label>
      <fieldset><legend>功能权益</legend><label className="check"><input name="optionResearch" type="checkbox" defaultChecked={props.plan.features.optionResearch} />期权研究</label><label className="check"><input name="optionTrading" type="checkbox" defaultChecked={props.plan.features.optionTrading} />期权交易</label></fieldset>
      <div className="form-actions full"><button type="button" onClick={props.close}>取消</button><button className="primary">保存草稿</button></div>
    </form>
  </Modal>
}

function OfficialModelPage({ onError }: { onError: (value: string) => void }) {
  const [versions, setVersions] = useState<OfficialModel[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [editing, setEditing] = useState<OfficialModel | null | undefined>(undefined)
  const load = useCallback(async () => {
    try {
      const result = await api<{ activeConfigVersionId: string | null; versions: OfficialModel[] }>('/api/v1/admin/official-model')
      setVersions(result.versions); setActiveId(result.activeConfigVersionId)
    } catch (error) { onError(errorText(error)) }
  }, [onError])
  useEffect(() => { void load() }, [load])
  const active = useMemo(() => versions.find(item => item.configVersionId === activeId), [activeId, versions])
  async function action(item: OfficialModel, name: 'test' | 'activate' | 'retire' | 'rollback') {
    if (
      name !== 'test'
      && !window.confirm(
        name === 'activate'
          ? `确认激活长富Pro v${item.version}？现有活动配置将退役。`
          : name === 'retire'
            ? `确认退役长富Pro v${item.version}？若它正在生效，Worker 将使用部署后备配置。`
            : `确认以 v${item.version} 为基础创建回滚草稿？新草稿仍需重新测试和激活。`,
      )
    ) return
    try {
      await api(`/api/v1/admin/official-model/versions/${item.configVersionId}/${name}`, idempotent('POST'))
      await load()
    } catch (error) { onError(errorText(error)) }
  }
  return <>
    <PageHeader title="长富Pro" meta="全局官方模型接入与版本切换" action={<button className="primary" onClick={() => setEditing(null)}><Plus size={16} />新建配置</button>} />
    <section className="model-current"><div className="model-icon"><Bot size={24} /></div><div><span>当前活动版本</span><h2>{active?.displayName ?? '尚未激活数据库配置'}</h2><p>{active ? `${active.model} · 密钥尾号 ${active.keyLastFour}` : 'Worker 将使用部署环境变量中的后备配置'}</p></div>{active && <Status value="ACTIVE" />}</section>
    <div className="table-wrap"><table><thead><tr><th>版本</th><th>名称 / 模型</th><th>协议</th><th>接入点</th><th>测试</th><th>状态</th><th className="right">操作</th></tr></thead>
      <tbody>{versions.map(item => <tr key={item.configVersionId}><td>v{item.version}</td><td><strong>{item.displayName}</strong><small>{item.model} · ****{item.keyLastFour}</small></td><td>{item.protocol === 'OPENAI_RESPONSES' ? 'Responses' : 'Chat Completions'}</td><td className="truncate" title={item.endpoint}>{item.endpoint}</td><td><Status value={item.testStatus} /></td><td><Status value={item.status} /></td><td className="right actions">
        {item.status === 'DRAFT' && <><button onClick={() => setEditing(item)}>编辑</button><button onClick={() => void action(item, 'test')}>测试</button>{item.testStatus === 'SUCCEEDED' && <button onClick={() => void action(item, 'activate')}>激活</button>}</>}
        {item.status === 'RETIRED' && <button onClick={() => void action(item, 'rollback')}>复制回滚</button>}
        {item.status !== 'RETIRED' && <button onClick={() => void action(item, 'retire')}>退役</button>}
      </td></tr>)}</tbody></table>{versions.length === 0 && <div className="empty">尚无数据库模型配置</div>}</div>
    {editing !== undefined && <ModelDialog model={editing} close={() => setEditing(undefined)} done={async () => {
      setEditing(undefined); await load()
    }} onError={onError} />}
  </>
}

function ModelDialog(props: { model: OfficialModel | null; close: () => void; done: () => Promise<void>; onError: (value: string) => void }) {
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = Object.fromEntries(new FormData(event.currentTarget))
    if (!data.apiKey) delete data.apiKey
    try {
      await api(
        props.model
          ? `/api/v1/admin/official-model/versions/${props.model.configVersionId}`
          : '/api/v1/admin/official-model/versions',
        idempotent(props.model ? 'PUT' : 'POST', data),
      )
      await props.done()
    } catch (error) { props.onError(errorText(error)) }
  }
  return <Modal title={props.model ? `编辑长富Pro v${props.model.version}` : '新建长富Pro配置'} close={props.close}>
    <form className="form-grid" onSubmit={submit}>
      <label className="full">配置名称<input name="displayName" defaultValue={props.model?.displayName ?? '长富Pro'} required /></label>
      <label className="full">协议<select name="protocol" defaultValue={props.model?.protocol ?? 'OPENAI_RESPONSES'}><option value="OPENAI_RESPONSES">OpenAI Responses</option><option value="OPENAI_CHAT_COMPLETIONS">OpenAI Chat Completions</option></select></label>
      <label className="full">HTTPS 接入点<input name="endpoint" type="url" defaultValue={props.model?.endpoint} required /></label>
      <label>模型 ID<input name="model" defaultValue={props.model?.model} required /></label>
      <label>API Key<input name="apiKey" type="password" required={!props.model} placeholder={props.model ? `保留原密钥（尾号 ${props.model.keyLastFour}）` : ''} /></label>
      <div className="form-actions full"><button type="button" onClick={props.close}>取消</button><button className="primary">保存草稿</button></div>
    </form>
  </Modal>
}
