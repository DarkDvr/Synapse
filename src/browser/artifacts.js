// Where a project's browsing artifacts live.
//
// The engine gives each project's MCP server that project's folder as its working
// directory — measured 11 Nov: a server for the test project starts with
// `F:\dev\Synapse.Projects\test`. So screenshots and frame strips go in
// `<project>\.synapse\browser\`: they belong to that project, they are deleted with it,
// and they do not depend on the Prohibited list forgiving a folder under the harness.
//
// The projects root itself is not a project (it is the "all projects" context), so it
// falls back to the harness's own shots folder; so does any other working directory. That
// fallback is why `data\browser\shots\` stays on the harness's read exceptions.
import path from 'node:path';
import { DATA_DIR, PROJECTS_ROOT } from '../paths.js';

const HARNESS_SHOTS = path.join(DATA_DIR, 'browser', 'shots');

/**
 * The folder this process should write browsing artifacts into, from its working
 * directory. Pure: both arguments are given, so the rule can be tested without a server.
 */
export function artifactDir(cwd = process.cwd(), projectsRoot = PROJECTS_ROOT) {
  const here = path.resolve(String(cwd || '.'));
  const root = path.resolve(String(projectsRoot || '.'));
  const inside = here.toLowerCase().startsWith(`${root.toLowerCase()}${path.sep.toLowerCase()}`);
  return inside ? path.join(here, '.synapse', 'browser') : HARNESS_SHOTS;
}
