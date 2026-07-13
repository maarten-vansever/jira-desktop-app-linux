/* Atlassian Document Format <-> HTML helpers (renderer-global `ADF`). */
(function () {
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function markText(node) {
    let html = esc(node.text || '');
    for (const mark of node.marks || []) {
      switch (mark.type) {
        case 'strong': html = `<strong>${html}</strong>`; break;
        case 'em': html = `<em>${html}</em>`; break;
        case 'code': html = `<code>${html}</code>`; break;
        case 'strike': html = `<s>${html}</s>`; break;
        case 'underline': html = `<u>${html}</u>`; break;
        case 'subsup': html = mark.attrs && mark.attrs.type === 'sub' ? `<sub>${html}</sub>` : `<sup>${html}</sup>`; break;
        case 'textColor': html = `<span style="color:${esc(mark.attrs && mark.attrs.color)}">${html}</span>`; break;
        case 'link': {
          const href = mark.attrs && mark.attrs.href ? esc(mark.attrs.href) : '#';
          html = `<a href="${href}" class="ext-link">${html}</a>`;
          break;
        }
      }
    }
    return html;
  }

  function statusColorClass(c) {
    return ['blue', 'green', 'red', 'yellow', 'purple'].includes(c) ? c : 'g';
  }

  function children(node) {
    return (node.content || []).map(render).join('');
  }

  // Render context (e.g. issue attachments used to resolve media nodes).
  let ctx = {};

  function render(node) {
    if (!node || typeof node !== 'object') return '';
    switch (node.type) {
      case 'doc': return children(node);
      case 'paragraph': { const inner = children(node); return `<p>${inner || '&nbsp;'}</p>`; }
      case 'text': return markText(node);
      case 'heading': { const lv = Math.min(Math.max(node.attrs?.level || 1, 1), 4); return `<h${lv}>${children(node)}</h${lv}>`; }
      case 'bulletList': return `<ul>${children(node)}</ul>`;
      case 'orderedList': return `<ol>${children(node)}</ol>`;
      case 'listItem': return `<li>${children(node)}</li>`;
      case 'taskList': return `<ul class="task">${children(node)}</ul>`;
      case 'taskItem': {
        const done = node.attrs?.state === 'DONE';
        return `<li class="task">${done ? '☑' : '☐'} ${children(node)}</li>`;
      }
      case 'codeBlock': return `<pre><code>${(node.content || []).map((n) => esc(n.text || '')).join('')}</code></pre>`;
      case 'blockquote': return `<blockquote>${children(node)}</blockquote>`;
      case 'rule': return '<hr/>';
      case 'hardBreak': return '<br/>';
      case 'mention': return `<span class="mention">@${esc(node.attrs?.text?.replace(/^@/, '') || 'user')}</span>`;
      case 'emoji': return esc(node.attrs?.text || node.attrs?.shortName || '');
      case 'date': {
        const ts = Number(node.attrs?.timestamp);
        return `<code>${ts ? new Date(ts).toLocaleDateString() : ''}</code>`;
      }
      case 'status': {
        const color = statusColorClass(node.attrs?.color);
        return `<span class="adf-status ${color}">${esc(node.attrs?.text || '')}</span>`;
      }
      case 'inlineCard': {
        const url = node.attrs?.url || '';
        return `<a href="${esc(url)}" class="ext-link">${esc(url)}</a>`;
      }
      case 'panel': {
        const kind = esc(node.attrs?.panelType || 'info');
        return `<div class="panel ${kind}">${children(node)}</div>`;
      }
      case 'table': return `<div style="overflow-x:auto"><table>${children(node)}</table></div>`;
      case 'tableRow': return `<tr>${children(node)}</tr>`;
      case 'tableHeader': return `<th>${children(node)}</th>`;
      case 'tableCell': return `<td>${children(node)}</td>`;
      case 'mediaSingle':
      case 'mediaGroup': {
        const inner = children(node);
        return inner || `<div class="media-ph">🖼 Attachment (open issue in browser to view)</div>`;
      }
      case 'media': {
        const name = node.attrs?.alt || '';
        const att = (ctx.attachments || []).find((a) => a.filename === name && a.filename);
        if (att && /^image\//.test(att.mimeType || '') && att.content) {
          return `<img class="adf-img" data-att-src="${esc(att.content)}" alt="${esc(name)}" title="${esc(name)}"/>`;
        }
        if (att) return `<div class="media-ph">📎 ${esc(att.filename)}</div>`;
        return `<div class="media-ph">🖼 Attachment (open issue in browser to view)</div>`;
      }
      case 'expand':
      case 'nestedExpand': return `<div class="panel info"><strong>${esc(node.attrs?.title || 'Details')}</strong>${children(node)}</div>`;
      default: return children(node);
    }
  }

  function toHTML(adf, opts) {
    ctx = opts || {};
    if (adf == null || adf === '') return '';
    if (typeof adf === 'string') {
      // Jira Server / DC plain-text or wiki-markup body: render as escaped paragraphs,
      // resolving `!file.png!` image references against the issue's attachments.
      const atts = ctx.attachments || [];
      const inline = (p) =>
        esc(p).replace(/\n/g, '<br/>').replace(/!([^!|\n]+?)(?:\|[^!\n]*)?!/g, (m, name) => {
          const att = atts.find((a) => a.filename === name);
          if (att && /^image\//.test(att.mimeType || '') && att.content) {
            return `<img class="adf-img" data-att-src="${esc(att.content)}" alt="${esc(name)}" title="${esc(name)}"/>`;
          }
          return m;
        });
      ctx = {};
      return adf
        .split(/\n{2,}/)
        .map((p) => `<p>${inline(p)}</p>`)
        .join('');
    }
    try {
      return render(adf);
    } catch (e) {
      return `<p class="adf-empty">Could not render content.</p>`;
    } finally {
      ctx = {};
    }
  }

  function nodeText(node) {
    if (!node || typeof node !== 'object') return '';
    const kids = () => (node.content || []).map(nodeText).join('');
    switch (node.type) {
      case 'text': return node.text || '';
      case 'hardBreak': return '\n';
      case 'paragraph':
      case 'heading':
      case 'codeBlock':
      case 'mediaSingle':
      case 'mediaGroup': return kids() + '\n\n';
      case 'bulletList':
      case 'orderedList':
      case 'taskList': return kids() + '\n';
      case 'listItem':
      case 'taskItem': return '- ' + kids().replace(/\n+$/, '') + '\n';
      case 'rule': return '---\n\n';
      case 'mention': return '@' + (node.attrs?.text?.replace(/^@/, '') || 'user');
      case 'emoji': return node.attrs?.text || node.attrs?.shortName || '';
      case 'media': return node.attrs?.alt ? `!${node.attrs.alt}!` : '';
      case 'status': return node.attrs?.text || '';
      case 'inlineCard': return node.attrs?.url || '';
      default: return kids();
    }
  }

  function toText(adf) {
    if (adf == null) return '';
    if (typeof adf === 'string') return adf;
    try {
      return nodeText(adf).replace(/\n{3,}/g, '\n\n').trim();
    } catch {
      return '';
    }
  }

  function fromText(text) {
    const paragraphs = String(text || '')
      .split(/\n{2,}/)
      .map((para) => {
        const lines = para.split('\n');
        const content = [];
        lines.forEach((line, i) => {
          if (i > 0) content.push({ type: 'hardBreak' });
          if (line) content.push({ type: 'text', text: line });
        });
        return { type: 'paragraph', content: content.length ? content : [] };
      });
    return { type: 'doc', version: 1, content: paragraphs };
  }

  window.ADF = { toHTML, toText, fromText, esc };
})();
