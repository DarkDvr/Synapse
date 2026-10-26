using System;
using System.IO;
using System.Text;

namespace Synapse;

/// <summary>
/// The console: what the server prints, kept in one file and in one ring.
///
/// There is exactly one writer, and it is the shell. The page reads it through the
/// WebView2 message channel rather than an API route, because the console has to
/// work when the server is stopped — which is the whole reason it moved into the
/// window. See <c>docs/notes/desktop-app.md</c>.
///
/// The file is a record; the ring is what a popup can be filled from instantly, and
/// it is bounded so a chatty engine cannot grow the app's memory without limit.
/// </summary>
public sealed class ConsoleStore : IDisposable
{
    // Five megabytes and one old file: the same bargain logger.js makes for the
    // per-channel logs, so the folder does not quietly fill up.
    const long RotateBytes = 5L * 1024 * 1024;
    const int KeepChars = 400_000;

    readonly object _gate = new();
    readonly string _path;
    readonly StringBuilder _text = new();

    long _start;   // absolute offset of the first character still held
    long _end;     // absolute offset of the end
    StreamWriter? _file;

    public ConsoleStore(string path)
    {
        _path = path;
        try
        {
            Directory.CreateDirectory(System.IO.Path.GetDirectoryName(path)!);
            Rotate();
        }
        catch
        {
            // A console that cannot be written to disk is still a console in memory.
            _file = null;
        }
    }

    public string FilePath => _path;

    /// <summary>Add a line, remembering it and appending it to the file.</summary>
    public void Append(string text)
    {
        if (string.IsNullOrEmpty(text)) return;
        lock (_gate)
        {
            _text.Append(text);
            _end += text.Length;
            Trim();

            try
            {
                if (_file != null && _file.BaseStream.Length > RotateBytes)
                {
                    _file.Dispose();
                    _file = null;
                    Rotate();
                }
                _file?.Write(text);
            }
            catch
            {
                _file = null;   // the record is best-effort; the ring is not
            }
        }
    }

    /// <summary>
    /// Everything after <paramref name="from"/>, and where the caller now is.
    ///
    /// `dropped` says the ring has already discarded the caller's position, so what
    /// comes back is the whole window rather than a continuation — the page must
    /// replace its text, not append, or it would show a seam.
    /// </summary>
    public (string text, long end, bool dropped) Tail(long from)
    {
        lock (_gate)
        {
            if (from < _start) return (_text.ToString(), _end, true);
            var skip = (int)Math.Min(from - _start, _text.Length);
            if (skip >= _text.Length) return (string.Empty, _end, false);
            return (_text.ToString(skip, _text.Length - skip), _end, false);
        }
    }

    /// <summary>
    /// The most useful line to put in front of the operator after a failure, or
    /// empty when the output holds no such line.
    ///
    /// The last line a crashed Node process writes is usually the tail of a stack
    /// trace — `at process.processTicksAndRejections`, which says nothing — so the
    /// search runs backwards for the first line that reads like a message and skips
    /// stack frames on the way.
    ///
    /// Empty is a real answer: a process killed from outside prints nothing at all,
    /// and quoting an ordinary INFO line as the reason would be a lie. The caller
    /// then says what it knows instead.
    /// </summary>
    public string LastProblem(int scan = 60)
    {
        string all;
        lock (_gate) all = _text.ToString();
        var lines = all.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (lines.Length == 0) return string.Empty;

        var floor = Math.Max(0, lines.Length - scan);
        for (var i = lines.Length - 1; i >= floor; i--)
        {
            var line = lines[i];
            if (line.StartsWith("at ", StringComparison.Ordinal)) continue;
            foreach (var marker in ProblemMarkers)
            {
                if (line.Contains(marker, StringComparison.OrdinalIgnoreCase)) return line;
            }
        }
        return string.Empty;
    }

    static readonly string[] ProblemMarkers =
    {
        "error", "eaddrinuse", "eacces", "enonent", "refused", "denied", "cannot", "could not", "failed", "not found",
    };

    /// <summary>Drop everything from the front so the ring stays bounded.</summary>
    void Trim()
    {
        while (_text.Length > KeepChars)
        {
            // Cut at a newline so a line is never half-kept.
            var cut = _text.ToString(0, _text.Length - KeepChars).IndexOf('\n');
            var remove = cut >= 0 ? cut + 1 : _text.Length - KeepChars;
            _text.Remove(0, remove);
            _start += remove;
        }
    }

    void Rotate()
    {
        try
        {
            if (File.Exists(_path))
            {
                var old = _path + ".1";
                if (File.Exists(old)) File.Delete(old);
                File.Move(_path, old);
            }
            _file = new StreamWriter(new FileStream(_path, FileMode.Append, FileAccess.Write, FileShare.Read))
            {
                AutoFlush = true,
            };
        }
        catch
        {
            _file = null;
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            try { _file?.Dispose(); } catch { /* exiting */ }
            _file = null;
        }
    }
}
