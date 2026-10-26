using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Interop;
using Forms = System.Windows.Forms;
using Drawing = System.Drawing;

namespace Synapse;

/// <summary>
/// The application: one window, one tray icon, one server process.
///
/// The window is the UI and the tray is the app's presence. Closing the window
/// hides it; only "Exit Synapse" stops the server and quits, because stopping the
/// server is the destructive half and it should never be one slip of the mouse
/// away. See <c>docs/notes/desktop-app.md</c>.
/// </summary>
public partial class App : Application
{
    internal string Root { get; } = AppContext.BaseDirectory;
    internal ConsoleStore Console { get; private set; } = null!;
    internal ServerHost Server { get; private set; } = null!;

    MainWindow? _window;
    Forms.NotifyIcon? _tray;
    Forms.ContextMenuStrip? _menu;
    Mutex? _instance;
    uint _showMessage;
    bool _exiting;

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SetCurrentProcessExplicitAppUserModelID(string id);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint RegisterWindowMessage(string name);

    [DllImport("user32.dll")]
    private static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

    static readonly IntPtr HWND_BROADCAST = new(0xffff);

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        // One instance per install folder. A second copy would lose the port race and
        // show a boot panel with EADDRINUSE on it, which reads as a broken app rather
        // than as "it is already open".
        var key = InstallKey();
        _showMessage = RegisterWindowMessage($"Synapse.Show.{key}");
        _instance = new Mutex(true, $@"Local\Synapse.Single.{key}", out var first);
        if (!first)
        {
            // Ask the copy that is already running to come forward, then leave. A
            // broadcast of a registered message needs no pipe and no port: the first
            // instance has a message loop and this one has nothing else to do.
            PostMessage(HWND_BROADCAST, _showMessage, IntPtr.Zero, IntPtr.Zero);
            Shutdown();
            return;
        }

        // One identity for the window, the taskbar and the tray, so the app groups
        // as itself rather than as a generic host process.
        try { SetCurrentProcessExplicitAppUserModelID("Synapse.Harness"); } catch { /* cosmetic */ }

        Console = new ConsoleStore(Path.Combine(Root, "logs", "console.log"));
        Server = new ServerHost(Root, Console);
        BuildTray();

        _window = new MainWindow(Root, Server, Console);
        MainWindow = _window;
        _window.Closing += OnWindowClosing;
        _window.Show();
        HwndSource.FromHwnd(new WindowInteropHelper(_window).Handle)?.AddHook(OnShowRequest);
    }

    /// <summary>
    /// Stable for one install folder — and not <c>GetHashCode</c>, which is salted
    /// per process, so two launches would never agree on a name.
    /// </summary>
    string InstallKey()
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(Root.TrimEnd('\\').ToLowerInvariant()));
        return Convert.ToHexString(bytes, 0, 6);
    }

    /// <summary>The second launch's request: come to the front.</summary>
    IntPtr OnShowRequest(IntPtr hwnd, int message, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if ((uint)message != _showMessage) return IntPtr.Zero;
        Dispatcher.Invoke(() =>
        {
            ShowWindow();
            if (_window is { WindowState: WindowState.Minimized }) _window.WindowState = WindowState.Normal;
        });
        handled = true;
        return IntPtr.Zero;
    }

    // ── window ──────────────────────────────────────────────────────────

    /// <summary>Close is not quit: the server keeps running and the tray brings it back.</summary>
    void OnWindowClosing(object? sender, System.ComponentModel.CancelEventArgs e)
    {
        if (_exiting) return;
        e.Cancel = true;
        _window?.Hide();
        ShowHintOnce();
    }

    /// <summary>
    /// Say where the app went — once. A window that vanishes into the tray with no
    /// word looks like a crash, and a balloon on every close would be nagging.
    /// </summary>
    void ShowHintOnce()
    {
        var marker = Path.Combine(Root, "data", "tray-hint-shown");
        try
        {
            if (File.Exists(marker)) return;
            Directory.CreateDirectory(Path.GetDirectoryName(marker)!);
            File.WriteAllText(marker, DateTimeOffset.Now.ToString("o"));
        }
        catch
        {
            return;   // no marker, no balloon: never repeat it by accident
        }
        try
        {
            _tray?.ShowBalloonTip(5000, "Synapse is still running",
                "The server kept going. Right-click the tray icon to open the window again, or to exit.",
                Forms.ToolTipIcon.Info);
        }
        catch { /* balloons are best-effort */ }
    }

    internal void ShowWindow()
    {
        if (_window == null) return;
        _window.Show();
        if (_window.WindowState == WindowState.Minimized) _window.WindowState = WindowState.Normal;
        _window.Activate();
    }

    // ── tray ────────────────────────────────────────────────────────────

    void BuildTray()
    {
        _menu = new Forms.ContextMenuStrip { ShowImageMargin = false };
        _menu.Opening += (_, _) => RebuildMenu();

        _tray = new Forms.NotifyIcon
        {
            Icon = LoadIcon(),
            Text = "Synapse",
            Visible = true,
            ContextMenuStrip = _menu,
        };
        _tray.DoubleClick += (_, _) => ShowWindow();

        Server.Changed += (_, _) => { try { Dispatcher.Invoke(RebuildMenu); } catch { /* exiting */ } };
        RebuildMenu();
    }

    /// <summary>
    /// The menu is rebuilt every time it opens, so Start and Stop always describe
    /// the server as it is now rather than as it was when the app started.
    /// </summary>
    void RebuildMenu()
    {
        if (_menu == null || _tray == null) return;
        var running = Server.State is ServerState.Running or ServerState.Starting;
        var idle = !Server.IsBusy;

        _menu.Items.Clear();
        _menu.Items.Add(Item("Show Synapse", ShowWindow, true));
        _menu.Items.Add(new Forms.ToolStripSeparator());
        _menu.Items.Add(Item("Start Server", () => Server.Start(), idle && !running));
        _menu.Items.Add(Item("Stop Server…", () => _ = StopServerAsync(), idle && running));
        _menu.Items.Add(Item("Restart Server", () => _ = Server.RestartAsync(), idle && running));
        _menu.Items.Add(new Forms.ToolStripSeparator());
        _menu.Items.Add(Item("Open Logs Folder", OpenLogs, true));
        _menu.Items.Add(Item("Exit Synapse", () => _ = ExitAsync(), true));

        _tray.Text = Server.State switch
        {
            ServerState.Running => "Synapse — server running",
            ServerState.Starting => "Synapse — starting the server",
            ServerState.Stopping => "Synapse — stopping the server",
            ServerState.Failed => "Synapse — the server stopped",
            _ => "Synapse — server stopped",
        };
    }

    static Forms.ToolStripMenuItem Item(string text, Action action, bool enabled)
    {
        var item = new Forms.ToolStripMenuItem(text) { Enabled = enabled };
        item.Click += (_, _) => action();
        return item;
    }

    /// <summary>
    /// Stop Server, with a warning first.
    ///
    /// A turn in flight is lost and the engine is stopped with the server, so this
    /// is the one tray action that asks. The wording says what goes, not what
    /// happens internally.
    /// </summary>
    internal async Task StopServerAsync()
    {
        ShowWindow();
        var answer = System.Windows.MessageBox.Show(
            _window,
            "Stop the Synapse server?\n\n" +
            "Anything running now is stopped: a turn in progress is lost, and the engine is shut down with it. " +
            "The window stays open and Start Server brings it back.",
            "Stop Server",
            MessageBoxButton.OKCancel,
            MessageBoxImage.Warning,
            MessageBoxResult.Cancel);
        if (answer != MessageBoxResult.OK) return;
        await Server.StopAsync();
    }

    void OpenLogs()
    {
        try
        {
            var logs = Path.Combine(Root, "logs");
            Directory.CreateDirectory(logs);
            Process.Start(new ProcessStartInfo { FileName = logs, UseShellExecute = true });
        }
        catch (Exception err)
        {
            System.Windows.MessageBox.Show(_window, $"Could not open the logs folder: {err.Message}", "Synapse");
        }
    }

    // ── quit ────────────────────────────────────────────────────────────

    async Task ExitAsync()
    {
        if (_exiting) return;
        _exiting = true;
        try { if (_tray != null) _tray.Visible = false; } catch { /* exiting */ }
        try { await Server.StopAsync(); } catch { /* exiting */ }
        Server.Dispose();
        Console.Dispose();
        try { _tray?.Dispose(); } catch { /* exiting */ }
        try { _instance?.ReleaseMutex(); } catch { /* exiting */ }
        _instance?.Dispose();
        _instance = null;
        Shutdown();
    }

    protected override void OnSessionEnding(SessionEndingCancelEventArgs e)
    {
        // Shutting Windows down must not leave the engine behind.
        try { Server?.Dispose(); } catch { /* exiting */ }
        base.OnSessionEnding(e);
    }

    static Drawing.Icon LoadIcon()
    {
        try
        {
            var path = Path.Combine(AppContext.BaseDirectory, "web", "favicon.ico");
            if (File.Exists(path))
            {
                // Ask for the 16px entry by name: the tray draws at 16, and picking
                // the nearest size out of a multi-size file is how a mark ends up a
                // smudge.
                return new Drawing.Icon(path, new Drawing.Size(16, 16));
            }
        }
        catch { /* fall through */ }
        return Drawing.SystemIcons.Application;
    }
}
