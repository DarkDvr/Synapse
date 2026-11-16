// The last speed each role was measured at, kept longer than the run.
//
// A rate is a property of a role and its model, not of one run: a worker finishing a
// step should not wipe the number before the next step, and switching projects must not
// make every card look untouched. Two things end a reading — a newer measurement for the
// same role/model, or the role being given another model.
//
// `state.rates` still holds the live run's tally for the runner's own use; this is the
// card's memory. It is in localStorage because it must survive a page reload and a
// Synapse restart, and it is keyed by project so two projects' cards cannot borrow each
// other's figure.
import { state } from './state.js';

const STORAGE_KEY = 'synapse.roleRates.v1';
export const normDir = (dir) => String(dir || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
export const roleRateKey = (dir, role) => `${normDir(dir)}\u0000${role}`;

const storageOf = (storage) => storage === undefined
  ? (typeof localStorage !== 'undefined' ? localStorage : null)
  : storage;

function save(storage = storageOf()) {
  const box = storageOf(storage);
  if (!box || !(state.roleRates instanceof Map)) return;
  const out = {};
  for (const [key, rec] of state.roleRates) out[key] = rec;
  try { box.setItem(STORAGE_KEY, JSON.stringify(out)); } catch { /* full storage must not stop a turn */ }
}

/** Read the saved readings once, at boot. The map itself is tested without a page. */
export function loadRoleRates(storage = storageOf()) {
  if (!(state.roleRates instanceof Map)) state.roleRates = new Map();
  const box = storageOf(storage);
  if (!box) return state.roleRates;
  try {
    const raw = JSON.parse(box.getItem(STORAGE_KEY) || 'null');
    if (!raw || typeof raw !== 'object') {
      state.roleRates.clear();
      return state.roleRates;
    }
    state.roleRates.clear();
    for (const [key, rec] of Object.entries(raw)) {
      if (rec && typeof rec === 'object' && rec.role) state.roleRates.set(key, { ...rec });
    }
  } catch { /* a corrupt reading is not worth an error */ }
  return state.roleRates;
}

/** The role's last reading, or null when it was measured on another model. */
export function getRoleRate(dir, role, model = '') {
  const rec = state.roleRates?.get(roleRateKey(dir, role)) || null;
  if (!rec) return null;
  if (model && rec.model && rec.model !== model) return null;
  return rec;
}

/** A new step's tally replaces the role's reading, and is saved. */
export function rememberRoleRate(dir, role, model, tally) {
  if (!dir || !role || !tally) return null;
  const rec = {
    role,
    model: String(model || ''),
    tokens: Math.max(0, Number(tally.tokens) || 0),
    ms: Math.max(0, Number(tally.ms) || 0),
    at: Number(tally.at) || Date.now(),
  };
  if (!state.roleRates) state.roleRates = new Map();
  state.roleRates.set(roleRateKey(dir, role), rec);
  save();
  return rec;
}

/**
 * Forget a role's reading.
 *
 * With a directory, only that project. Without one, every project: a model is chosen
 * per role in Settings, and the old speed does not belong to the new model anywhere.
 */
export function clearRoleRate(role, dir = null) {
  if (!state.roleRates || !role) return;
  if (dir) state.roleRates.delete(roleRateKey(dir, role));
  else {
    for (const [key, rec] of [...state.roleRates]) if (rec?.role === role) state.roleRates.delete(key);
  }
  save();
}

/** A deleted project takes its readings with it, like its traces and runs. */
export function pruneRoleRates(folders) {
  if (!state.roleRates) return;
  const keep = new Set([...folders].map(normDir));
  for (const [key] of [...state.roleRates]) {
    const dir = key.split('\u0000')[0];
    if (!keep.has(dir)) state.roleRates.delete(key);
  }
  save();
}

export { STORAGE_KEY };
