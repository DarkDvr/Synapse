// Where a project's browsing artifacts live.
//
// The engine gives each project's MCP server that project's folder as its working
// directory — measured 11 Nov: a server for the test project starts with
// `F:\dev\Synapse.Projects\test`. So screenshots and frame strips go in
// `<project>\.project\browser\`: they belong to that project, they are deleted with it,
// and they do not depend on the Prohibited list forgiving a folder under the harness.
//
// The projects root itself is not a project (it is the "all projects" context), so it
// falls back to the harness's own shots folder; so does any other working directory. That
// fallback is why `data\browser\shots\` stays on the harness's read exceptions.
import path from 'node:path';
import { DATA_DIR, PROJECTS_ROOT } from '../paths.js';

const HARNESS_SHOTS = path.join(DATA_DIR, 'browser', 'shots');

/** Is this working directory a project's own folder? */
function insideProject(cwd, projectsRoot) {
  const here = path.resolve(String(cwd || '.'));
  const root = path.resolve(String(projectsRoot || '.'));
  return here.toLowerCase().startsWith(`${root.toLowerCase()}${path.sep.toLowerCase()}`);
}

/**
 * The folder this process should write a screenshot into, from its working directory. Pure: both arguments are given, so the rule can be tested without a server.
 */
export function artifactDir(cwd = process.cwd(), projectsRoot = PROJECTS_ROOT) {
  const here = path.resolve(String(cwd || '.'));
  return insideProject(cwd, projectsRoot) ? path.join(here, '.project', 'browser', 'shots') : HARNESS_SHOTS;
}

/**
 * The folder a browser screenshot goes in — the same `.project/shots` every brief
 * names and the visual-review skill renders into.
 *
 * It used to be `.project/browser/shots`, and that was one folder too many: the brief
 * said pictures go in `.project/shots`, the browser tool answered with a path under
 * `.project/browser/shots`, and a model spent a step working out which instruction was
 * the real one (28 Nov). One folder for a picture the chat can show; the page
 * snapshots and the frame strips stay under `.project/browser/`, where only the tool
 * and a reader go.
 */
export function shotDir(cwd = process.cwd(), projectsRoot = PROJECTS_ROOT) {
  const here = path.resolve(String(cwd || '.'));
  return insideProject(cwd, projectsRoot) ? path.join(here, '.project', 'shots') : HARNESS_SHOTS;
}
