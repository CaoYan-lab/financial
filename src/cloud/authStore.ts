import { create } from 'zustand'

export type AuthStatus = 'checking' | 'anon' | 'authed'

type AuthState = {
  status: AuthStatus
  username: string | null
  setAuthed: (username: string) => void
  setAnon: () => void
  setChecking: () => void
}

export const useAuthStore = create<AuthState>((set) => ({
  status: 'checking',
  username: null,
  setAuthed: (username) => set({ status: 'authed', username }),
  setAnon: () => set({ status: 'anon', username: null }),
  setChecking: () => set({ status: 'checking' }),
}))
