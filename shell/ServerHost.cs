using System;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Synapse;

public enum ServerState
{
    Stopped,
    Starting,
    Running,
    Stopping,
    Failed,
}

/// <summary>
/// The server process: started, watched and stopped, and never matched by name.
///
/// The shell holds a handle to its child; that handle is the only thing allowed to
/// stop it. The engine is the child's own child, so the fallback kill takes the
/// whole tree — the handle-safe version of `taskkill /T`, and the reason nothing
/// here needs a process name or a pid file.
///
/// Exit codes are the contract with the server (see <c>src/index.js</c>):
///
///   2          "restart me"      -> start a new one
///   0          stopped on purpose -> stay stopped
///   anything   it died           -> report, and do NOT respawn in a loop
/// </summary>
public sealed class ServerHost : IDisposable
{
    public const int ExitRestart = 2;

    readonly string _root;
    readonly ConsoleStore _console;
    readonly object _gate = new();
    Process? _child;
    bool _stopping;

    public ServerHost(string root, ConsoleStore console)
    {
        _root = root;
        _console = console;
        Url = ConfiguredUrl(root);
    }

    /// <summary>(state, plain-English reason). May be raised off the UI thread.</summary>
    public event Action<ServerState, string>? Changed;

    public ServerState State { get; private set; } = ServerState.Stopped;

    /// <summary>Where the UI will be served once the server is up.</summary>
    public string Url { get; private set; }

    /// <summary>Which node was used, for the tray tooltip and the console.</summary>
    public string Runtime { get; private set; } = string.Empty;

    public bool IsBusy => State is ServerState.Starting or ServerState.Stopping;

    // ── what a previous run left behind ─────────────────────────────────

    /// <summary>
    /// Stop the server and the engine a crashed run left running.
    ///
    /// Measured: killing the app from Task Manager left the server, the engine and four
    /// MCP children holding both ports, so the next launch showed a boot panel the operator
    /// reads as a broken app. Both pids are written by Synapse itself; a pid is only acted
    /// on when the process still carrying it is *provably ours*, which is the executable
    /// living inside this folder. A recycled pid belongs to somebody else and is left alone.
    /// </summary>
    void StopLeftovers()
    {
        // The server first: its tree holds the engine, and the engine holds the MCP
        // children, so one kill takes the lot.
        KillIfOurs(Path.Combine(_root, "data", "synapse.pid"), "server");
        KillIfOurs(Path.Combine(_root, "data", "engine.pid"), "engine");
    }

    void KillIfOurs(string pidFile, string what)
    {
        int pid;
        try
        {
            if (!File.Exists(pidFile)) return;
            if (!int.TryParse(File.ReadAllText(pidFile).Trim(), out pid) || pid <= 0) return;
        }
        catch { return; }

        Process proc;
        try { proc = Process.GetProcessById(pid); }
        catch { return; }              // already gone, which is the common case and not news

        try
        {
            using (proc)
            {
                if (proc.HasExited) return;

                string path;
                try { path = proc.MainModule?.FileName ?? string.Empty; }
                catch { return; }      // not ours to inspect: another user, another session
                if (!IsOurs(path)) return;

                _console.Append($"[app] stopping a {what} left by a previous run (pid {pid}){Environment.NewLine}");
                proc.Kill(entireProcessTree: true);
                proc.WaitForExit(5000);
            }
        }
        catch (Exception err)
        {
            _console.Append($"[app] could not stop the {what} left by a previous run ({err.Message}){Environment.NewLine}");
        }
    }

    /// <summary>
    /// Provably ours: inside this folder, and never the operator's OpenCode desktop app,
    /// whose install path contains `@opencode` and once cost several rounds of blame.
    /// </summary>
    bool IsOurs(string path)
    {
        if (string.IsNullOrWhiteSpace(path)) return false;
        string full;
        try { full = Path.GetFullPath(path); }
        catch { return false; }
        if (!full.StartsWith(_root, StringComparison.OrdinalIgnoreCase)) return false;
        return !full.Contains("@opencodedesktop", StringComparison.OrdinalIgnoreCase)
            && !full.Contains("ai.opencode.desktop", StringComparison.OrdinalIgnoreCase);
    }

    public void Start()
    {
        lock (_gate)
        {
            if (_child is { HasExited: false }) return;
        }
        _stopping = false;

        // Before anything is spawned: a crash leaves the last server, the engine and the
        // engine's MCP children alive, still holding 8700 and 8720. The next start then
        // fails with EADDRINUSE, which reads as "Synapse is broken".
        StopLeftovers();

        var entry = Path.Combine(_root, "src", "index.js");
        if (!File.Exists(entry))
        {
            Set(ServerState.Failed, $"The server is missing: {entry}");
            return;
        }

        // The runtime that travels with the app first, always: that is what makes a
        // copied folder work on a machine with nothing installed. A machine node is
        // a fallback for a dev checkout, and the console says which one ran so the
        // difference is never a mystery.
        var node = Path.Combine(_root, "bin", "node", "node.exe");
        var viaPath = false;
        if (!File.Exists(node))
        {
            node = "node";
            viaPath = true;
        }
        Runtime = viaPath ? "node (this machine's PATH)" : node;

        var psi = new ProcessStartInfo
        {
            FileName = node,
            Arguments = "src\\index.js",
            WorkingDirectory = _root,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            // Redirected *and closed below*: the server asks a question on stdin
            // when it cannot find npm, and an inherited console would let it block
            // forever on a window nobody can see.
            RedirectStandardInput = true,
            StandardOutputEncoding = new UTF8Encoding(false),
            StandardErrorEncoding = new UTF8Encoding(false),
        };
        psi.Environment["SYNAPSE_SUPERVISED"] = "1";

        var child = new Process { StartInfo = psi, EnableRaisingEvents = true };
        child.OutputDataReceived += (_, e) => { if (e.Data != null) OnLine(e.Data); };
        child.ErrorDataReceived += (_, e) => { if (e.Data != null) OnLine(e.Data); };
        child.Exited += (_, _) => OnExited(child);

        try
        {
            child.Start();
        }
        catch (Exception err)
        {
            child.Dispose();
            Set(ServerState.Failed, $"Could not start {node}: {err.Message}");
            return;
        }

        child.StandardInput.Close();
        child.BeginOutputReadLine();
        child.BeginErrorReadLine();

        lock (_gate) _child = child;
        _console.Append($"[app] starting the server with {Runtime}{Environment.NewLine}");
        Set(ServerState.Starting);
    }

    /// <summary>
    /// Ask the server to stop, then make sure it did.
    ///
    /// Graceful first, because a kill would leave the engine — the server's own
    /// child — orphaned. Eight seconds is long for a graceful stop and short enough
    /// that a hung child does not look like a hung app.
    /// </summary>
    public async Task<bool> StopAsync()
    {
        Process? child;
        lock (_gate) child = _child;
        if (child == null || SafeHasExited(child))
        {
            Set(ServerState.Stopped);
            return true;
        }

        _stopping = true;
        Set(ServerState.Stopping);
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
            using var body = new StringContent(string.Empty, Encoding.UTF8, "application/json");
            await http.PostAsync($"{Url}/api/shutdown", body);
        }
        catch
        {
            // The fallback below is the point of trying this first.
        }

        using (var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(8)))
        {
            try
            {
                await child.WaitForExitAsync(timeout.Token);
                return true;
            }
            catch (OperationCanceledException)
            {
                // Fall through to the tree kill.
            }
        }

        try { child.Kill(entireProcessTree: true); } catch { /* already gone */ }
        _console.Append($"[app] the server did not stop in time; its process tree was ended{Environment.NewLine}");
        try { await child.WaitForExitAsync(new CancellationTokenSource(TimeSpan.FromSeconds(3)).Token); } catch { }
        Set(ServerState.Stopped);
        return true;
    }

    public async Task RestartAsync()
    {
        await StopAsync();
        Start();
    }

    void OnLine(string line)
    {
        _console.Append(line + Environment.NewLine);

        // The one line that says the UI is being served. Everything else about the
        // boot is the tail: showing it is the boot panel's job, not a rule here.
        if (line.Contains("UI ready at ", StringComparison.Ordinal))
        {
            var at = line.IndexOf("http://", StringComparison.Ordinal);
            if (at >= 0) Url = line[at..].Trim().TrimEnd('.');
            if (State is ServerState.Starting or ServerState.Stopping) Set(ServerState.Running);
        }
    }

    void OnExited(Process child)
    {
        int code;
        try { code = child.ExitCode; }
        catch { code = -1; }

        lock (_gate)
        {
            if (ReferenceEquals(_child, child)) _child = null;
        }

        if (_stopping)
        {
            _stopping = false;
            Set(ServerState.Stopped);
            return;
        }

        if (code == ExitRestart)
        {
            _console.Append($"[app] restarting, as the server asked{Environment.NewLine}");
            Start();
            return;
        }

        if (code == 0)
        {
            Set(ServerState.Stopped);
            return;
        }

        // A death, not a request. No respawn loop: a port that is taken would be
        // retried forever and the operator would watch a window that never settles.
        var problem = _console.LastProblem();
        Set(ServerState.Failed, string.IsNullOrWhiteSpace(problem)
            ? $"The server stopped without saying why (exit code {code}). The console below is everything it wrote."
            : problem);
    }

    static bool SafeHasExited(Process p)
    {
        try { return p.HasExited; } catch { return true; }
    }

    void Set(ServerState state, string reason = "")
    {
        State = state;
        try { Changed?.Invoke(state, reason); } catch { /* a listener's problem */ }
    }

    /// <summary>
    /// The address the server will bind, read from the config before it starts.
    ///
    /// The fallback must match `DEFAULTS.server` in `src/config.js` — that is the
    /// one number that is written down twice, because the app has to know where to
    /// look before the thing that owns the number is running. The moment the server
    /// prints "UI ready at", its own answer replaces this one.
    /// </summary>
    static string ConfiguredUrl(string root)
    {
        const string fallback = "http://127.0.0.1:8700";
        try
        {
            var file = Path.Combine(root, "config", "synapse.config.json");
            if (!File.Exists(file)) return fallback;
            using var doc = JsonDocument.Parse(File.ReadAllText(file));
            if (!doc.RootElement.TryGetProperty("server", out var server)) return fallback;
            var host = server.TryGetProperty("host", out var h) ? h.GetString() : null;
            var port = server.TryGetProperty("port", out var p) && p.TryGetInt32(out var n) ? n : 0;
            return port > 0 ? $"http://{host ?? "127.0.0.1"}:{port}" : fallback;
        }
        catch
        {
            // An unreadable config is the server's problem to report, not the
            // shell's reason to refuse to start.
            return fallback;
        }
    }

    public void Dispose()
    {
        Process? child;
        lock (_gate)
        {
            child = _child;
            _child = null;
        }
        if (child == null) return;
        try
        {
            if (!SafeHasExited(child)) child.Kill(entireProcessTree: true);
        }
        catch { /* exiting */ }
        try { child.Dispose(); } catch { /* exiting */ }
    }
}
