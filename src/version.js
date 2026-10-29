// The running version, from the one place that holds it.
//
// `package.json` is the source of truth: the travel copy already reads its
// `version` for the zip and the README, and the shell's `<Version>` mirrors it
// for the exe's file properties. Keep the three in step when releasing — see
// the Versioning section in AGENTS.md.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './paths.js';

function read() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    return String(pkg.version || '').trim() || '0.0.0';
  } catch {
    // A server run from a bare `src\` copy still has a version to report.
    return '0.0.0';
  }
}

export const APP_VERSION = read();
