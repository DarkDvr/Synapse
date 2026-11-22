// What a model is told about each browser tool.
//
// This file holds nothing but the descriptions and the schemas, because they are the
// model's only documentation: it reads them in its tool list before it decides anything,
// and it cannot experiment with a server the way a person experiments with a CLI. A wrong
// description is worse than a short one — `handoff` described a minimised window for a
// whole release after it became a permission card (13 Nov).
//
// It lives apart from the server so it can be read and tested without starting one:
// importing `browser-server.js` starts the stdio server, which waits on stdin for ever.

export const TOOLS = [
  {
    name: 'open',
    description:
      'Open a page in the harness\'s own browser and answer its address, title, a readable ' +
      'outline of its text and the links on it. The window is hidden on a desktop of its own: the ' +
      'operator never sees it and it never appears in their taskbar. It opens http and https ' +
      'pages, and a local .html/.htm page when the file is ' +
      'inside the projects folder — a mock you wrote is meant to be looked at. The harness, ' +
      'the rest of the machine and every other file type are refused. The browser keeps its ' +
      'sessions between runs, so a site the operator signed in before is already signed in. ' +
      'Use this instead of webfetch when a page is signed in, behind a bot check, or drawn ' +
      'by script; a page that asks to be signed in needs handoff, not a scrape. ' +
      'After it opens, call snapshot before clicking anything: that is where the refs come from.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The page to open (http(s), or a local .html/.htm file inside the projects folder).' },
        settleMs: { type: 'integer', description: 'How long to let the page finish rendering (default 900).', minimum: 0, maximum: 15000 },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'read',
    description:
      'Read the current page: its text as a person sees it, the links that can be clicked (each ' +
      'with its address and x/y), and the **buttons, tabs and rows that behave clickable** (each ' +
      'with the x/y a click uses as it is — not everything clickable is a link). Widgets in ' +
      'their own frame are named with their src and the coordinate to click inside them, because ' +
      'a frame\'s words are not in this page\'s text. ' +
      'The text is cut at maxChars — 6000 by default, 100000 at most — and a cut is marked in ' +
      'the answer with how much was left out. ' +
      'mode "article" (default) picks the main prose and drops the page around it; mode "text" ' +
      'keeps the whole page in the order it lays out, one line per block, so authors, dates ' +
      'and each comment keep their own lines — use it for a thread, a forum or a profile. ' +
      'For a long page (a thread with hundreds of comments) pass full: true instead: the ' +
      'harness scrolls to the end, saves the whole text in the project, and answers its path, ' +
      'so you can read or grep it in pieces rather than stitching several reads together. ' +
      'It also says when the page is a sign-in wall, or a bot check a human has to clear. ' +
      'For the controls to click, call snapshot: it answers each element with a stable ref. ' +
      'The x/y here is the fallback for a page where a ref is not available.',
    inputSchema: {
      type: 'object',
      properties: {
        maxChars: { type: 'integer', description: 'Characters of text (1000-100000, default 6000).', minimum: 1000, maximum: 100000 },
        links: { type: 'integer', description: 'How many links to list (0-120, default 60).', minimum: 0, maximum: 120 },
        mode: { type: 'string', enum: ['article', 'text'], description: 'article (default) picks the main prose; text is the whole page, one line per block, with names and dates.' },
        full: { type: 'boolean', description: 'Walk the page to its end — scrolling, so lazy sections load — and save the whole of it to the project instead of returning it. Answers the file path.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'snapshot',
    description:
      'The page as controls with stable references — the way to act on a page. Each line names ' +
      'one element and its ref, for example `button "Manual download" [ref=e145]` or ' +
      '`link "Slow download" [ref=e324]`. Click it with `click { "ref": "e145" }`, or fill it ' +
      'with `type { "ref": "e145", "text": "…" }`. Refs describe the page at the moment of the ' +
      'snapshot: after a click that navigates or changes the page, take a new one before using ' +
      'a ref again. This is more reliable than a screenshot and coordinates: it names the ' +
      'control, and a click fails loudly when the element is covered, hidden or off-screen. ' +
      'interactive (default true) lists controls only; set it false to include headings and ' +
      'text. compact drops empty structure, depth limits nesting, selector scopes the tree.',
    inputSchema: {
      type: 'object',
      properties: {
        interactive: { type: 'boolean', description: 'Only interactive controls (default true).' },
        compact: { type: 'boolean', description: 'Drop empty structural nodes and keep the visible text.' },
        depth: { type: 'integer', description: 'Limit the tree depth (1-20).', minimum: 1, maximum: 20 },
        selector: { type: 'string', description: 'Scope the snapshot to a CSS selector.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'click',
    description:
      'Click something on the page. Prefer a ref from snapshot — `{ "ref": "e145" }` — because ' +
      'it names the element itself, scrolls it into view, and fails loudly when it is covered ' +
      'or hidden instead of missing quietly. A CSS selector, the visible text of a link or ' +
      'button, or an x/y pair from `read` also work, as the fallback. Anything that behaves ' +
      'clickable counts — a button, a tab, a link, or a row with a pointer cursor and a ' +
      'handler. Clicks are synthetic — the operator\'s cursor never moves. Answers the address ' +
      'afterwards; a coordinate click also says when it was moved to find a control.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'A ref from snapshot, e.g. "e145" (preferred).' },
        selector: { type: 'string', description: 'CSS selector to click (fallback).' },
        text: { type: 'string', description: 'Visible text of the link or button (exact, then contains; fallback).' },
        x: { type: 'integer', description: 'Page x coordinate, with y (last resort).' },
        y: { type: 'integer', description: 'Page y coordinate, with x (last resort).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'type',
    description:
      'Write into a field. With a ref from snapshot it clears the field and fills it — what a ' +
      'login or search box wants. Without a ref it inserts into the focused field, or into a ' +
      'field named by a CSS selector; insertion does not fire key events, so a page that ' +
      'listens for keys (a calculator, a shortcut) needs `press` instead.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'What to type.' },
        ref: { type: 'string', description: 'A ref from snapshot, e.g. "e12" (preferred).' },
        selector: { type: 'string', description: 'CSS selector of the field to focus first (fallback).' },
        submit: { type: 'boolean', description: 'Press Enter afterwards.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'press',
    description:
      'Press a key on the page. A single printable character is pressed as that key — "7", "=", ' +
      '"+", "a" — so the page sees a real keydown/keypress/keyup, which is what a keyboard ' +
      'shortcut or a calculator needs. Several characters are pressed one by one the same way. ' +
      'Named keys: enter, tab, escape, backspace, space, arrows, pageup, pagedown. Unlike `type`, ' +
      'which inserts text into a field, this fires key events.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string', description: 'A character ("7", "="), several characters, or a key name (enter, tab, escape…).' } },
      required: ['key'],
      additionalProperties: false,
    },
  },
  {
    name: 'wait',
    description:
      'Wait until the page shows a piece of text, or a selector, or simply for a time. Use it ' +
      'after a click that loads something, instead of guessing — to check whether something is ' +
      'there *now*, `read` is cheaper. It waits for text a person can see, so a timeout says ' +
      'which kind of absence it was: the text is missing from the page entirely, or it is in the ' +
      'page and not shown (a collapsed comment, a closed menu, a tooltip) — open that and wait ' +
      'again. Check the spelling before waiting twice.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to wait for, as a person would read it.' },
        selector: { type: 'string', description: 'CSS selector to wait for.' },
        ms: { type: 'integer', description: 'Milliseconds to wait instead.', minimum: 0, maximum: 30000 },
        timeoutMs: { type: 'integer', description: 'How long before giving up (default 20000).', minimum: 1000, maximum: 120000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'scroll',
    description: 'Scroll the page by a number of pixels (positive is down) and answer where it stopped.',
    inputSchema: {
      type: 'object',
      properties: { dy: { type: 'integer', description: 'Pixels to scroll (default 600).', minimum: -20000, maximum: 20000 } },
      additionalProperties: false,
    },
  },
  {
    name: 'screenshot',
    description:
      'Take a picture of the page — the viewport, or the whole document — and answer its path, ' +
      'in the project under .project\\browser\\shots; the answer also gives the relative path ' +
      'the chat renders, so you can show it without copying. ' +
      'Read the image to see what a person would see.',
    inputSchema: {
      type: 'object',
      properties: { full: { type: 'boolean', description: 'Capture the whole document, not just the viewport.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'watch',
    description:
      'Watch movement for a moment: answers a strip of frames as image paths (project .project\\browser\\), for an animation, ' +
      'a spinner, a menu that slides. A still cannot show what changed.',
    inputSchema: {
      type: 'object',
      properties: {
        ms: { type: 'integer', description: 'How long to watch (200-5000, default 1200).', minimum: 200, maximum: 5000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'tabs',
    description: 'List the pages this browser has open.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'handoff',
    description:
      'Ask the operator to do the one thing only a person can: sign in, or pass a check. It ' +
      'raises a card in their chat — Allow Sign-In, Reject, Reject With Reason, Stop Run — and ' +
      'waits without a time limit. Only an Allow opens a browser window: normal, focused, on ' +
      'their monitor, on that site, for as long as they need. It is the same profile, so the ' +
      'sign-in is kept for every later run and recorded in the Signed In table. When they close ' +
      'the window the hidden browser comes back on the same page and the tool answers. If they ' +
      'reject it, carry on without the site.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Where to put the browser first (optional).' },
        what: { type: 'string', description: 'One sentence for the operator: what is needed.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'download',
    description:
      'Save a file from the page into the project, under .project/downloads, and answer its path. ' +
      'Pass url for a direct file address; leave it out to wait for a download a click has just ' +
      'started. A click on a download link already waits for the file, so this tool is for a URL ' +
      'that is itself the file, or for a download that began after the click answered. The name ' +
      'is the one the site suggested, made safe; an existing file is never overwritten — the new ' +
      'one gets " (1)". The chat shows an ASCII progress bar while it runs, so the operator can ' +
      'watch a large file. A cancelled or failed download says so instead of answering a path.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'A direct http(s) file address. Leave it out to wait for a download already in flight.' },
        timeoutMs: { type: 'integer', description: 'How long to wait for the file (1000-600000, default 120000).', minimum: 1000, maximum: 600000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'save',
    description:
      'Make a request **through the page** and either save what comes back into the project ' +
      '(under .project/downloads) or return its body. GET by default; `method` and `form` send a ' +
      'POST, which is how a site\'s own script asks for a download link: same cookies, same origin, ' +
      'the page as referrer — a POST that is challenged from a bare client answers here. ' +
      'With `json: true` the body comes back as text instead of being saved, so a route that ' +
      'answers {"url": "https://…"} tells you the file\'s address, and the next call is save on ' +
      'that address. ' +
      'It also says plainly when an address answers a **page** instead of a file: a route like ' +
      '"…&action=download" often returns the page it belongs to. A captcha or "checking your ' +
      'browser" wall is reported rather than worked around: a human solves that, with handoff.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The http(s) address to request through the page.' },
        method: { type: 'string', enum: ['GET', 'POST'], description: 'GET (default) or POST.' },
        form: {
          type: 'object',
          description: 'Fields for a POST, sent as application/x-www-form-urlencoded (e.g. {game_id:"1704", file_id:"245273"}).',
          additionalProperties: { type: ['string', 'number', 'boolean'] },
        },
        xhr: { type: 'boolean', description: 'Send X-Requested-With: XMLHttpRequest, which is what a page\'s own AJAX sends.' },
        json: { type: 'boolean', description: 'Return the body as text (up to 12000 characters) instead of saving it.' },
        timeoutMs: { type: 'integer', description: 'How long to wait for it (1000-300000, default 120000).', minimum: 1000, maximum: 300000 },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'dom',
    description:
      'Read what elements say about themselves: tag, text, the attributes that matter (data-*, ' +
      'href, src, title, aria-*, id, class) and where each one is on screen. Use it when a fact ' +
      'lives in an attribute rather than the page text — a file id, a game id, a link a script ' +
      'will use, the action of a form — which is exactly what a page\'s own script reads before ' +
      'it asks for a file. CSS selectors: "[data-file-id]", ".mod-file-download", ' +
      '"a[href*=download]". A widget inside a frame is not in this document: read names its frame.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'A CSS selector.' },
        limit: { type: 'integer', description: 'How many matches to describe (1-40, default 12).', minimum: 1, maximum: 40 },
      },
      required: ['selector'],
      additionalProperties: false,
    },
  },
  {
    name: 'close',
    description: 'Close the browser. The profile and whatever was signed in stay for next time.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];