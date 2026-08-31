import { Loader2, RefreshCw, ShieldAlert } from 'lucide-react'
import Badge from '@/components/common/Badge'
import { useUiStore } from '@/stores/uiStore'
import type { SourceStatusResponse } from '../../../shared/types'

export default function CommandCenterHeader({
  sourceStatus,
  isGenerating,
  accountLoading,
  generationStatus,
  onGenerate,
  onRefreshAccount,
}: {
  sourceStatus?: SourceStatusResponse
  isGenerating: boolean
  accountLoading: boolean
  generationStatus?: string
  onGenerate: (reportWindowDays?: 30 | 60) => void
  onRefreshAccount: () => void
}) {
  const language = useUiStore((state) => state.language)

  return (
    <section className="rounded-3xl border border-amber-100 bg-white/90 p-6 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-6">
        <div>
          <p className="text-xs font-semibold tracking-[0.25em] text-amber-700">{language === 'zh' ? 'Futu 量化交易工作台' : 'Futu Quant Workbench'}</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight text-stone-950 md:text-5xl">
            {language === 'zh' ? 'Futu 量化交易工作台' : 'Futu Quant Workbench'}
          </h1>
          <p className="mt-4 max-w-4xl text-stone-600">
            {language === 'zh'
              ? 'Futu 账户、持仓、风险、Top 30 CSP 研究、实盘入口和模拟盘集中在一个工作台；研究结果不会自动触发交易。'
              : 'Futu account, positions, risk, Top 30 CSP research, live trading entry and paper trading in one workspace; research never triggers trades automatically.'}
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <Badge tone={sourceStatus?.futuOpenDAvailable ? 'emerald' : 'red'}>
              {language === 'zh' ? `OpenD ${sourceStatus?.futuOpenDAvailable ? '已连接' : '离线'}` : `OpenD ${sourceStatus?.futuOpenDAvailable ? 'Connected' : 'Offline'}`}
            </Badge>
            <Badge tone={sourceStatus?.futuOpenDLoggedIn ? 'emerald' : 'amber'}>
              {language === 'zh' ? `登录${sourceStatus?.futuOpenDLoggedIn ? '就绪' : '待完成'}` : `Login ${sourceStatus?.futuOpenDLoggedIn ? 'Ready' : 'Required'}`}
            </Badge>
            <Badge tone="red">
              <ShieldAlert className="mr-1 inline" size={14} />
              {language === 'zh' ? '实盘门禁开启' : 'Live trading gated'}
            </Badge>
          </div>
        </div>
        <div className="flex flex-wrap gap-3">
          <button
            className="rounded-2xl border border-stone-200 bg-white px-5 py-3 text-sm font-semibold text-stone-700 hover:bg-stone-50"
            onClick={onRefreshAccount}
            disabled={accountLoading}
          >
            {accountLoading ? <Loader2 className="mr-2 inline animate-spin" size={16} /> : <RefreshCw className="mr-2 inline" size={16} />}
            {language === 'zh' ? '刷新账户/持仓' : 'Refresh Account'}
          </button>
          <button
            className="rounded-2xl bg-amber-600 px-5 py-3 text-sm font-bold text-stone-950 hover:bg-amber-500 disabled:opacity-60"
            onClick={() => onGenerate(30)}
            disabled={isGenerating}
          >
            {isGenerating ? <Loader2 className="mr-2 inline animate-spin" size={16} /> : null}
            {language === 'zh' ? '生成 30 日 Top 30 CSP 报告' : 'Generate 30D Top 30 CSP Report'}
          </button>
          <button
            className="rounded-2xl bg-orange-600 px-5 py-3 text-sm font-bold text-white hover:bg-orange-500 disabled:opacity-60"
            onClick={() => onGenerate(60)}
            disabled={isGenerating}
          >
            {isGenerating ? <Loader2 className="mr-2 inline animate-spin" size={16} /> : null}
            {language === 'zh' ? '生成 60 日 Top 30 CSP 报告' : 'Generate 60D Top 30 CSP Report'}
          </button>
        </div>
      </div>
      {generationStatus ? (
        <div className="mt-5 rounded-2xl border border-amber-100 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">
          {generationStatus}
        </div>
      ) : null}
    </section>
  )
}
