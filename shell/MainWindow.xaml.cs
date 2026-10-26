using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media.Imaging;
using Microsoft.Web.WebView2.Core;

namespace Synapse;

/// <summary>
/// The window: the page, and the handle the page uses to ask the shell questions
/// the server cannot answer — the console tail above all, because it has to work
/// when the server is stopped.
///
/// Two documents live here. <c>offline.html</c> is what is shown while the server
/// starts, while it is stopped, and when it failed; the app itself is served by the
/// server. Every page opens with a `ready` message and is answered with the current
/// state and the tail so far, so neither has to guess when it is safe to ask.
/// </summary>
public partial class MainWindow : Window
{
    const string OfflineUrl = "https://synapse.shell/offline.html";

    readonly ServerHost _server;
    readonly ConsoleStore _console;
    readonly string _statePath;
    string _at = string.Empty;          // the URL we last asked for
    string _reason = string.Empty;      // why the server is in the state it is
    bool _needsReload;                  // the page was fetched from a server that has since stopped

    internal MainWindow(string root, ServerHost server, ConsoleStore console)
    {
        InitializeComponent();
        _server = server;
        _console = console;
        _statePath = Path.Combine(root, "data", "window.json");
        RestoreWindowState();
        try
        {
            var mark = Path.Combine(root, "web", "icon-64.png");
            if (File.Exists(mark)) BarMark.Source = new BitmapImage(new Uri(mark));
        }
        catch
        {
            // A bar without its mark is still a bar.
        }
        Loaded += async (_, _) => await BootAsync(root);
        Closed += (_, _) => _server.Changed -= OnServerChanged;
        // Saved before the close is cancelled: hiding to the tray is a close.
        Closing += (_, _) => SaveWindowState();
    }

    // ── remembered geometry ─────────────────────────────────────────────

    /// <summary>
    /// Where the window was, in a file under data\ so the folder carries it.
    ///
    /// The check that matters is not "is it on screen" but "can it be grabbed":
    /// there is no frame, so the only thing to drag is the 36px title bar, and a
    /// saved position that leaves that strip off the desktop is a window nobody can
    /// move back.
    /// </summary>
    void RestoreWindowState()
    {
        try
        {
            if (!File.Exists(_statePath)) return;
            using var doc = JsonDocument.Parse(File.ReadAllText(_statePath));
            var root = doc.RootElement;
            double Read(string name, double fallback)
                => root.TryGetProperty(name, out var v) && v.TryGetDouble(out var n) ? n : fallback;

            var width = Read("width", Width);
            var height = Read("height", Height);
            if (width >= MinWidth && height >= MinHeight) { Width = width; Height = height; }

            var x = Read("x", double.NaN);
            var y = Read("y", double.NaN);
            if (!double.IsNaN(x) && !double.IsNaN(y) && Grabbable(x, y))
            {
                // Manual, or CenterScreen in the XAML would move it straight back.
                WindowStartupLocation = WindowStartupLocation.Manual;
                Left = x;
                Top = y;
            }

            if (root.TryGetProperty("maximized", out var m) && m.ValueKind == JsonValueKind.True)
                WindowState = WindowState.Maximized;
        }
        catch
        {
            // No file is the first run; a half-written one is not worth a dialog.
            // The defaults in the XAML are always a correct answer.
        }
    }

    static bool Grabbable(double x, double y)
    {
        // Virtual screen in DIPs, so this holds at any scaling and across monitors
        // with different ones.
        var left = SystemParameters.VirtualScreenLeft;
        var top = SystemParameters.VirtualScreenTop;
        var right = left + SystemParameters.VirtualScreenWidth;
        var bottom = top + SystemParameters.VirtualScreenHeight;
        return x + 120 > left && x < right && y >= top - 4 && y <= bottom - 36;
    }

    internal void SaveWindowState()
    {
        try
        {
            // RestoreBounds is the only place the normal size exists while maximised.
            var box = WindowState == WindowState.Normal ? new Rect(Left, Top, Width, Height) : RestoreBounds;
            if (box.Width < 1 || box.Height < 1) return;
            var json = JsonSerializer.Serialize(new
            {
                x = Math.Round(box.X),
                y = Math.Round(box.Y),
                width = Math.Round(box.Width),
                height = Math.Round(box.Height),
                maximized = WindowState == WindowState.Maximized,
            });
            Directory.CreateDirectory(Path.GetDirectoryName(_statePath)!);
            File.WriteAllText(_statePath, json);
        }
        catch
        {
            // Geometry is a convenience; it is never a reason to fail a close.
        }
    }

    // ── maximising a frameless window ───────────────────────────────────

    const int WM_GETMINMAXINFO = 0x0024;
    const uint MONITOR_DEFAULTTONEAREST = 2;

    [StructLayout(LayoutKind.Sequential)]
    struct NativePoint { public int x, y; }

    [StructLayout(LayoutKind.Sequential)]
    struct NativeRect { public int left, top, right, bottom; }

    [StructLayout(LayoutKind.Sequential)]
    struct NativeMinMaxInfo
    {
        public NativePoint reserved, maxSize, maxPosition, minTrackSize, maxTrackSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct NativeMonitorInfo
    {
        public int size;
        public NativeRect monitor, work;
        public uint flags;
    }

    [DllImport("user32.dll")]
    static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);

    [DllImport("user32.dll")]
    static extern bool GetMonitorInfo(IntPtr monitor, ref NativeMonitorInfo info);

    protected override void OnSourceInitialized(EventArgs e)
    {
        base.OnSourceInitialized(e);
        HwndSource.FromHwnd(new WindowInteropHelper(this).Handle)?.AddHook(WindowProc);
    }

    /// <summary>
    /// A frameless window maximises to the whole screen *plus* its resize border —
    /// measured here as 2574x1454 at (-7,-7) on a 2560x1440 screen — which puts
    /// the taskbar under the window. This answers with the monitor's work area
    /// instead, in physical pixels, so it is right at any scaling.
    /// </summary>
    IntPtr WindowProc(IntPtr hwnd, int message, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (message != WM_GETMINMAXINFO) return IntPtr.Zero;

        var monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        if (monitor == IntPtr.Zero) return IntPtr.Zero;
        var info = new NativeMonitorInfo { size = Marshal.SizeOf<NativeMonitorInfo>() };
        if (!GetMonitorInfo(monitor, ref info)) return IntPtr.Zero;

        var mmi = Marshal.PtrToStructure<NativeMinMaxInfo>(lParam);
        var work = info.work;
        mmi.maxPosition.x = work.left - info.monitor.left;
        mmi.maxPosition.y = work.top - info.monitor.top;
        mmi.maxSize.x = work.right - work.left;
        mmi.maxSize.y = work.bottom - work.top;
        mmi.maxTrackSize = mmi.maxSize;
        Marshal.StructureToPtr(mmi, lParam, true);
        handled = true;
        return IntPtr.Zero;
    }

    async Task BootAsync(string root)
    {
        var web = Path.Combine(root, "web");
        if (!Directory.Exists(web))
        {
            Fatal($"The interface folder is missing:\n{web}");
            return;
        }

        try
        {
            // The browser's profile goes under data\ like every other piece of
            // runtime state. Left alone WebView2 creates `<exe>.WebView2` beside the
            // executable, which would put a folder of Edge internals at the root and
            // make "one file" untrue.
            var profile = Path.Combine(root, "data", "webview2");
            Directory.CreateDirectory(profile);
            var environment = await CoreWebView2Environment.CreateAsync(null, profile);
            await View.EnsureCoreWebView2Async(environment);
        }
        catch (Exception err)
        {
            // WebView2 missing is the one failure worth naming: it is a runtime the
            // target machine must have, and a stack trace would hide that.
            Fatal("Synapse draws its interface with the WebView2 runtime, which is not installed on this machine.\n\n" +
                  "Windows 11 has it. On Windows 10 it arrives with Microsoft Edge; if neither is present, " +
                  "install the Evergreen WebView2 runtime from Microsoft.\n\n" + err.Message);
            return;
        }

        var core = View.CoreWebView2;
        core.Settings.AreDevToolsEnabled = true;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.AreDefaultContextMenusEnabled = true;
        // The page is a page, not a file: modules, fetch and storage behave the
        // way the app expects, and nothing leaves the machine.
        core.SetVirtualHostNameToFolderMapping("synapse.shell", web, CoreWebView2HostResourceAccessKind.Allow);
        core.WebMessageReceived += OnWebMessage;
        core.NavigationCompleted += OnNavigationCompleted;

        // The WebView's own windows exist by now, and Chromium may create more on a
        // navigation, so this is also run again from OnNavigationCompleted and from
        // the page's `ready` message.

        _server.Changed += OnServerChanged;

        View.CoreWebView2.Navigate(OfflineUrl);
        _at = OfflineUrl;
        _server.Start();
    }

    void Fatal(string message)
    {
        System.Windows.MessageBox.Show(this, message, "Synapse", MessageBoxButton.OK, MessageBoxImage.Warning);
        Application.Current.Shutdown();
    }

    // ── server state ────────────────────────────────────────────────────

    void OnServerChanged(ServerState state, string reason)
    {
        // Raised from the child's exit thread or its stdout pump.
        Dispatcher.Invoke(() =>
        {
            var onApp = string.Equals(_at, _server.Url, StringComparison.OrdinalIgnoreCase);

            if (state == ServerState.Running)
            {
                if (!onApp) Go(_server.Url, "the server is up");
                else if (_needsReload)
                {
                    // Back from a stop: everything on the page was fetched from a
                    // server that no longer exists.
                    _needsReload = false;
                    _console.Append($"[app] reloading {_server.Url}{Environment.NewLine}");
                    View.CoreWebView2?.Reload();
                }
            }
            else if (onApp && state is ServerState.Stopped or ServerState.Failed)
            {
                // The page stays. The Runtime row goes red and the console is one
                // click away; swapping to the boot panel would take the operator's
                // screen away at the moment they most want to read it.
                _needsReload = true;
            }
            PostState(reason);
        });
    }

    /// <summary>
    /// Navigate, remembering what we asked for.
    ///
    /// The comparison is against our own intent, not <c>View.Source</c>: the
    /// source lags a navigation and reports the previous document, which is how a
    /// "go back to the panel" fallback can turn into a loop.
    /// </summary>
    void Go(string url, string because)
    {
        if (string.Equals(_at, url, StringComparison.OrdinalIgnoreCase)) return;
        _at = url;
        _console.Append($"[app] opening {url} — {because}{Environment.NewLine}");
        View.CoreWebView2?.Navigate(url);
    }

    void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        var url = View.Source?.ToString() ?? string.Empty;

        // A navigation abandoned because another one started is not a failure.
        // WebView2 reports it against the *previous* document — usually about:blank
        // — with ConnectionAborted, and treating that as an error bounced the
        // window straight back to the panel every time the server came up.
        if (e.WebErrorStatus == CoreWebView2WebErrorStatus.ConnectionAborted) return;
        if (url.StartsWith("about:", StringComparison.OrdinalIgnoreCase)) return;

        if (e.IsSuccess)
        {
            _console.Append($"[app] loaded {url}{Environment.NewLine}");
            return;
        }

        _console.Append($"[app] could not load {url} ({e.WebErrorStatus}){Environment.NewLine}");
        // A page that failed to load cannot ask for anything, and the panel is the
        // only document guaranteed to be on disk — but only when it is not the one
        // that just failed, or the fallback would loop.
        if (!string.Equals(_at, OfflineUrl, StringComparison.OrdinalIgnoreCase)) Go(OfflineUrl, "the last page did not load");
    }

    // ── the window's own controls ───────────────────────────────────────

    /// <summary>
    /// Close is the window's Close, so it takes the same route as the frame's used
    /// to: hidden to the tray, server still running. Stopping the server is a
    /// deliberate act in the tray menu or the console, never a stray click here.
    /// </summary>
    void OnClose(object sender, RoutedEventArgs e) => Close();

    void OnMinimize(object sender, RoutedEventArgs e) => WindowState = WindowState.Minimized;

    /// <summary>
    /// Maximise and restore share the button; only the glyph changes. The caption
    /// itself is WindowChrome's, so double-clicking the bar does this natively.
    /// </summary>
    void OnMaximize(object sender, RoutedEventArgs e)
        => WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;

    protected override void OnStateChanged(EventArgs e)
    {
        base.OnStateChanged(e);
        // E922 is the maximise mark, E923 the restore mark.
        MaxButton.Content = WindowState == WindowState.Maximized ? "\uE923" : "\uE922";
        MaxButton.ToolTip = WindowState == WindowState.Maximized ? "Restore" : "Maximize";
        SaveWindowState();
    }

    // ── messages ────────────────────────────────────────────────────────

    void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            using var doc = JsonDocument.Parse(e.WebMessageAsJson);
            var root = doc.RootElement;
            var kind = root.TryGetProperty("kind", out var k) ? k.GetString() : null;

            if (string.Equals(kind, "ready", StringComparison.Ordinal))
            {
                // The page has just loaded and knows nothing. The reason has to
                // survive the navigation it caused, or a failure reported as the
                // server died is blank by the time the panel can show it. The tail
                // is not sent here: the console asks for it when it opens.
                PostState(_reason);
                return;
            }
            if (string.Equals(kind, "server", StringComparison.Ordinal))
            {
                // The console's three buttons, which are the tray menu's three
                // actions. The shell is the only thing that starts or stops the
                // server, so these are requests to it, not commands to the API.
                var act = root.TryGetProperty("action", out var a) ? a.GetString() : null;
                _ = RunServerActionAsync(act);
                return;
            }
            if (string.Equals(kind, "console", StringComparison.Ordinal))
            {
                var offset = root.TryGetProperty("offset", out var o) && o.TryGetInt64(out var n) ? n : 0;
                SendTail(offset);
            }
        }
        catch
        {
            // A message we do not understand is not a failure; the page is ours but
            // a stale one may still be loaded.
        }
    }

    async Task RunServerActionAsync(string? action)
    {
        switch (action)
        {
            case "start":
                _server.Start();
                break;
            case "restart":
                await _server.RestartAsync();
                break;
            case "stop":
                // The tray and the console ask the same question in the same place,
                // so they cannot drift into two different warnings.
                if (Application.Current is App app) await app.StopServerAsync();
                break;
        }
    }

    void PostState(string reason)
    {
        _reason = reason ?? string.Empty;
        // The bar carries it too: this strip does not depend on the page below it,
        // which is exactly the state it is describing.
        var down = _server.State is ServerState.Stopped or ServerState.Failed;
        BarAlert.Visibility = down ? Visibility.Visible : Visibility.Collapsed;
        BarAlertText.Text = _server.State == ServerState.Failed ? "Server failed" : "Server stopped";
        Post(new
        {
            kind = "server",
            state = _server.State.ToString().ToLowerInvariant(),
            reason = _reason,
            url = _server.Url,
        });
    }

    void SendTail(long offset)
    {
        var (text, end, dropped) = _console.Tail(offset);
        Post(new { kind = "console", text, offset = end, dropped });
    }

    void Post(object payload)
    {
        try { View.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(payload)); }
        catch { /* the document is navigating away */ }
    }
}
