// Engine registry. To replace the backend (e.g. LM Studio, Bionic, another
// service), add an adapter module here and set engine.type in the config.
import { OpenCodeEngine } from './opencode.js';

const REGISTRY = {
  opencode: (config, ctx) => new OpenCodeEngine(config, ctx),
};

export const KNOWN_ENGINES = Object.keys(REGISTRY);

export function createEngine(config, ctx) {
  const type = config?.engine?.type || 'opencode';
  const factory = REGISTRY[type];
  if (!factory) {
    throw new Error(`Unknown engine type "${type}". Known engines: ${KNOWN_ENGINES.join(', ')}`);
  }
  const engineConfig = config.engine?.[type] || {};
  return factory(engineConfig, ctx);
}
