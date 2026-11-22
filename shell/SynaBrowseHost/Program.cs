using System.IO;
using System.Text.Json;
using System.Windows;

namespace Synapse.BrowserHost;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        var options = HostOptions.Parse(args);
        var app = new Application { ShutdownMode = ShutdownMode.OnMainWindowClose };
        var window = new HostWindow(options);
        app.MainWindow = window;
        window.Show();
        app.Run();
    }
}

public sealed class HostOptions
{
    public string Url { get; private init; } = "about:blank";
    public string Profile { get; private init; } = "profile";
    public string DownloadDir { get; private init; } = "downloads";
    public string StateFile { get; private init; } = "host-state.json";
    public string DownloadsFile { get; private init; } = "downloads.jsonl";
    public string Title { get; private init; } = "SynaBrowse";
    public int Port { get; private init; }
    public int Width { get; private init; } = 1280;
    public int Height { get; private init; } = 800;
    public int ParentPid { get; private init; }
    public bool Visible { get; private init; }

    public static HostOptions Parse(string[] args)
    {
        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var flags = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (var i = 0; i < args.Length; i++)
        {
            var arg = args[i];
            if (!arg.StartsWith("--", StringComparison.Ordinal)) continue;
            var key = arg[2..];
            if (i + 1 < args.Length && !args[i + 1].StartsWith("--", StringComparison.Ordinal)) map[key] = args[++i];
            else flags.Add(key);
        }
        return new HostOptions
        {
            Url = map.GetValueOrDefault("url", "about:blank"),
            Profile = map.GetValueOrDefault("profile", "profile"),
            DownloadDir = map.GetValueOrDefault("download-dir", "downloads"),
            StateFile = map.GetValueOrDefault("state", "host-state.json"),
            DownloadsFile = map.GetValueOrDefault("downloads", "downloads.jsonl"),
            Title = map.GetValueOrDefault("title", "SynaBrowse"),
            Port = int.TryParse(map.GetValueOrDefault("port", "0"), out var port) ? port : 0,
            Width = int.TryParse(map.GetValueOrDefault("width", "1280"), out var width) ? width : 1280,
            Height = int.TryParse(map.GetValueOrDefault("height", "800"), out var height) ? height : 800,
            ParentPid = int.TryParse(map.GetValueOrDefault("parent-pid", "0"), out var pid) ? pid : 0,
            Visible = flags.Contains("visible"),
        };
    }

    public string ToJson(int pid, int port, long hwnd) => JsonSerializer.Serialize(new
    {
        state = "ready",
        pid,
        port,
        hwnd,
        profile = Path.GetFullPath(Profile),
        downloadDir = Path.GetFullPath(DownloadDir),
        downloadsFile = Path.GetFullPath(DownloadsFile),
        url = Url,
        visible = Visible,
        startedAt = DateTime.UtcNow.ToString("O"),
    });
}
