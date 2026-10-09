/* Small markdown renderer for the journal.
   All text is HTML-escaped before any formatting is applied, so note content
   can never inject markup or scripts into the page. */
(function (root) {
  'use strict';

  function esc(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function unesc(text) {
    return String(text)
      .replace(/&quot;/g, '"')
      .replace(/&gt;/g, '>')
      .replace(/&lt;/g, '<')
      .replace(/&amp;/g, '&');
  }

  const WIKI_SOURCE = '\\[\\[([^\\[\\]|\\n]+?)(?:\\|([^\\[\\]\\n]+?))?\\]\\]';
  const TAG_SOURCE = '(^|[\\s(])#([A-Za-z][\\w/-]*)';

  function stripCode(md) {
    return String(md)
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`[^`\n]*`/g, ' ');
  }

  /* Titles that this text links to with [[Title]] or [[Title|label]]. */
  function extractLinks(md) {
    const text = stripCode(md);
    const re = new RegExp(WIKI_SOURCE, 'g');
    const seen = new Set();
    const out = [];
    let m;
    while ((m = re.exec(text))) {
      const title = m[1].trim();
      const key = title.toLowerCase();
      if (title && !seen.has(key)) {
        seen.add(key);
        out.push(title);
      }
    }
    return out;
  }

  /* Lower-case tags written as #tag. */
  function extractTags(md) {
    const text = stripCode(md);
    const re = new RegExp(TAG_SOURCE, 'gm');
    const seen = new Set();
    const out = [];
    let m;
    while ((m = re.exec(text))) {
      const tag = m[2].toLowerCase();
      if (!seen.has(tag)) {
        seen.add(tag);
        out.push(tag);
      }
    }
    return out;
  }

  /* Rewrites [[Old]] to [[New]] (keeping any |label), skipping code. */
  function renameLinks(md, oldTitle, newTitle) {
    const oldKey = String(oldTitle).trim().toLowerCase();
    return String(md)
      .split(/(```[\s\S]*?```|`[^`\n]*`)/)
      .map(function (part, i) {
        if (i % 2 === 1) return part;
        return part.replace(new RegExp(WIKI_SOURCE, 'g'), function (all, title, label) {
          if (title.trim().toLowerCase() !== oldKey) return all;
          return '[[' + newTitle + (label ? '|' + label : '') + ']]';
        });
      })
      .join('');
  }

  function inline(raw, ctx) {
    const stash = [];
    function keep(html) {
      stash.push(html);
      return '\u0000' + (stash.length - 1) + '\u0000';
    }

    let s = esc(raw);

    // code spans first, so nothing inside them is formatted
    s = s.replace(/`([^`\n]+)`/g, function (_, code) {
      return keep('<code>' + code + '</code>');
    });

    // [[wiki links]]
    s = s.replace(new RegExp(WIKI_SOURCE, 'g'), function (_, rawTitle, label) {
      const title = unesc(rawTitle).trim();
      const exists = ctx && ctx.resolve ? ctx.resolve(title) : true;
      return keep(
        '<a href="#" class="wikilink' + (exists ? '' : ' missing') +
        '" data-title="' + esc(title) + '">' + (label || rawTitle.trim()) + '</a>'
      );
    });

    // [text](https://...) — only http, https and mailto are allowed
    s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, function (_, label, url) {
      const clean = unesc(url);
      if (!/^(https?:\/\/|mailto:)/i.test(clean)) return label;
      return keep(
        '<a href="' + esc(clean) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>'
      );
    });

    // #tags
    s = s.replace(new RegExp(TAG_SOURCE, 'gm'), function (_, lead, tag) {
      return lead + keep(
        '<a href="#" class="tag" data-tag="' + esc(tag.toLowerCase()) + '">#' + tag + '</a>'
      );
    });

    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');

    // put the stashed pieces back (a few passes covers one level of nesting)
    for (let pass = 0; pass < 3 && s.indexOf('\u0000') !== -1; pass++) {
      s = s.replace(/\u0000(\d+)\u0000/g, function (_, i) {
        return stash[Number(i)];
      });
    }
    return s;
  }

  const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

  function render(md, ctx) {
    const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let para = [];
    let i = 0;

    function flushPara() {
      if (!para.length) return;
      out.push('<p>' + para.map(function (l) { return inline(l, ctx); }).join('<br>') + '</p>');
      para = [];
    }

    while (i < lines.length) {
      const line = lines[i];

      if (/^```/.test(line)) {
        flushPara();
        const buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) {
          buf.push(lines[i]);
          i++;
        }
        i++;
        out.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>');
        continue;
      }

      if (/^\s*$/.test(line)) {
        flushPara();
        i++;
        continue;
      }

      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      if (heading) {
        flushPara();
        const level = heading[1].length;
        out.push('<h' + level + '>' + inline(heading[2], ctx) + '</h' + level + '>');
        i++;
        continue;
      }

      if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        flushPara();
        out.push('<hr>');
        i++;
        continue;
      }

      if (/^>\s?/.test(line)) {
        flushPara();
        const buf = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          buf.push(lines[i].replace(/^>\s?/, ''));
          i++;
        }
        out.push('<blockquote>' + render(buf.join('\n'), ctx) + '</blockquote>');
        continue;
      }

      const first = line.match(LIST_ITEM);
      if (first) {
        flushPara();
        const tag = /\d/.test(first[2]) ? 'ol' : 'ul';
        const items = [];
        while (i < lines.length) {
          const m = lines[i].match(LIST_ITEM);
          if (!m) break;
          const depth = Math.min(4, Math.floor(m[1].replace(/\t/g, '  ').length / 2));
          let text = m[3];
          let cls = 'd' + depth;
          let box = '';
          const task = text.match(/^\[( |x|X)\]\s+(.*)$/);
          if (task) {
            const done = task[1] !== ' ';
            box = '<input type="checkbox" disabled' + (done ? ' checked' : '') + '> ';
            text = task[2];
            cls += done ? ' done' : ' task';
          }
          items.push('<li class="' + cls + '">' + box + inline(text, ctx) + '</li>');
          i++;
        }
        out.push('<' + tag + '>' + items.join('') + '</' + tag + '>');
        continue;
      }

      para.push(line);
      i++;
    }

    flushPara();
    return out.join('\n');
  }

  const api = {
    render: render,
    extractLinks: extractLinks,
    extractTags: extractTags,
    renameLinks: renameLinks,
    esc: esc
  };

  root.JournalMarkdown = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
