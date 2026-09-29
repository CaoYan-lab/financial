using ChangFu.Domain;

namespace ChangFu.FutuAdapter;

public sealed class FutuBrokerClient : IBrokerClient
{
    public OpenDConnectionState ConnectionState { get; private set; } =
        OpenDConnectionState.Disconnected;

    public Task ConnectAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();

        // 第二阶段接入官方 Futu C# SDK。SDK 未链接时必须 fail closed，
        // 不允许使用随机数或固定样例模拟真实账户状态。
        ConnectionState = OpenDConnectionState.SdkUnavailable;
        return Task.CompletedTask;
    }

    public Task DisconnectAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ConnectionState = OpenDConnectionState.Disconnected;
        return Task.CompletedTask;
    }

    public Task<AccountSummary> LoadAccountAsync(CancellationToken cancellationToken) =>
        Task.FromException<AccountSummary>(
            new InvalidOperationException("Futu C# SDK 尚未配置"));

    public Task<IReadOnlyList<PositionSummary>> LoadPositionsAsync(
        CancellationToken cancellationToken) =>
        Task.FromException<IReadOnlyList<PositionSummary>>(
            new InvalidOperationException("Futu C# SDK 尚未配置"));

    public ValueTask DisposeAsync()
    {
        ConnectionState = OpenDConnectionState.Disconnected;
        return ValueTask.CompletedTask;
    }
}
