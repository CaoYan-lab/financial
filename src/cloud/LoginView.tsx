import { useState, type FormEvent } from 'react'
import { ArrowRight, Loader2, Lock, ShieldCheck, User } from 'lucide-react'
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
      setAuthed(result.username ?? '')
    } else {
      setError(result.error ?? '登录失败')
    }
  }

  return (
    <main className="min-h-screen overflow-x-hidden bg-[radial-gradient(circle_at_top_left,rgba(251,146,60,0.24),transparent_30rem),radial-gradient(circle_at_top_right,rgba(34,211,238,0.2),transparent_28rem),linear-gradient(135deg,#fffaf0_0%,#f8fafc_54%,#eef6ff_100%)] text-stone-950">
      <div className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-6 py-12">
        <header className="mb-8 flex items-center gap-3">
          <span className="grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-amber-500 to-rose-400 text-lg font-black text-stone-950 shadow-sm shadow-orange-200">
            量
          </span>
          <div>
            <p className="text-lg font-black tracking-tight text-stone-950">量化交易工作台</p>
            <p className="text-sm text-stone-500">平台入口 · 账户 · 行情 · 策略 · 风控</p>
          </div>
        </header>

        <section className="relative overflow-hidden rounded-[2rem] border border-orange-200/80 bg-white/80 p-8 shadow-xl shadow-slate-900/10 backdrop-blur">
          <div className="absolute inset-x-0 top-0 h-40 bg-gradient-to-br from-orange-200/70 via-rose-100/70 to-transparent" />
          <div className="relative">
            <div className="mb-6 flex items-center gap-3">
              <span className="grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-amber-400 to-rose-400 text-stone-950 shadow-inner">
                <ShieldCheck size={24} />
              </span>
              <div>
                <p className="inline-flex rounded-full bg-orange-100 px-3 py-1 text-xs font-black tracking-[0.24em] text-orange-700">
                  账户登录
                </p>
                <h1 className="mt-2 text-2xl font-black tracking-[-0.03em] text-slate-950">登录后进入量化工作区</h1>
              </div>
            </div>

            <form onSubmit={handleSubmit} className="space-y-5">
              <label className="block">
                <span className="mb-1.5 block text-sm font-bold text-stone-700">管理员账号</span>
                <div className="relative">
                  <User className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" />
                  <input
                    type="text"
                    autoComplete="username"
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    className="w-full rounded-2xl border border-stone-200 bg-white py-3 pl-10 pr-3 text-sm font-semibold text-stone-900 outline-none transition placeholder:font-normal placeholder:text-stone-400 focus:border-amber-400 focus:ring-2 focus:ring-amber-200"
                    placeholder="请输入账号"
                    autoFocus
                  />
                </div>
              </label>

              <label className="block">
                <span className="mb-1.5 block text-sm font-bold text-stone-700">密码</span>
                <div className="relative">
                  <Lock className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" />
                  <input
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    className="w-full rounded-2xl border border-stone-200 bg-white py-3 pl-10 pr-3 text-sm font-semibold text-stone-900 outline-none transition placeholder:font-normal placeholder:text-stone-400 focus:border-amber-400 focus:ring-2 focus:ring-amber-200"
                    placeholder="请输入密码"
                  />
                </div>
              </label>

              {error && (
                <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={submitting || !username || !password}
                className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-slate-950 px-5 py-3.5 text-sm font-black text-white shadow-lg shadow-slate-900/15 transition hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {submitting ? '登录中…' : '登 录'}
                {!submitting && <ArrowRight className="h-4 w-4" />}
              </button>
            </form>

            <p className="mt-6 rounded-2xl border border-amber-100 bg-amber-50 px-4 py-3 text-center text-xs font-semibold leading-relaxed text-amber-800">
              本站为私有量化交易系统，交易指令须经人工确认，研究结果不会自动触发交易。
            </p>
          </div>
        </section>
      </div>
    </main>
  )
}
