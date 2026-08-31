import type { TradeExecutionMode, TradeStrategyConfigResponse, UpdateTradeStrategyConfigRequest } from '../../../shared/types'
import { useUiStore, type UiLanguage } from '../../stores/uiStore'
import Badge from '../common/Badge'

export default function TradeStrategyConfigPanel({
  title,
  subtitle,
  config,
  saving,
  dark = false,
  showPortfolioExecutionMode = false,
  enableTradingAgentExecutionMode = false,
  eyebrow = 'TRADE STRATEGY',
  accent = 'futu',
  onSave,
}: {
  title: string
  subtitle: string
  config?: TradeStrategyConfigResponse
  saving: boolean
  dark?: boolean
  showPortfolioExecutionMode?: boolean
  enableTradingAgentExecutionMode?: boolean
  eyebrow?: string
  accent?: 'futu' | 'longbridge'
  onSave: (input: UpdateTradeStrategyConfigRequest) => void
}) {
  const language = useUiStore((state) => state.language)
  const selection = config?.selection
  const activeStrategy = config?.activeStrategy
  const activePromptPack = config?.activePromptPack
  const executionMode = selection?.executionMode ?? 'legacy_direct'
  const portfolioModeEnabled = executionMode === 'candidate_pool'
  const tradingAgentModeEnabled = executionMode === 'trading_agent'
  const executionModeOptions: Array<{
    mode: TradeExecutionMode
    label: string
    title: string
    description: string
    chain: string
  }> = enableTradingAgentExecutionMode
    ? [
        {
          mode: 'legacy_direct',
          label: copy(language, '直推模式', 'legacy_direct'),
          title: copy(language, '大模型直推', 'Direct LLM'),
          description: copy(language, '单票大模型决策直接进入硬风控；通过后进入待确认订单。', 'Single LLM decision goes directly to hard controls, then pending orders if it passes.'),
          chain: copy(language, '标的扫描 -> 大模型单票决策 -> 硬风控 -> 人工确认', 'Ticker scan -> single LLM decision -> hard controls -> manual confirmation'),
        },
        {
          mode: 'candidate_pool',
          label: copy(language, '候选池模式', 'candidate_pool'),
          title: copy(language, '候选池组合裁决', 'Candidate-Pool Decision'),
          description: copy(language, '非观望先进入候选池，再由组合裁决比较多票优先级。', 'Non-hold signals enter the candidate pool before portfolio-level prioritization.'),
          chain: copy(language, '标的扫描 -> 候选池 -> 组合裁决 -> 硬风控 -> 人工确认', 'Ticker scan -> candidate pool -> portfolio decision -> hard controls -> manual confirmation'),
        },
        {
          mode: 'trading_agent',
          label: copy(language, '多角色代理模式', 'trading_agent'),
          title: copy(language, '多角色交易代理实验', 'Trading Agent Experiment'),
          description: copy(language, '多角色代理研究链输出最终裁决；非观望不进入候选池。', 'Multi-role agent research chain produces the final decision; non-hold signals do not enter the candidate pool.'),
          chain: copy(language, '标的扫描 -> 多角色代理 -> 投资组合经理最终裁决 -> 硬风控 -> 人工确认', 'Ticker scan -> multi-role agents -> PM final decision -> hard controls -> manual confirmation'),
        },
      ]
    : []
  const activeExecutionMode = executionModeOptions.find((item) => item.mode === executionMode)
  const cardClass = dark ? 'rounded-3xl border border-stone-200 bg-white/90 p-6 text-stone-950 backdrop-blur' : 'rounded-3xl border border-amber-100 bg-white/90 p-6 text-stone-950 shadow-sm'
  const labelClass = dark ? 'text-sm font-semibold text-stone-600' : 'text-sm font-semibold text-stone-700'
  const inputClass = dark ? 'mt-2 w-full rounded-2xl border border-stone-200 bg-white px-4 py-3 text-sm text-stone-900' : 'mt-2 w-full rounded-2xl border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900'
  const mutedClass = dark ? 'text-sm text-stone-600' : 'text-sm text-stone-600'
  const preClass = dark ? 'mt-3 max-h-96 overflow-auto rounded-2xl bg-stone-50 p-4 text-xs text-stone-700' : 'mt-3 max-h-96 overflow-auto rounded-2xl bg-stone-50 p-4 text-xs text-stone-700'
  const contentCardClass = dark ? 'rounded-2xl border border-stone-200 bg-stone-50 p-5' : 'rounded-2xl border border-stone-200 bg-stone-50/80 p-5'
  const modeCardClass = dark ? 'rounded-2xl border border-stone-200 bg-stone-50 p-5' : 'rounded-2xl border border-stone-200 bg-stone-50 p-5'
  const theme = accent === 'longbridge'
    ? {
        eyebrow: 'text-sky-700',
        badge: 'border-sky-200 bg-sky-50 text-sky-700',
        primaryButton: 'bg-sky-500 text-white hover:bg-sky-400',
        summary: 'text-sky-700',
        modeEyebrow: portfolioModeEnabled ? 'text-indigo-700' : 'text-sky-700',
        modeButton: portfolioModeEnabled ? 'bg-sky-100 text-sky-800 hover:bg-sky-200' : 'bg-gradient-to-r from-sky-500 to-indigo-500 text-white hover:from-sky-400 hover:to-indigo-400',
        warning: 'border-sky-200 bg-sky-50 text-sky-800',
      }
    : {
        eyebrow: dark ? 'text-orange-700' : 'text-amber-700',
        badge: undefined,
        primaryButton: dark ? 'bg-orange-400 text-stone-950 hover:bg-orange-300' : 'bg-amber-600 text-stone-950 hover:bg-amber-500',
        summary: dark ? 'text-orange-800' : 'text-amber-700',
        modeEyebrow: portfolioModeEnabled ? 'text-orange-700' : 'text-amber-700',
        modeButton: portfolioModeEnabled ? 'bg-amber-400 text-stone-950 hover:bg-amber-300' : 'bg-gradient-to-r from-orange-500 to-rose-500 text-stone-950 hover:from-orange-400 hover:to-rose-400',
        warning: 'border-amber-200 bg-amber-50 text-amber-800',
      }

  return (
    <section className={cardClass}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className={`text-xs font-semibold tracking-[0.25em] ${theme.eyebrow}`}>{eyebrow}</p>
          <h2 className="mt-2 text-2xl font-semibold">{title}</h2>
          <p className={`mt-2 ${mutedClass}`}>{subtitle}</p>
        </div>
        {theme.badge ? (
          <span className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${theme.badge}`}>{selection?.updatedAt ?? copy(language, '未加载', 'Not Loaded')}</span>
        ) : (
          <Badge tone={dark ? 'amber' : 'violet'}>{selection?.updatedAt ?? copy(language, '未加载', 'Not Loaded')}</Badge>
        )}
      </div>

      <div className={`mt-5 grid gap-4 ${showPortfolioExecutionMode ? 'xl:grid-cols-[minmax(0,1fr)_360px]' : ''}`}>
        <div className={showPortfolioExecutionMode ? contentCardClass : ''}>
          <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto]">
            <label className={labelClass}>
              {copy(language, '策略版本', 'Strategy Version')}
              <select className={inputClass} value={selection?.strategyId ?? ''} onChange={(event) => onSave({ strategyId: event.target.value, promptPackId: selection?.promptPackId })}>
                {(config?.strategyOptions ?? []).map((option) => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className={labelClass}>
              {copy(language, '提示词版本', 'Prompt Version')}
              <select className={inputClass} value={selection?.promptPackId ?? ''} onChange={(event) => onSave({ strategyId: selection?.strategyId, promptPackId: event.target.value })}>
                {(config?.promptPackOptions ?? []).map((option) => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </select>
            </label>
            <button
              className={`self-end rounded-2xl px-4 py-3 text-sm font-bold disabled:opacity-60 ${theme.primaryButton}`}
              disabled={saving || !selection}
              onClick={() => selection && onSave({ strategyId: selection.strategyId, promptPackId: selection.promptPackId })}
            >
              {saving ? copy(language, '保存中', 'Saving') : copy(language, '保存策略版本', 'Save Strategy Version')}
            </button>
          </div>

          <div className={`mt-4 grid gap-3 md:grid-cols-2 ${mutedClass}`}>
            <p><strong className={dark ? 'text-stone-950' : 'text-stone-900'}>{activeStrategy?.label ?? copy(language, '策略未加载', 'Strategy not loaded')}</strong><br />{activeStrategy?.summary ?? copy(language, '暂无策略摘要', 'No strategy summary')}</p>
            <p><strong className={dark ? 'text-stone-950' : 'text-stone-900'}>{activePromptPack?.label ?? copy(language, '提示词未加载', 'Prompt not loaded')}</strong><br />{activePromptPack?.summary ?? copy(language, '暂无提示词摘要', 'No prompt summary')}</p>
          </div>

          <details className="mt-4">
            <summary className={`cursor-pointer text-sm font-semibold ${theme.summary}`}>{copy(language, '查看策略和提示词全文', 'View Full Strategy and Prompt')}</summary>
            <div className="mt-3 grid gap-4 xl:grid-cols-2">
              <div>
                <p className={labelClass}>{copy(language, '策略配置', 'Strategy YAML')}</p>
                <pre className={preClass}>{activeStrategy?.rawYaml ?? JSON.stringify(activeStrategy, null, 2)}</pre>
              </div>
              <div>
                <p className={labelClass}>{copy(language, '提示词配置', 'Prompt YAML')}</p>
                <pre className={preClass}>{activePromptPack?.rawYaml ?? JSON.stringify(activePromptPack, null, 2)}</pre>
              </div>
            </div>
          </details>

          {config?.warnings.length ? <p className={`mt-3 rounded-2xl border p-3 text-sm ${theme.warning}`}>{config.warnings.join('；')}</p> : null}
          <p className={`mt-3 text-xs ${dark ? 'text-stone-500' : 'text-stone-500'}`}>{copy(language, '保存后从下一轮评估生效；不会绕过实盘门禁或人工二次确认。', 'Changes apply from the next evaluation and never bypass live gates or manual confirmation.')}</p>
        </div>

        {showPortfolioExecutionMode ? (
          <aside className={modeCardClass}>
            <div className="flex h-full flex-col justify-between gap-5">
              <div>
                <p className={`text-xs font-semibold tracking-[0.2em] ${theme.modeEyebrow}`}>
                  {enableTradingAgentExecutionMode ? copy(language, '执行模式', 'Execution Mode') : copy(language, '组合策略模式', 'Portfolio Strategy Mode')}
                </p>
                <h3 className="mt-2 text-lg font-semibold">
                  {enableTradingAgentExecutionMode
                    ? activeExecutionMode?.title ?? copy(language, '大模型直推', 'Direct LLM')
                    : portfolioModeEnabled ? copy(language, '组合策略已开启', 'Portfolio Strategy On') : copy(language, '组合策略已关闭 · 老逻辑直推', 'Portfolio Strategy Off · Legacy Direct')}
                </h3>
                <p className={`mt-2 ${mutedClass}`}>
                  {enableTradingAgentExecutionMode
                    ? `${copy(language, '当前链路', 'Current flow')}：${activeExecutionMode?.chain ?? copy(language, '标的扫描 -> 大模型单票决策 -> 硬风控 -> 人工确认', 'Ticker scan -> single LLM decision -> hard controls -> manual confirmation')}。`
                    : portfolioModeEnabled
                      ? copy(language, '当前链路：标的扫描 -> 候选池 -> 组合裁决 -> 后端硬风控 -> 人工确认。', 'Current flow: ticker scan -> candidate pool -> portfolio decision -> backend hard controls -> manual confirmation.')
                      : copy(language, '当前链路：标的扫描 -> 后端硬风控 -> 人工确认。关闭时不写入候选池，也不调用组合裁决提示词。', 'Current flow: ticker scan -> backend hard controls -> manual confirmation. When off, signals do not enter the candidate pool or call the portfolio-decision prompt.')}
                </p>
              </div>
              <div>
                {enableTradingAgentExecutionMode ? (
                  <div className="grid gap-2">
                    {executionModeOptions.map((option) => {
                      const active = executionMode === option.mode
                      return (
                        <button
                          key={option.mode}
                          className={`rounded-2xl border px-4 py-3 text-left text-sm transition disabled:cursor-not-allowed disabled:opacity-60 ${
                            active
                              ? 'border-orange-300 bg-orange-50 text-stone-950 shadow-sm'
                              : 'border-stone-200 bg-white text-stone-700 hover:border-orange-200 hover:bg-orange-50/70'
                          }`}
                          disabled={saving || !selection || active}
                          onClick={() =>
                            selection &&
                            onSave({
                              strategyId: selection.strategyId,
                              promptPackId: selection.promptPackId,
                              executionMode: option.mode,
                            })
                          }
                          type="button"
                        >
                          <span className="block text-[11px] font-black tracking-[0.16em] text-orange-700">{option.label}</span>
                          <span className="mt-1 block font-black">{option.title}</span>
                          <span className="mt-1 block text-xs leading-5 text-stone-500">{option.description}</span>
                        </button>
                      )
                    })}
                  </div>
                ) : (
                  <button
                    className={`w-full rounded-2xl px-4 py-3 text-sm font-bold disabled:opacity-60 ${theme.modeButton}`}
                    disabled={saving || !selection}
                    onClick={() =>
                      selection &&
                      onSave({
                        strategyId: selection.strategyId,
                        promptPackId: selection.promptPackId,
                        executionMode: portfolioModeEnabled ? 'legacy_direct' : 'candidate_pool',
                      })
                    }
                    type="button"
                  >
                    {saving ? copy(language, '保存中', 'Saving') : portfolioModeEnabled ? copy(language, '关闭组合策略，回到老逻辑', 'Turn Off Portfolio Strategy') : copy(language, '开启组合策略', 'Turn On Portfolio Strategy')}
                  </button>
                )}
                <div className={`mt-3 grid gap-2 text-xs ${dark ? 'text-stone-500' : 'text-stone-500'}`}>
                  <span>{copy(language, '当前模式', 'Current mode')}：{enableTradingAgentExecutionMode ? activeExecutionMode?.title ?? executionMode : portfolioModeEnabled ? copy(language, '候选池组合裁决', 'Candidate-Pool Decision') : copy(language, '老逻辑直推', 'Legacy Direct')}</span>
                  <span>{copy(language, '开启后只影响后续新信号', 'Only future signals are affected')}</span>
                  <span>{copy(language, '人工确认与硬风控始终保留', 'Manual confirmation and hard controls always remain')}</span>
                  {tradingAgentModeEnabled ? <span>{copy(language, '多角色交易代理中间报告不写入候选池', 'Trading Agent intermediate reports do not enter the candidate pool')}</span> : null}
                </div>
              </div>
            </div>
          </aside>
        ) : null}
      </div>
    </section>
  )
}

function copy(language: UiLanguage, zh: string, en: string) {
  return language === 'zh' ? zh : en
}
