// The post that says this chat's turn is waiting for a local model server.
//
// A message sent while another project holds PolyStrata is not refused any more: it
// joins the server's queue. It is also not a user post yet — nothing has reached the
// engine, and a post that looks sent but is not in the transcript is the bug that
// erased it on the next switch (20 Nov). So the chat says what is actually true, in
// the harness's own voice: this turn is waiting, that other one has the server, and
// this starts when it ends. It is drawn from the server's queue, which is why it
// survives switching projects and closing the page.
import { esc } from './format.js';

export function waitPostHtml(lease) {
  const wait = lease?.waiting;
  if (!wait) return '';
  const server = String(wait.server || lease?.held?.server || '').trim() || 'The local server';
  const holder = String(wait.holder || lease?.held?.holder || '').trim();
  const ahead = Array.isArray(lease?.ahead) ? lease.ahead.filter(Boolean) : [];
  // "VPA has it" is only the truth when this turn is next. With two more projects in
  // front of it the post has to say so, or it promises a start that is three turns
  // away (21 Nov, their question).
  let sentence;
  if (!ahead.length) {
    sentence = holder
      ? `${holder} has ${server}. This chat's turn starts when that turn ends.`
      : `${server} is busy with another turn. This chat's turn starts when it ends.`;
  } else {
    const names = ahead.slice(0, 3).join(', then ') + (ahead.length > 3 ? `, then ${ahead.length - 3} more` : '');
    sentence =
      `${server} is busy — ${ahead.length} ${ahead.length === 1 ? 'turn is' : 'turns are'} ahead of this one ` +
      `(${names}). This chat's turn starts after them.`;
  }
  return `<div class="msg harness msg-wait" data-wait-post="1"><div class="msg-body">
        <span class="msg-role">Synapse · waiting for the local server</span>
        <span class="msg-wait-note">${esc(sentence)}</span>
      </div></div>`;
}
