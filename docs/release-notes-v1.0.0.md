# Synapse v1.0.0

The first tagged release of Synapse: a self-contained Windows harness for
building software with agent models. Pick the models in the UI, discuss a plan,
approve it, and let the workers execute it while the work appears live.

## Requirements

- Windows 10 or 11, 64-bit
- .NET 10 Desktop Runtime
- Microsoft Edge WebView2 Runtime

Nothing else is installed on the machine. Node and the OpenCode engine travel
inside the zip.

## Run it

1. Download `Synapse-1.0.0-win-x64.zip` and unpack it somewhere writable — not
   under `Program Files`.
2. Double-click `Synapse.exe`.
3. The window opens, starts its own server, and shows the interface at
   <http://127.0.0.1:8700>.

The first run creates `data\` and `logs\` beside the exe, and the projects folder
as `..\Synapse.Projects` beside the Synapse folder. Closing the window hides it
to the tray; **Exit Synapse** in the tray stops the server too.

## Models

Provider keys are deliberately **not** included. Add them in **Settings →
Providers** on the machine where Synapse runs; they live in
`data\provider-keys.json` and never in the repository or the zip.

The shipped config carries provider definitions and role choices, but the
`Local LLM` and `Strata` entries point at `localhost:1235` and `localhost:8080`.
Edit or remove them if those servers are not running on that PC. The model
catalog itself comes from the engine binary.

## What is in the zip

| | |
|---|---|
| `Synapse.exe` | the app: WPF window, tray, server supervisor |
| `src\`, `web\` | the server and the interface |
| `skills\`, `templates\` | the agent skills and the Windows app template |
| `config\` | settings, with machine-specific paths cleared and no keys |
| `bin\node\` | Node 24.21.0, with npm and its licence |
| `bin\opencode\` | OpenCode 2.1.2, with its licence |
| `README.txt` | the short note for the receiving PC |

## What changed in v1.0

- A project is one conversation: one folder, one chat, no session list and no
  built-in General project.
- The Project Plan is a live file with `found` rows, owned by the Architect and
  rendered by Synapse, never repaired by it.
- A worker's session is replaced when its compaction no longer fits, with a
  handover to the new session.
- **Full auto** answers permission cards and questions after the timeout, using
  the Recommended option or the first one.
- Attachments can be pasted and a chosen one kept into the project's
  `.synapse\attachments\`.
- App data lives beside the executable in `data\`; scratch is temporary; the old
  profile copy is imported once, read-only.
- Permission policy is judged per shell statement: outside reads are allowed,
  outside writes ask, and writes inside the harness never happen.
- Portable runtime paths are cleared when a copied folder lands on a machine that
  does not have the old drive.

## Notes and limits

- Windows only, x64. The exe is unsigned; Windows SmartScreen may ask once.
- No model credentials are included. A local model server must be running before
  its models can answer.
- Ports are UI `8700` and engine `8720`; change them in
  `config\synapse.config.json` if either is taken.
- Git is optional: when present, Synapse uses it for restore points and project
  history; when absent, those steps are skipped.

The source, tests and engineering notes are in the repository. The Node and
OpenCode licences travel with their binaries in the zip.
