using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;

namespace Synapse.BrowserHost;

public partial class HostWindow : Window
{
    private readonly HostOptions _options;
    private readonly string _stateFile;
    private readonly string _downloadsFile;
    private readonly HashSet<string> _warming = new();
    private readonly DispatcherTimer _parentTimer;
    private CoreWebView2Environment? _environment;
    private int _port;
    private DateTime _lastProgress = DateTime.MinValue;
    private string _lastExternal = string.Empty;
    private DateTime _lastExternalAt = DateTime.MinValue;

    public HostWindow(HostOptions options)
    {
        InitializeComponent();
        _options = options;
        _stateFile = Path.GetFullPath(options.StateFile);
        _downloadsFile = Path.GetFullPath(options.DownloadsFile);

        Title = options.Title;
        Width = options.Width;
        Height = options.Height;
        if (options.Visible)
        {
            WindowStyle = WindowStyle.SingleBorderWindow;
            ShowInTaskbar = true;
            WindowStartupLocation = WindowStartupLocation.CenterScreen;
        }
        else
        {
            WindowStyle = WindowStyle.None;
            ShowInTaskbar = false;
            WindowStartupLocation = WindowStartupLocation.Manual;
            Left = -32000;
            Top = -32000;
        }

        _parentTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(2) };
        _parentTimer.Tick += (_, _) => CheckParent();
        Loaded += OnLoaded;
        Closed += OnClosed;
    }

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_stateFile)!);
            Directory.CreateDirectory(Path.GetDirectoryName(_downloadsFile)!);
            File.WriteAllText(_downloadsFile, "", new UTF8Encoding(false));

            _port = _options.Port > 0 ? _options.Port : FreePort();
            var args = string.Join(' ', new[]
            {
                $"--remote-debugging-port={_port}",
                "--remote-allow-origins=*",
                "--disable-blink-features=AutomationControlled",
                "--disable-background-timer-throttling",
                "--disable-backgrounding-occluded-windows",
                "--disable-renderer-backgrounding",
                "--disable-features=CalculateNativeWinOcclusion",
                "--no-first-run",
                "--no-default-browser-check",
            });
            var environmentOptions = new CoreWebView2EnvironmentOptions { AdditionalBrowserArguments = args };
            _environment = await CoreWebView2Environment.CreateAsync(null, Path.GetFullPath(_options.Profile), environmentOptions);
            await View.EnsureCoreWebView2Async(_environment);
            var core = View.CoreWebView2;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            try { core.Profile.DefaultDownloadFolderPath = Path.GetFullPath(_options.DownloadDir); } catch { /* older runtime */ }
            core.DownloadStarting += OnDownloadStarting;
            core.NewWindowRequested += (_, e) =>
            {
                e.Handled = true;
                if (TryExternal(e.Uri)) return;
                core.Navigate(e.Uri);
            };
            // A custom protocol is not a page. Nexus's Slow Download redirects to
            // nxm://, which ModOrganizer2 registers; WebView2 would otherwise swallow
            // it or open a blank window. Hand only nxm to the OS, and only once per
            // redirect: the same URI can arrive through more than one of these events.
            core.NavigationStarting += (_, e) =>
            {
                if (TryExternal(e.Uri)) e.Cancel = true;
            };
            core.LaunchingExternalUriScheme += (_, e) =>
            {
                if (TryExternal(e.Uri)) e.Cancel = true;
            };
            core.NavigationCompleted += (_, e) => Log(new { @event = "navigation", success = e.IsSuccess, status = e.HttpStatusCode, url = core.Source });
            core.ProcessFailed += (_, e) => Log(new { @event = "process-failed", reason = e.ProcessFailedKind.ToString() });

            await WarmUpDownloadAsync(core);

            WriteState(_options.ToJson(Environment.ProcessId, _port, new WindowInteropHelper(this).Handle.ToInt64()));
            Console.WriteLine($"READY {_port}");
            Log(new { @event = "ready", pid = Environment.ProcessId, port = _port, runtime = _environment.BrowserVersionString, userAgent = core.Settings.UserAgent, visible = _options.Visible });

            if (_options.ParentPid > 0) _parentTimer.Start();
            if (!string.IsNullOrWhiteSpace(_options.Url) && !_options.Url.Equals("about:blank", StringComparison.OrdinalIgnoreCase)) core.Navigate(_options.Url);
        }
        catch (Exception ex)
        {
            Log(new { @event = "error", message = ex.ToString() });
            WriteState(JsonSerializer.Serialize(new { state = "error", error = ex.Message }));
            Application.Current.Shutdown(1);
        }
    }

    /**
     * The first download after a WebView2 environment starts fails with FileFailed; the
     * second succeeds (measured 22 Nov). A tiny data-URL download absorbs that failure.
     */
    private async Task WarmUpDownloadAsync(CoreWebView2 core)
    {
        try
        {
            Directory.CreateDirectory(Path.GetFullPath(_options.DownloadDir));
            core.NavigateToString("<!doctype html><title>warmup</title><body></body>");
            await Task.Delay(250);
            await core.ExecuteScriptAsync(
                "(() => { const a = document.createElement('a'); a.href = 'data:text/plain,synabrowse-warmup'; " +
                "a.download = '.synabrowse-warmup'; document.body.appendChild(a); a.click(); a.remove(); })()");
            await Task.Delay(700);
        }
        catch (Exception ex)
        {
            Log(new { @event = "warmup-error", message = ex.Message });
        }
    }

    /// <summary>
    /// Hand an nxm:// link to the program Windows has registered for it.
    ///
    /// This is the Nexus "Slow Download" route: the page redirects to nxm://, and
    /// ModOrganizer2 catches it. WebView2 does not run custom protocols, and its
    /// NewWindowRequested handler used to navigate the same window instead — a blank
    /// page and no download. Only nxm is handed out; every other scheme stays inside
    /// the browser, so a page cannot launch an arbitrary local program.
    /// </summary>
    private bool TryExternal(string uri)
    {
        if (!Uri.TryCreate(uri, UriKind.Absolute, out var parsed)) return false;
        if (!string.Equals(parsed.Scheme, "nxm", StringComparison.OrdinalIgnoreCase)) return false;
        var now = DateTime.UtcNow;
        if (string.Equals(uri, _lastExternal, StringComparison.OrdinalIgnoreCase)
            && (now - _lastExternalAt).TotalSeconds < 2)
        {
            return true; // already launched; the other WebView2 event is the duplicate
        }
        _lastExternal = uri;
        _lastExternalAt = now;
        try
        {
            Process.Start(new ProcessStartInfo { FileName = uri, UseShellExecute = true });
            Log(new { @event = "external", scheme = "nxm", uri });
            return true;
        }
        catch (Exception ex)
        {
            Log(new { @event = "external-error", scheme = "nxm", uri, error = ex.Message });
            return false;
        }
    }

    private void OnDownloadStarting(object? sender, CoreWebView2DownloadStartingEventArgs e)
    {
        try
        {
            Directory.CreateDirectory(Path.GetFullPath(_options.DownloadDir));
            var suggested = Path.GetFileName(e.ResultFilePath);
            if (string.IsNullOrWhiteSpace(suggested)) suggested = "download";
            var warming = string.Equals(e.DownloadOperation.Uri, "data:text/plain,synabrowse-warmup", StringComparison.OrdinalIgnoreCase)
                || suggested.Contains("synabrowse-warmup", StringComparison.OrdinalIgnoreCase);
            if (warming)
            {
                var warmPath = Path.Combine(Path.GetTempPath(), $"synabrowse-warmup-{Guid.NewGuid():N}.txt");
                e.ResultFilePath = warmPath;
                e.Handled = true;
                _warming.Add(warmPath);
                e.DownloadOperation.StateChanged += (_, _) =>
                {
                    if (e.DownloadOperation.State is CoreWebView2DownloadState.Completed or CoreWebView2DownloadState.Interrupted)
                    {
                        try { File.Delete(warmPath); } catch { /* gone */ }
                        _warming.Remove(warmPath);
                    }
                };
                return;
            }

            var path = UniquePath(Path.Combine(Path.GetFullPath(_options.DownloadDir), SafeName(suggested)));
            e.ResultFilePath = path;
            e.Handled = true;
            var id = Guid.NewGuid().ToString("N");
            var startedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var total = (long)(e.DownloadOperation.TotalBytesToReceive ?? 0);
            var record = new DownloadRecord
            {
                id = id,
                name = Path.GetFileName(path),
                path = path,
                total = total,
                startedAt = startedAt,
            };
            WriteDownload(new { @event = "starting", id, name = record.name, path, received = 0L, total, state = "starting", startedAt });
            Log(new { @event = "download-starting", path, uri = e.DownloadOperation.Uri });

            var operation = e.DownloadOperation;
            operation.BytesReceivedChanged += (_, _) =>
            {
                record.received = operation.BytesReceived;
                record.total = (long)(operation.TotalBytesToReceive ?? 0);
                if ((DateTime.UtcNow - _lastProgress).TotalMilliseconds >= 200)
                {
                    _lastProgress = DateTime.UtcNow;
                    WriteDownload(new { @event = "progress", id, received = record.received, total = record.total, state = "inProgress" });
                }
            };
            operation.StateChanged += (_, _) =>
            {
                record.received = operation.BytesReceived;
                record.total = (long)(operation.TotalBytesToReceive ?? 0);
                if (operation.State == CoreWebView2DownloadState.Completed)
                {
                    long bytes = 0;
                    try { bytes = new FileInfo(path).Length; } catch { /* the state says it is there */ }
                    var endedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                    WriteDownload(new { @event = "completed", id, name = record.name, path, received = bytes, total = bytes, state = "completed", startedAt, endedAt });
                    Log(new { @event = "download-complete", path, bytes });
                }
                else if (operation.State == CoreWebView2DownloadState.Interrupted)
                {
                    var endedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                    WriteDownload(new { @event = "interrupted", id, name = record.name, path, error = operation.InterruptReason.ToString(), state = "interrupted", startedAt, endedAt });
                    Log(new { @event = "download-failed", path, reason = operation.InterruptReason.ToString() });
                }
            };
        }
        catch (Exception ex)
        {
            Log(new { @event = "download-error", message = ex.Message });
        }
    }

    private void CheckParent()
    {
        if (_options.ParentPid <= 0) return;
        try
        {
            using var parent = Process.GetProcessById(_options.ParentPid);
            if (!parent.HasExited) return;
        }
        catch (ArgumentException) { /* gone */ }
        catch { return; }
        _parentTimer.Stop();
        Close();
    }

    private void OnClosed(object? sender, EventArgs e)
    {
        _parentTimer.Stop();
        try
        {
            WriteState(JsonSerializer.Serialize(new
            {
                state = "exited",
                pid = Environment.ProcessId,
                port = _port,
                exitedAt = DateTime.UtcNow.ToString("O"),
            }));
        }
        catch { /* the state is a courtesy */ }
        try { View.Dispose(); } catch { /* the runtime is already gone */ }
        Application.Current.Shutdown();
    }

    private void WriteState(string json)
    {
        try
        {
            var dir = Path.GetDirectoryName(_stateFile);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            File.WriteAllText(_stateFile, json, new UTF8Encoding(false));
        }
        catch { /* the state is a courtesy */ }
    }

    private void WriteDownload(object payload)
    {
        try
        {
            var line = JsonSerializer.Serialize(payload);
            File.AppendAllText(_downloadsFile, line + Environment.NewLine, new UTF8Encoding(false));
        }
        catch { /* a failed report must not stop the browser */ }
    }

    private void Log(object payload)
    {
        try { Console.WriteLine(JsonSerializer.Serialize(payload)); } catch { /* stdout closed */ }
    }

    private static string SafeName(string name)
    {
        var cleaned = string.Join(' ', name.Split(Path.GetInvalidFileNameChars(), StringSplitOptions.RemoveEmptyEntries)).Trim();
        if (string.IsNullOrWhiteSpace(cleaned) || cleaned is "." or "..") cleaned = "download";
        if (cleaned.Length > 120)
        {
            var ext = Path.GetExtension(cleaned);
            cleaned = cleaned[..Math.Max(1, 120 - ext.Length)] + ext;
        }
        return cleaned.Trim();
    }

    private static string UniquePath(string path)
    {
        if (!File.Exists(path)) return path;
        var dir = Path.GetDirectoryName(path) ?? ".";
        var name = Path.GetFileNameWithoutExtension(path);
        var ext = Path.GetExtension(path);
        for (var i = 1; i < 1000; i++)
        {
            var candidate = Path.Combine(dir, $"{name} ({i}){ext}");
            if (!File.Exists(candidate)) return candidate;
        }
        return path;
    }

    private static int FreePort()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }

    private sealed class DownloadRecord
    {
        public string id = "";
        public string name = "";
        public string path = "";
        public long total;
        public long received;
        public long startedAt;
    }
}
