import { create } from 'zustand'

export type UiLanguage = 'zh' | 'en'

type UiState = {
  language: UiLanguage
  assetPrivacyHidden: boolean
  setLanguage: (language: UiLanguage) => void
  toggleLanguage: () => void
  setAssetPrivacyHidden: (hidden: boolean) => void
  toggleAssetPrivacyHidden: () => void
}

const ASSET_PRIVACY_STORAGE_KEY = 'assetPrivacyHidden'

function readAssetPrivacyHidden(): boolean {
  if (typeof window === 'undefined') return false
  return window.localStorage.getItem(ASSET_PRIVACY_STORAGE_KEY) === 'true'
}

function persistAssetPrivacyHidden(hidden: boolean) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(ASSET_PRIVACY_STORAGE_KEY, String(hidden))
}

export const useUiStore = create<UiState>((set) => ({
  language: 'zh',
  assetPrivacyHidden: readAssetPrivacyHidden(),
  setLanguage: (language) => set({ language }),
  toggleLanguage: () => set((state) => ({ language: state.language === 'zh' ? 'en' : 'zh' })),
  setAssetPrivacyHidden: (hidden) => {
    persistAssetPrivacyHidden(hidden)
    set({ assetPrivacyHidden: hidden })
  },
  toggleAssetPrivacyHidden: () =>
    set((state) => {
      const hidden = !state.assetPrivacyHidden
      persistAssetPrivacyHidden(hidden)
      return { assetPrivacyHidden: hidden }
    }),
}))
