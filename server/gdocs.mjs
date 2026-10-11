// Replace one tab of a Google Doc with formatted markdown, using only the Docs API
// (scope: documents). Supports headings, paragraphs, bold/italic/strike/code/links,
// and nested bullet, numbered and checkbox lists.
import { marked } from 'marked';

const API = 'https://docs.googleapis.com/v1/documents';
let cached = { token: null, expires: 0 };

async function accessToken() {
  if (cached.token && Date.now() < cached.expires - 60_000) return cached.token;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`token refresh failed: ${body.error_description || body.error}`);
  cached = { token: body.access_token, expires: Date.now() + body.expires_in * 1000 };
  return cached.token;
}

async function call(path, init = {}) {
  const res = await fetch(`${API}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Docs API ${res.status}: ${body.error?.message}`);
  return body;
}

// Markdown → plain text plus style ranges (offsets in UTF-16 units, as Docs expects).
export function layout(md) {
  let text = '';
  const paragraphs = []; // { start, end, style }
  const spans = []; // { start, end, style, fields }
  const lists = []; // { start, end, preset }

  const add = (s, style) => {
    const start = text.length;
    text += s;
    if (style) spans.push({ start, end: text.length, ...style });
  };
  const inline = (tokens = [], marks = {}) => {
    for (const t of tokens) {
      if (t.type === 'strong') inline(t.tokens, { ...marks, bold: true });
      else if (t.type === 'em') inline(t.tokens, { ...marks, italic: true });
      else if (t.type === 'del') inline(t.tokens, { ...marks, strikethrough: true });
      else if (t.type === 'link') inline(t.tokens, { ...marks, link: { url: t.href } });
      else if (t.type === 'codespan') add(t.text, textStyle({ ...marks, code: true }));
      else if (t.type === 'br') add('\u000b');
      else if (t.tokens) inline(t.tokens, marks);
      else add(decode(t.text ?? ''), textStyle(marks));
    }
  };
  const line = (tokens, style, marks) => {
    const start = text.length;
    inline(tokens, marks);
    text += '\n';
    paragraphs.push({ start, end: text.length, style });
  };
  const list = (token, depth, root) => {
    for (const item of token.items) {
      const start = text.length;
      root.start ??= start;
      text += '\t'.repeat(depth);
      let closed = false;
      for (const child of item.tokens) {
        if (child.type === 'list') {
          if (!closed) { text += '\n'; closed = true; }
          list(child, depth + 1, root);
        } else if (child.type !== 'checkbox' && child.type !== 'space') {
          if (closed) text += '\t'.repeat(depth); // further paragraphs of a loose item
          inline(child.tokens ?? [{ type: 'text', text: child.text }], item.checked ? { strikethrough: true } : {});
          text += '\n';
          closed = true;
        }
      }
      if (!closed) text += '\n';
      if (item.task) root.task = true;
      root.end = text.length;
    }
  };

  for (const t of marked.lexer(md)) {
    if (t.type === 'heading') line(t.tokens, `HEADING_${t.depth}`);
    else if (t.type === 'paragraph') line(t.tokens);
    else if (t.type === 'blockquote') t.tokens.forEach((b) => b.tokens && line(b.tokens, null, { italic: true }));
    else if (t.type === 'code') { add(t.text, textStyle({ code: true })); text += '\n'; }
    else if (t.type === 'list') {
      const root = { ordered: t.ordered };
      list(t, 0, root);
      lists.push({
        start: root.start, end: root.end,
        preset: root.task ? 'BULLET_CHECKBOX' : root.ordered ? 'NUMBERED_DECIMAL_ALPHA_ROMAN' : 'BULLET_DISC_CIRCLE_SQUARE',
      });
    } else if (t.text && t.type !== 'space' && t.type !== 'hr') line([{ type: 'text', text: t.text }]);
  }
  return { text, paragraphs, spans, lists };
}

const decode = (s) => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]);

function textStyle(marks) {
  const style = {};
  if (marks.bold) style.bold = true;
  if (marks.italic) style.italic = true;
  if (marks.strikethrough) style.strikethrough = true;
  if (marks.link) style.link = marks.link;
  if (marks.code) style.weightedFontFamily = { fontFamily: 'Roboto Mono', weight: 400 };
  const fields = Object.keys(style);
  return fields.length ? { style, fields: fields.join(',') } : null;
}

function flatTabs(tabs) {
  return tabs.flatMap((t) => [t, ...flatTabs(t.childTabs ?? [])]);
}

// Write `md` into the tab titled `title`, creating it (or claiming an empty "Tab 1").
export async function pushTab(docId, title, md) {
  let doc = await call(`${docId}?includeTabsContent=true`);
  let tabs = flatTabs(doc.tabs);
  let tab = tabs.find((t) => t.tabProperties.title === title);
  if (!tab) {
    const lone = tabs.length === 1 && tabs[0];
    const blank = lone && lone.tabProperties.title === 'Tab 1' && bodyEnd(lone) <= 2;
    const request = blank
      ? { updateDocumentTabProperties: { tabProperties: { tabId: lone.tabProperties.tabId, title }, fields: 'title' } }
      : { addDocumentTab: { tabProperties: { title } } };
    await call(`${docId}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests: [request] }) });
    doc = await call(`${docId}?includeTabsContent=true`);
    tab = flatTabs(doc.tabs).find((t) => t.tabProperties.title === title);
  }
  const tabId = tab.tabProperties.tabId;
  const end = bodyEnd(tab);
  const { text, paragraphs, spans, lists } = layout(md);
  const body = text.replace(/\n$/, ''); // the tab keeps its own final newline
  const range = (start, stop) => ({ startIndex: start + 1, endIndex: stop + 1, tabId });

  const requests = [];
  if (end > 2) requests.push({ deleteContentRange: { range: { startIndex: 1, endIndex: end - 1, tabId } } });
  if (body) {
    const all = range(0, body.length);
    requests.push(
      { insertText: { location: { index: 1, tabId }, text: body } },
      { deleteParagraphBullets: { range: all } },
      { updateParagraphStyle: { range: all, paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, fields: 'namedStyleType' } },
      { updateTextStyle: { range: all, textStyle: {}, fields: 'bold,italic,strikethrough,link,weightedFontFamily' } },
      ...paragraphs.filter((p) => p.style).map((p) => ({
        updateParagraphStyle: { range: range(p.start, Math.min(p.end, body.length)), paragraphStyle: { namedStyleType: p.style }, fields: 'namedStyleType' },
      })),
      ...spans.filter((s) => s.end > s.start).map((s) => ({
        updateTextStyle: { range: range(s.start, s.end), textStyle: s.style, fields: s.fields },
      })),
      // Bullets last and bottom-up: creating them strips the nesting tabs and shifts later text.
      ...[...lists].reverse().map((l) => ({
        createParagraphBullets: { range: range(l.start, Math.min(l.end, body.length)), bulletPreset: l.preset },
      })),
    );
  } else {
    // Empty week: clear any leftover list or heading formatting on the remaining paragraph.
    const blank = { startIndex: 1, endIndex: 2, tabId };
    requests.push(
      { deleteParagraphBullets: { range: blank } },
      { updateParagraphStyle: { range: blank, paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, fields: 'namedStyleType' } },
    );
  }
  await call(`${docId}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests }) });
  return tabId;
}

function bodyEnd(tab) {
  const content = tab.documentTab?.body?.content ?? [];
  return content.at(-1)?.endIndex ?? 2;
}
