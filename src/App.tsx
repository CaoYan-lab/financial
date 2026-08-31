import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import HashScrollHandler from "@/components/common/HashScrollHandler";
import Dashboard from "@/pages/Dashboard";
import LiveOrderDetailView from "@/pages/LiveOrderDetailView";
import LiveTradingView from "@/pages/LiveTradingView";
import LongbridgeWorkbenchPlaceholder from "@/pages/LongbridgeWorkbenchPlaceholder";
import LongbridgeLiveTradingView from "@/pages/longbridge/LongbridgeLiveTradingView";
import LongbridgeOpportunityHistoryView from "@/pages/longbridge/LongbridgeOpportunityHistoryView";
import LongbridgePromptView from "@/pages/longbridge/LongbridgePromptView";
import AshareWorkbenchView from "@/pages/ashare/AshareWorkbenchView";
import AshareLiveTradingView from "@/pages/ashare/AshareLiveTradingView";
import LongbridgeReportHistoryView from "@/pages/longbridge/LongbridgeReportHistoryView";
import LongbridgeReportView from "@/pages/longbridge/LongbridgeReportView";
import OpportunityHistoryView from "@/pages/OpportunityHistoryView";
import PlatformSelectView from "@/pages/PlatformSelectView";
import ReportHistoryView from "@/pages/ReportHistoryView";
import RealtimeStockView from "@/pages/RealtimeStockView";
import ReportView from "@/pages/ReportView";
import SimulationOrderDetailView from "@/pages/SimulationOrderDetailView";
import SimulationTradingView from "@/pages/SimulationTradingView";
import Top30PromptView from "@/pages/Top30PromptView";

export default function App() {
  return (
    <Router>
      <HashScrollHandler />
      <Routes>
        <Route path="/" element={<PlatformSelectView />} />
        <Route path="/futu" element={<Dashboard />} />
        <Route path="/a-share" element={<AshareWorkbenchView />} />
        <Route path="/a-share/live-trading" element={<AshareLiveTradingView />} />
        <Route path="/longbridge" element={<LongbridgeWorkbenchPlaceholder />} />
        <Route path="/longbridge/live-trading" element={<LongbridgeLiveTradingView />} />
        <Route path="/longbridge/reports" element={<LongbridgeReportHistoryView />} />
        <Route path="/longbridge/reports/:batchId" element={<LongbridgeReportView />} />
        <Route path="/longbridge/opportunities" element={<LongbridgeOpportunityHistoryView />} />
        <Route path="/longbridge/top30-prompt" element={<LongbridgePromptView />} />
        <Route path="/report" element={<ReportHistoryView />} />
        <Route path="/reports" element={<ReportHistoryView />} />
        <Route path="/reports/:batchId" element={<ReportView />} />
        <Route path="/opportunities" element={<OpportunityHistoryView />} />
        <Route path="/top30-prompt" element={<Top30PromptView />} />
        <Route path="/live-trading" element={<LiveTradingView />} />
        <Route path="/live-trading/orders/:orderId" element={<LiveOrderDetailView />} />
        <Route path="/simulation" element={<SimulationTradingView />} />
        <Route path="/simulation/orders/:historyId" element={<SimulationOrderDetailView />} />
        <Route path="/simulation/futu-orders/:orderId" element={<SimulationOrderDetailView />} />
        <Route path="/stocks/:ticker" element={<RealtimeStockView />} />
      </Routes>
    </Router>
  );
}
