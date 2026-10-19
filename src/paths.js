// All filesystem paths for Synapse, derived from the project root.
// Everything lives under F:\dev\Synapse; nothing is written outside it
// except the recycled engine binary we locate (node_modules) and the browser.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(here, '..');
export const CONFIG_DIR = path.join(ROOT, 'config');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'synapse.config.json');
export const WEB_DIR = path.join(ROOT, 'web');
// Skills that ship WITH Synapse, so the pipeline does not depend on what happens
// to be installed on this machine. The operator's own folders are extra paths on
// top of this one; this one is the product.
export const SKILLS_DIR = path.join(ROOT, 'skills');
export const DATA_DIR = path.join(ROOT, 'data');
export const LOGS_DIR = path.join(ROOT, 'logs');

// Where the operator's projects live: a SIBLING of the harness, never inside it.
// A project folder is a place the models work, and the engine's file and shell
// tools are not confined to a session's directory — so a project inside the
// harness puts the harness one stray absolute path away from being edited by a
// model. Keeping them side by side means the ruleset can allow the project and
// deny the harness without the two overlapping.
//
// Resolved from the harness root rather than written out, so the drive letter is
// nobody's business: `F:\dev\Synapse` and `D:\work\Synapse` both give `..\<name>`.
export const PROJECTS_ROOT = path.resolve(ROOT, '..', 'Synapse.Projects');

// The General project owns its own folder under the projects root, never the root
// itself — a project that shares its directory with the root swallows sessions
// that belong to no project and cannot be told apart from them.
export const GENERAL_DIR = path.join(PROJECTS_ROOT, 'general');

// Default working directory for sessions until a project is chosen. The engine
// needs a location that exists, and this is the one place all projects live.
export const WORKSPACE_DIR = PROJECTS_ROOT;

// Isolated engine home (config/data/state/tmp) so the engine never touches
// the machine-wide ~/.config/opencode or ~/.local/share/opencode.
export const ENGINE_HOME = path.join(DATA_DIR, 'engine', 'opencode');

// The project registry: which directories the operator has added as projects.
export const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');

// Aggregated tool-call census (which tools the models use, and what fails).
export const TOOL_STATS_FILE = path.join(DATA_DIR, 'tool-stats.json');

// Scratch directory for the tool-call probe: disposable, never a project. It sits
// under the projects root so the engine always has it, and `_probe` is filtered
// out of every project and session listing.
export const PROBE_DIR = path.join(PROJECTS_ROOT, '_probe');

// The harness's own source, for the tamper watchdog: a write to any of these is a
// write to the tool that is doing the writing.
export const HARNESS_DIRS = ['src', 'web', 'config', 'docs', 'skills'].map((d) => path.join(ROOT, d));
export const HARNESS_FILES = ['AGENTS.md', 'README.md', 'package.json', 'start.bat', 'stop.bat', 'restart.ps1']
  .map((f) => path.join(ROOT, f));

// Restore points for the harness: `git commit` before each delegation lands here
// as ordinary commits in the harness repository (there is no separate store).

// The last probe run, so the results survive a restart.
export const PROBE_FILE = path.join(DATA_DIR, 'probe.json');

// What we know about each model: limits, thinking-effort variants and the
// discovered toolset. Survives models leaving the catalog.
export const MODEL_CACHE_FILE = path.join(DATA_DIR, 'model-cache.json');

// Synapse's own MCP servers, registered into the engine's isolated config so the
// models can actually call them: a working web search (the engine's own needs a
// provider key and answers 403 here), and the delegation request the Architect
// hands tasks to a role with.
export const SEARCH_SERVER = path.join(ROOT, 'src', 'mcp', 'search-server.js');
export const DELEGATE_SERVER = path.join(ROOT, 'src', 'mcp', 'delegate-server.js');

export const PID_FILE = path.join(DATA_DIR, 'synapse.pid');

// The engine's own PID, so a restart can stop exactly the engine and nothing
// else.
//
// Matching processes by name is dangerous here and caused real damage: the
// desktop app installs to `...\Programs\@opencodedesktop\OpenCode.exe`, whose
// path contains `@opencode`, so a `Get-Process -Name opencode` filtered on
// `*@opencode*` matches the operator's editor as well as the engine. Read the
// pid from this file instead.
export const ENGINE_PID_FILE = path.join(DATA_DIR, 'engine.pid');
