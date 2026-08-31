import DataSourcePanel from '@/components/DataSourcePanel'
import StatusTimeline from '@/components/StatusTimeline'
import AppNav from '@/components/common/AppNav'
import AccountSummaryPanel from '@/components/workspace/AccountSummaryPanel'
import CommandCenterHeader from '@/components/workspace/CommandCenterHeader'
import LiveTradingPanel from '@/components/workspace/LiveTradingPanel'
import OpportunityCommandPanel from '@/components/workspace/OpportunityCommandPanel'
import PositionsPanel from '@/components/workspace/PositionsPanel'
import ResearchReportPanel from '@/components/workspace/ResearchReportPanel'
import RiskExposurePanel from '@/components/workspace/RiskExposurePanel'
import SimulationTradingPanel from '@/components/workspace/SimulationTradingPanel'
import WatchlistPanel from '@/components/workspace/WatchlistPanel'
import { useAccountDashboard } from '@/hooks/useAccountDashboard'
import { useReportGeneration } from '@/hooks/useReportGeneration'

export default function Dashboard() {
  const { report, recentReports, promptArchive, latestTopOpportunities, sourceStatus, isGenerating, generationStatus, error, generateReport } = useReportGeneration()
  const { accountDashboard, accountLoading, error: accountError, refreshAccount } = useAccountDashboard()

  return (
    <main className="min-h-screen bg-gradient-to-br from-stone-50 via-amber-50 to-orange-50 text-stone-950">
      <AppNav />
      <div className="mx-auto max-w-7xl space-y-6 px-6 py-8">
        <CommandCenterHeader
          sourceStatus={sourceStatus}
          isGenerating={isGenerating}
          accountLoading={accountLoading}
          generationStatus={generationStatus}
          onGenerate={generateReport}
          onRefreshAccount={refreshAccount}
        />

        {error || accountError ? (
          <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error ?? accountError}</div>
        ) : null}

        <div className="grid gap-6 xl:grid-cols-2">
          <div className="space-y-6">
            <div id="account">
              <AccountSummaryPanel summary={accountDashboard?.summary} positions={accountDashboard?.positions ?? []} />
            </div>
            <div id="positions">
              <PositionsPanel positions={accountDashboard?.positions ?? []} />
            </div>
            <div id="risk">
              <RiskExposurePanel risk={accountDashboard?.risk} />
            </div>
            <div id="data-source">
              <DataSourcePanel status={sourceStatus} />
            </div>
          </div>
          <div className="space-y-6">
            <div id="research">
              <OpportunityCommandPanel opportunities={latestTopOpportunities} />
            </div>
            <div id="report-center">
              <ResearchReportPanel recentReports={recentReports} />
            </div>
            <div id="watchlist">
              <WatchlistPanel report={report} promptArchive={promptArchive} />
            </div>
            <div id="trading">
              <LiveTradingPanel trading={accountDashboard?.trading} />
            </div>
            <SimulationTradingPanel />
          </div>
        </div>

        <StatusTimeline active={isGenerating} completed={Boolean(report)} />
      </div>
    </main>
  )
}
