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
export const DATA_DIR = path.join(ROOT, 'data');
export const LOGS_DIR = path.join(ROOT, 'logs');

// Default working directory for sessions until per-project folders exist.
export const WORKSPACE_DIR = path.join(ROOT, 'workspace');

// The General project owns its own folder. It must not be the workspace root,
// where every project folder is created — a project that shares its directory
// with the workspace swallows sessions that belong to no project and cannot be
// told apart from them. Created on boot when missing.
export const GENERAL_DIR = path.join(WORKSPACE_DIR, 'general');

// Isolated engine home (config/data/state/tmp) so the engine never touches
// the machine-wide ~/.config/opencode or ~/.local/share/opencode.
export const ENGINE_HOME = path.join(DATA_DIR, 'engine', 'opencode');

// The project registry: which directories the operator has added as projects.
export const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');

// Aggregated tool-call census (which tools the models use, and what fails).
export const TOOL_STATS_FILE = path.join(DATA_DIR, 'tool-stats.json');

// Scratch directory for the tool-call probe: disposable, never a project.
export const PROBE_DIR = path.join(WORKSPACE_DIR, '_probe');

// The last probe run, so the results survive a restart.
export const PROBE_FILE = path.join(DATA_DIR, 'probe.json');

// What we know about each model: limits, thinking-effort variants and the
// discovered toolset. Survives models leaving the catalog.
export const MODEL_CACHE_FILE = path.join(DATA_DIR, 'model-cache.json');

// Synapse's own MCP server, registered into the engine's isolated config so the
// models can actually call it: a working web search (the engine's own needs a
// provider key and answers 403 here).
export const SEARCH_SERVER = path.join(ROOT, 'src', 'mcp', 'search-server.js');

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
