// Minimal Markdown → DOM renderer for chat bubbles.
//
// Worker output is Markdown, and showing it raw meant reading literal ``` and **
// in the chat. Every piece of text goes into the document through textContent —
// never innerHTML — so a model that emits "<img onerror=…>" or a "javascript:"
// link cannot inject anything into the page. That is also why there is no HTML
// passthrough: raw tags in the source render as visible text.
//
// Exposed as window.TCMarkdown; also exported under CommonJS so the renderer can
// be unit-tested against a DOM stub without a browser.
(function (root) {
  // Only http/https/mailto may become a link; anything else stays plain text.
  function safeHref(url) {
    const u = String(url).trim();
    return /^(https?:\/\/|mailto:)/i.test(u) ? u : null;
  }

  // Inline spans, longest-delimiter-first so ** wins over * and ~~ over ~.
  const INLINE_RE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(~~[^~\n]+~~)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]\n]*\]\([^)\s]+\))|(https?:\/\/[^\s<>()]+)/;

  function renderInline(doc, text, parent) {
    let rest = String(text);
    while (rest) {
      const m = INLINE_RE.exec(rest);
      if (!m) { parent.appendChild(doc.createTextNode(rest)); return; }
      if (m.index > 0) parent.appendChild(doc.createTextNode(rest.slice(0, m.index)));
      const tok = m[0];
      let el;
      if (tok.startsWith("`")) {
        el = doc.createElement("code");
        el.textContent = tok.slice(1, -1);
      } else if (tok.startsWith("**") || tok.startsWith("__")) {
        el = doc.createElement("strong");
        renderInline(doc, tok.slice(2, -2), el);
      } else if (tok.startsWith("~~")) {
        el = doc.createElement("del");
        renderInline(doc, tok.slice(2, -2), el);
      } else if (tok.startsWith("[")) {
        const cut = tok.indexOf("](");
        const href = safeHref(tok.slice(cut + 2, -1));
        if (href) {
          el = doc.createElement("a");
          el.setAttribute("href", href);
          el.setAttribute("target", "_blank");
          el.setAttribute("rel", "noopener noreferrer");
          el.textContent = tok.slice(1, cut);
        } else {
          el = doc.createTextNode(tok); // unsafe scheme → show the source text
        }
      } else if (tok.startsWith("http")) {
        el = doc.createElement("a");
        el.setAttribute("href", tok);
        el.setAttribute("target", "_blank");
        el.setAttribute("rel", "noopener noreferrer");
        el.textContent = tok;
      } else {
        el = doc.createElement("em");
        renderInline(doc, tok.slice(1, -1), el);
      }
      parent.appendChild(el);
      rest = rest.slice(m.index + tok.length);
    }
  }

  const FENCE_RE = /^\s*(```|~~~)(.*)$/;
  const HEADING_RE = /^(#{1,6})\s+(.*)$/;
  const RULE_RE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
  const BULLET_RE = /^\s*[-*+]\s+(.*)$/;
  const ORDERED_RE = /^\s*\d+[.)]\s+(.*)$/;
  const QUOTE_RE = /^\s*>\s?(.*)$/;

  function renderMarkdown(text, doc) {
    doc = doc || root.document;
    const frag = doc.createDocumentFragment();
    const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }

      // An unterminated fence runs to the end of the message rather than
      // swallowing the rest of it as a paragraph.
      const fence = FENCE_RE.exec(line);
      if (fence) {
        const marker = fence[1];
        const body = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(marker)) body.push(lines[i++]);
        i++; // closing fence (or EOF)
        const pre = doc.createElement("pre");
        const code = doc.createElement("code");
        code.textContent = body.join("\n");
        pre.appendChild(code);
        frag.appendChild(pre);
        continue;
      }

      if (RULE_RE.test(line)) { frag.appendChild(doc.createElement("hr")); i++; continue; }

      const heading = HEADING_RE.exec(line);
      if (heading) {
        const h = doc.createElement("h" + Math.min(heading[1].length, 6));
        renderInline(doc, heading[2], h);
        frag.appendChild(h);
        i++;
        continue;
      }

      if (QUOTE_RE.test(line)) {
        const body = [];
        while (i < lines.length && QUOTE_RE.test(lines[i])) body.push(QUOTE_RE.exec(lines[i++])[1]);
        const bq = doc.createElement("blockquote");
        bq.appendChild(renderMarkdown(body.join("\n"), doc));
        frag.appendChild(bq);
        continue;
      }

      const bullet = BULLET_RE.test(line);
      if (bullet || ORDERED_RE.test(line)) {
        const re = bullet ? BULLET_RE : ORDERED_RE;
        const list = doc.createElement(bullet ? "ul" : "ol");
        while (i < lines.length && re.test(lines[i])) {
          const li = doc.createElement("li");
          renderInline(doc, re.exec(lines[i++])[1], li);
          list.appendChild(li);
        }
        frag.appendChild(list);
        continue;
      }

      // Paragraph: runs to a blank line or the start of another block. A single
      // newline inside it is a hard break, matching how chat text is written.
      const para = [];
      while (
        i < lines.length && lines[i].trim() &&
        !FENCE_RE.test(lines[i]) && !HEADING_RE.test(lines[i]) && !RULE_RE.test(lines[i]) &&
        !QUOTE_RE.test(lines[i]) && !BULLET_RE.test(lines[i]) && !ORDERED_RE.test(lines[i])
      ) para.push(lines[i++]);
      const p = doc.createElement("p");
      para.forEach((l, n) => {
        if (n) p.appendChild(doc.createElement("br"));
        renderInline(doc, l, p);
      });
      frag.appendChild(p);
    }
    return frag;
  }

  const api = { renderMarkdown, safeHref };
  root.TCMarkdown = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
