// A page without a browser: just enough DOM for the page's own code to run in node.
//
// Why: several tests used to check the page by searching its source for a phrase —
// "must contain `ensureLivePost`", "must call installChatZoom". They fail when a
// sentence is reworded and pass when the behaviour is broken but the words are there.
// With this, a test can ask the real module what it rendered:
//
//     installPage();
//     const { renderTranscript } = await import('../web/transcript.js');
//     renderTranscript();
//     assert.match(document.getElementById('transcript').innerHTML, /STEER:/);
//
// The modules are imported *after* `installPage()`, because they touch `document` at
// import time (module-level state, event wiring). Everything the page needs is a stub:
// elements capture `innerHTML` as a string, classes and attributes are sets, geometry is
// zeroes, and animation frames run on the next macrotask.
//
// This is for behaviour, not layout. Anything that depends on measurement (the dock's
// height, the pane's slide, scrolling) still belongs to a real window.

class FakeClassList {
  constructor(initial = []) {
    this.set = new Set(initial);
  }
  add(...names) {
    for (const n of names) if (n) this.set.add(String(n));
  }
  remove(...names) {
    for (const n of names) this.set.delete(String(n));
  }
  toggle(name, force) {
    const on = force === undefined ? !this.set.has(name) : Boolean(force);
    if (on) this.set.add(name);
    else this.set.delete(name);
    return on;
  }
  contains(name) {
    return this.set.has(name);
  }
  item(i) {
    return [...this.set][i] ?? null;
  }
  get length() {
    return this.set.size;
  }
  get value() {
    return [...this.set].join(' ');
  }
}

const ZERO_RECT = { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };

export class FakeElement {
  constructor(id = '', tagName = 'div') {
    this.id = id;
    this.tagName = String(tagName).toUpperCase();
    this.childNodes = [];
    this._html = '';
    this.textContent = '';
    this.classList = new FakeClassList();
    this.style = {
      setProperty() {},
      removeProperty() {},
      getPropertyValue: () => '',
    };
    this.dataset = {};
    this.attributes = {};
    this.hidden = false;
    this.value = '';
    this.checked = false;
    this.files = [];
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    this.offsetHeight = 0;
    this.offsetWidth = 0;
  }

  get innerHTML() {
    return this._html;
  }
  set innerHTML(v) {
    this._html = v == null ? '' : String(v);
    // A render replaces the children; keeping them would make a second render look
    // like an append to anything that reads childNodes.
    this.childNodes = [];
  }

  get outerHTML() {
    return this._html;
  }

  get className() {
    return this.classList.value;
  }
  set className(v) {
    this.classList = new FakeClassList(String(v || '').split(/\s+/).filter(Boolean));
  }

  addEventListener() {}
  removeEventListener() {}
  dispatchEvent() {
    return true;
  }
  append(...nodes) {
    this.childNodes.push(...nodes);
  }
  appendChild(node) {
    this.childNodes.push(node);
    return node;
  }
  removeChild(node) {
    this.childNodes = this.childNodes.filter((n) => n !== node);
    return node;
  }
  remove() {}
  setAttribute(k, v) {
    this.attributes[k] = String(v);
  }
  getAttribute(k) {
    return this.attributes[k] ?? null;
  }
  removeAttribute(k) {
    delete this.attributes[k];
  }
  hasAttribute(k) {
    return k in this.attributes;
  }
  closest() {
    return null;
  }
  contains() {
    return false;
  }
  matches() {
    return false;
  }
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
  getBoundingClientRect() {
    return { ...ZERO_RECT };
  }
  getClientRects() {
    return [];
  }
  focus() {}
  blur() {}
  click() {}
  scrollTo() {}
  setSelectionRange() {}
}

/**
 * Install a fake `document`/`window` on globalThis and return the element registry.
 *
 * Idempotent: calling it twice in one file replaces the registry, which is what a test
 * that wants a clean page between cases needs. Call it *before* importing a page module.
 */
export function installPage() {
  const elements = new Map();
  const el = (id) => {
    if (!elements.has(id)) elements.set(id, new FakeElement(id));
    return elements.get(id);
  };
  const documentStub = {
    getElementById: el,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => new FakeElement('', tag),
    createTextNode: (text) => ({ nodeType: 3, data: String(text) }),
    addEventListener() {},
    removeEventListener() {},
    body: new FakeElement('body'),
    documentElement: new FakeElement('html'),
    activeElement: null,
    hidden: false,
    readyState: 'complete',
  };
  let frame = 0;
  const frames = new Map();
  const windowStub = {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
    requestAnimationFrame: (fn) => {
      const id = ++frame;
      frames.set(id, setTimeout(() => {
        frames.delete(id);
        try {
          fn(Date.now());
        } catch {
          /* a frame that throws in a test must not become an unhandled rejection */
        }
      }, 0));
      return id;
    },
    cancelAnimationFrame: (id) => {
      clearTimeout(frames.get(id));
      frames.delete(id);
    },
    innerWidth: 1280,
    innerHeight: 900,
    scrollX: 0,
    scrollY: 0,
    scrollTo() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    chrome: undefined,
    location: { href: 'http://127.0.0.1/', reload() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    getComputedStyle: () => ({ getPropertyValue: () => '', fontSize: '13px' }),
  };

  globalThis.document = documentStub;
  globalThis.window = windowStub;
  globalThis.requestAnimationFrame = windowStub.requestAnimationFrame;
  globalThis.cancelAnimationFrame = windowStub.cancelAnimationFrame;
  globalThis.getComputedStyle = windowStub.getComputedStyle;
  globalThis.CSS = { escape: (s) => String(s).replace(/[^\w-]/g, (c) => `\\${c}`) };
  globalThis.Node = { TEXT_NODE: 3, ELEMENT_NODE: 1 };
  // `navigator`, `location` and `localStorage` are getter-only on a modern Node, so
  // they are defined rather than assigned — assigning throws and would fail a test for
  // a reason that has nothing to do with the page.
  define('navigator', windowStub.navigator);
  define('location', windowStub.location);
  define('localStorage', windowStub.localStorage);
  globalThis.HTMLElement = FakeElement;

  return { el, elements, document: documentStub, window: windowStub };
}

/** A global the runtime may already own as a getter. */
function define(name, value) {
  try {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  } catch {
    // A global that cannot be replaced is not one the page needs in this test.
  }
}
