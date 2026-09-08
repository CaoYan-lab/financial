import { useEffect, useState } from 'react'
import { Loader2, LogOut } from 'lucide-react'
import App from '@/App'
import LoginView from './LoginView'
import { useAuthStore } from './authStore'
import { cloudLogout, fetchAuthConfig, fetchCurrentUser, installCloudFetchGuard } from './cloudFetch'
import MultiUserShell from '@/multiuser/MultiUserShell'

function AuthGate() {
  const { status, username, setAuthed, setAnon, setChecking } = useAuthStore()
  const [authRequired, setAuthRequired] = useState<boolean | null>(null)

  useEffect(() => {
    installCloudFetchGuard()
    const check = async () => {
      setChecking()
      const enabled = await fetchAuthConfig()
      setAuthRequired(enabled)
      if (!enabled) return
      const name = await fetchCurrentUser()
      if (name) setAuthed(name)
      else setAnon()
    }
    void check()
  }, [setAuthed, setAnon, setChecking])

  if (authRequired === false) {
    return <App />
  }

  if (authRequired === null || status === 'checking') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[radial-gradient(circle_at_top_left,rgba(251,146,60,0.24),transparent_30rem),radial-gradient(circle_at_top_right,rgba(34,211,238,0.2),transparent_28rem),linear-gradient(135deg,#fffaf0_0%,#f8fafc_54%,#eef6ff_100%)]">
        <div className="flex items-center gap-3 text-sm font-semibold text-stone-500">
          <Loader2 className="h-5 w-5 animate-spin text-orange-500" />
          正在校验登录状态…
        </div>
      </div>
    )
  }

  if (status === 'anon') {
    return <LoginView />
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          void cloudLogout().then(() => setAnon())
        }}
        title="退出登录"
        className="fixed left-4 bottom-4 z-[9999] flex items-center gap-1.5 rounded-2xl border border-orange-200 bg-white/90 px-4 py-2 text-xs font-bold text-orange-700 shadow-lg shadow-slate-900/10 backdrop-blur transition hover:bg-orange-50"
      >
        <LogOut className="h-3.5 w-3.5" />
        退出{username ? `（${username}）` : ''}
      </button>
      <MultiUserShell>
        <App />
      </MultiUserShell>
    </>
  )
}

export default function CloudApp() {
  return <AuthGate />
}
