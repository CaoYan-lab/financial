using ChangFu.Domain;
using ChangFu.FutuAdapter;

await using IBrokerClient broker = new FutuBrokerClient();
await broker.ConnectAsync(CancellationToken.None);
Console.WriteLine($"长富 BrokerHost：{broker.ConnectionState}");

// 第二阶段在此托管 Named Pipe RPC。所有券商 SDK 对象留在本进程，
// WPF 主进程只接收规范化 DTO。
