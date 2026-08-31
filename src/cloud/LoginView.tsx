import { useState, type FormEvent } from 'react'
import { ShieldCheck, Loader2, Lock, User } from 'lucide-react'
import { cloudLogin } from './cloudFetch'
import { useAuthStore } from './authStore'

export default function LoginView() {
  const setAuthed = useAuthStore((state) => state.setAuthed)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setError(null)
    const result = await cloudLogin(username.trim(), password)
    setSubmitting(false)
    if (result.success) {
      setAuthed(result.username)
    } else {
      setError(result.error)
    }
  }

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-[#070b10] px-4">
      <div className="w-full max-w-md">
        <div className="rounded-lg border border-cyan-500/20 bg-[#0d1420]/90 shadow-[0_0_40px_rgba(34,211,238,0.08)] p-8">
          <div className="flex items-center gap-3 mb-2">
            <div className="flex h-10 w-10 items-center justify-center rounded-md border border-cyan-400/30 bg-cyan-400/10">
              <ShieldCheck className="h-5 w-5 text-cyan-300" />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-slate-100 tracking-wide">量化交易工作台</h1>
              <p className="text-xs text-slate-400">账户登录 · 登录后可访问行情、研究与交易模块</p>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-slate-300">管理员账号</span>
              <div className="relative">
                <User className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                <input
                  type="text"
                  autoComplete="username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  className="w-full rounded-md border border-slate-700 bg-[#0a1018] py-2.5 pl-9 pr-3 text-sm text-slate-100 outline-none focus:border-cyan-400/60 focus:ring-1 focus:ring-cyan-400/30"
                  placeholder="请输入账号"
                  autoFocus
                />
              </div>
            </label>

            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-slate-300">密码</span>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                <input
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="w-full rounded-md border border-slate-700 bg-[#0a1018] py-2.5 pl-9 pr-3 text-sm text-slate-100 outline-none focus:border-cyan-400/60 focus:ring-1 focus:ring-cyan-400/30"
                  placeholder="请输入密码"
                />
              </div>
            </label>

            {error && (
              <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting || !username || !password}
              className="flex w-full items-center justify-center gap-2 rounded-md border border-cyan-400/40 bg-cyan-500/15 py-2.5 text-sm font-medium text-cyan-200 transition hover:bg-cyan-500/25 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              {submitting ? '登录中…' : '登 录'}
            </button>
          </form>

          <p className="mt-6 text-center text-[11px] leading-relaxed text-slate-500">
            本站为私有量化交易系统，交易指令须经人工确认，研究结果不会自动触发交易。
          </p>
        </div>
      </div>
    </div>
  )
}
