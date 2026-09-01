import { useEffect } from 'react'
import { Loader2, LogOut } from 'lucide-react'
import App from '@/App'
import LoginView from './LoginView'
import { useAuthStore, authEnabledOnFrontend } from './authStore'
import { fetchCurrentUser, installCloudFetchGuard, cloudLogout } from './cloudFetch'

function AuthGate() {
  const { status, username, setAuthed, setAnon, setChecking } = useAuthStore()

  useEffect(() => {
    installCloudFetchGuard()
    const check = () => {
      setChecking()
      void fetchCurrentUser().then((name) => {
        if (name) setAuthed(name)
        else setAnon()
      })
    }
    check()
    const onUnauthorized = () => setAnon()
    window.addEventListener('cloud:unauthorized', onUnauthorized)
    return () => window.removeEventListener('cloud:unauthorized', onUnauthorized)
  }, [setAuthed, setAnon, setChecking])

  if (status === 'checking') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#070b10]">
        <div className="flex items-center gap-3 text-sm text-slate-400">
          <Loader2 className="h-5 w-5 animate-spin text-cyan-300" />
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
        className="fixed left-4 bottom-4 z-[9999] flex items-center gap-1.5 rounded-md border border-slate-700 bg-[#0d1420]/95 px-3 py-1.5 text-xs text-slate-300 shadow-lg transition hover:border-amber-400/40 hover:text-amber-200"
      >
        <LogOut className="h-3.5 w-3.5" />
        退出{username ? `（${username}）` : ''}
      </button>
      <App />
    </>
  )
}

export default function CloudApp() {
  if (!authEnabledOnFrontend()) {
    return <App />
  }
  return <AuthGate />
}
