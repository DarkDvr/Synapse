using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using Microsoft.Web.WebView2.Core;

namespace Shell;

public partial class MainWindow : Window
{
    public MainWindow()
    {
        InitializeComponent();
        Loaded += async (_, _) => await StartAsync();
    }

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    /// <summary>
    /// A dark title bar, so the frame and the page agree.
    ///
    /// Windows draws its own chrome; on Windows 10 that is a white bar even when
    /// everything inside is dark, which reads as "unfinished app" at a glance.
    /// Attribute 20 is the modern one, 19 the Windows 10 1809 name for the same
    /// thing; both are best-effort and a failure is silent on purpose. Windows 11
    /// follows the app's theme automatically once this is set.
    /// </summary>
    protected override void OnSourceInitialized(EventArgs e)
    {
        base.OnSourceInitialized(e);
        var handle = new WindowInteropHelper(this).Handle;
        var on = 1;
        DwmSetWindowAttribute(handle, 20, ref on, sizeof(int));
        DwmSetWindowAttribute(handle, 19, ref on, sizeof(int));
    }

    /// <summary>
    /// Load ui/ as a real https origin rather than a file path.
    ///
    /// `file://` is not a web page: localStorage is per-file and often blocked,
    /// ES modules and fetch behave differently, and a reload looks nothing like
    /// the same page on a server. Every problem the review tooling had with
    /// `file://` would come back here, one layer deeper, where nobody can see it.
    /// The mapping keeps the folder local — nothing leaves the machine — and gives
    /// the UI an origin of its own.
    /// </summary>
    private async System.Threading.Tasks.Task StartAsync()
    {
        var ui = Path.Combine(AppContext.BaseDirectory, "ui");
        if (!Directory.Exists(ui))
        {
            MessageBox.Show($"The interface folder is missing:\n{ui}", "App");
            Close();
            return;
        }

        try
        {
            await View.EnsureCoreWebView2Async();
            var core = View.CoreWebView2;
            core.Settings.AreDevToolsEnabled = true;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = true;
            core.SetVirtualHostNameToFolderMapping("app.local", ui, CoreWebView2HostResourceAccessKind.Allow);
            core.Navigate("https://app.local/index.html");
        }
        catch (Exception err)
        {
            // WebView2 missing is the one failure worth naming: it is a runtime the
            // target machine must have, and a stack trace would hide that.
            MessageBox.Show(
                "The WebView2 runtime is not installed on this machine.\n\n" +
                "Install it from https://developer.microsoft.com/microsoft-edge/webview2/ and start the app again.\n\n" +
                err.Message,
                "App");
            Close();
        }
    }
}
