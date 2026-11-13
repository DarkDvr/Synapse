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
      'Read the current page: its text as a person sees it, and the links that can be clicked, ' +
      'each with its address and its x/y. The text is cut at maxChars — 6000 by default, ' +
      '100000 at most — and a cut is marked in the answer with how much was left out. ' +
      'For a long page (a thread with hundreds of comments) pass full: true instead: the ' +
      'harness scrolls to the end, saves the whole text in the project, and answers its path, ' +
      'so you can read or grep it in pieces rather than stitching several reads together.',
    inputSchema: {
      type: 'object',
      properties: {
        maxChars: { type: 'integer', description: 'Characters of text (1000-100000, default 6000).', minimum: 1000, maximum: 100000 },
        links: { type: 'integer', description: 'How many links to list (0-120, default 60).', minimum: 0, maximum: 120 },
        mode: { type: 'string', enum: ['article', 'text'], description: 'article (default) picks the main content and drops the page around it; text is the whole page.' },
        full: { type: 'boolean', description: 'Walk the page to its end — scrolling, so lazy sections load — and save the whole of it to the project instead of returning it. Answers the file path.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'click',
    description:
      'Click something on the page: a CSS selector, the visible text of a link or button, or an ' +
      'x/y pair from `read`. Clicks are synthetic — the operator\'s cursor never moves. Answers the ' +
      'address afterwards, so you can see whether it navigated.',
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
    description: 'Type text into the focused field, or into a field named by a CSS selector.',
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
    description: 'Press one key: enter, tab, escape, backspace, space, arrows, pageup, pagedown.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string', description: 'The key name.' } },
      required: ['key'],
      additionalProperties: false,
    },
  },
  {
    name: 'wait',
    description:
      'Wait until the page contains a piece of text, or a selector, or simply for a time. ' +
      'Use it after a click that loads something, instead of guessing.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to wait for.' },
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
      'in the project under .synapse\\browser\\shots; the answer also gives the relative path ' +
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
      'Watch movement for a moment: answers a strip of frames as image paths (project .synapse\\browser\\), for an animation, ' +
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
    name: 'close',
    description: 'Close the browser. The profile and whatever was signed in stay for next time.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];