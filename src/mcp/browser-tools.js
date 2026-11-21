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
      'outline of its text and the links on it. The window is hidden: the operator sees ' +
      'nothing. It opens http and https pages, and a local .html/.htm page when the file is ' +
      'inside the projects folder — a mock you wrote is meant to be looked at. The harness, ' +
      'the rest of the machine and every other file type are refused. The browser keeps its ' +
      'sessions between runs, so a site the operator signed in before is already signed in. ' +
      'Use this instead of webfetch when a page is signed in, behind a bot check, or drawn ' +
      'by script; a page that asks to be signed in needs handoff, not a scrape.',
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
      'It also says when the page is a sign-in wall, or a bot check a human has to clear.',
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
    name: 'click',
    description:
      'Click something on the page: a CSS selector, the visible text of a link or button, or an ' +
      'x/y pair from `read`. Anything that behaves clickable counts — a button, a tab, a link, ' +
      'or a row with a pointer cursor and a handler — and a point inside one is clicked where ' +
      'it was asked. Clicks are synthetic — the operator\'s cursor never moves. Answers the ' +
      'address afterwards and, when the click was moved to find a control, how far it landed ' +
      'from where you asked.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector to click.' },
        text: { type: 'string', description: 'Visible text of the link or button (exact, then contains).' },
        x: { type: 'integer', description: 'Page x coordinate, with y.' },
        y: { type: 'integer', description: 'Page y coordinate, with x.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'type',
    description:
      'Insert text into the focused field, or into a field named by a CSS selector. This pastes ' +
      'the text in — it does not fire key events, so a page that listens for keys (a calculator, ' +
      'a shortcut) needs `press` instead.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'What to type.' },
        selector: { type: 'string', description: 'CSS selector of the field to focus first.' },
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
      'their monitor, on that site, for as long as they need. When the session lands it is ' +
      'hidden again and the answer says why. If they reject it, carry on without the site.',
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
      'Save what a URL returns into the project, under .project/downloads, and answer its path. ' +
      'The fetch runs **inside the page**, so it carries the session\'s cookies and the site\'s ' +
      'own origin — the way a direct file address works in the tab and not from anywhere else. ' +
      'Use it for a file address you have (a "download" route, an API URL, a link from a page), ' +
      'especially on a site you are signed in to. It says plainly when the address answers a ' +
      '**page** instead of a file: a route like "…&action=download" often returns the page it ' +
      'belongs to, and then the page\'s own download control is the way through (use click — a ' +
      'click waits for the file). A captcha or "checking your browser" wall is reported rather ' +
      'than worked around: a human solves that, with handoff.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The http(s) address to fetch through the page.' },
        timeoutMs: { type: 'integer', description: 'How long to wait for it (1000-300000, default 120000).', minimum: 1000, maximum: 300000 },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'close',
    description: 'Close the browser. The profile and whatever was signed in stay for next time.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];