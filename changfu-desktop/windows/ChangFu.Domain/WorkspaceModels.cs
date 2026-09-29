namespace ChangFu.Domain;

public enum TradingPlatform
{
    AShare,
    Futu,
    Longbridge
}

public enum OpenDConnectionState
{
    Disconnected,
    Connecting,
    Connected,
    SdkUnavailable,
    Failed
}

public sealed record AccountSummary(
    decimal TotalAssets,
    decimal Cash,
    decimal BuyingPower,
    string Currency);

public sealed record PositionSummary(
    string Id,
    string Symbol,
    string Name,
    decimal Quantity,
    decimal? CostPrice,
    decimal? LastPrice,
    decimal? TodayProfit,
    string Currency);

public interface IBrokerClient : IAsyncDisposable
{
    OpenDConnectionState ConnectionState { get; }
    Task ConnectAsync(CancellationToken cancellationToken);
    Task DisconnectAsync(CancellationToken cancellationToken);
    Task<AccountSummary> LoadAccountAsync(CancellationToken cancellationToken);
    Task<IReadOnlyList<PositionSummary>> LoadPositionsAsync(CancellationToken cancellationToken);
}
