using System.Windows;
using ChangFu.Domain;
using ChangFu.FutuAdapter;

namespace ChangFu.App;

public partial class MainWindow : Window
{
    private readonly IBrokerClient _broker = new FutuBrokerClient();

    public MainWindow()
    {
        InitializeComponent();
        Loaded += ConnectBrokerAsync;
        Closed += DisposeBrokerAsync;
    }

    private async void ConnectBrokerAsync(object sender, RoutedEventArgs eventArgs)
    {
        await _broker.ConnectAsync(CancellationToken.None);
    }

    private async void DisposeBrokerAsync(object? sender, EventArgs eventArgs)
    {
        await _broker.DisposeAsync();
    }
}
