import { Eye, EyeOff } from 'lucide-react'
import { useUiStore } from '@/stores/uiStore'

export default function AssetPrivacyToggle() {
  const hidden = useUiStore((state) => state.assetPrivacyHidden)
  const toggle = useUiStore((state) => state.toggleAssetPrivacyHidden)
  const label = hidden ? '显示资产' : '隐藏资产'
  const Icon = hidden ? EyeOff : Eye

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-orange-200 bg-orange-50 text-orange-700 shadow-sm transition hover:border-orange-300 hover:bg-orange-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400"
      onClick={toggle}
    >
      <Icon size={16} />
    </button>
  )
}
