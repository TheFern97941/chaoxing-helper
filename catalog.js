// Inspect and activate entries in this frame's own course catalog.
(() => {
  'use strict';

  const rows = '.posCatalog_select, .chapter_item, .ncells, h4';
  const identity = '[data-chapter-id], [data-knowledge-id], [data-chapterid], [data-knowledgeid], [chapterid], [knowledgeid]';
  const lessonLinks = 'a[href*="getTeacherAjax" i], [onclick*="getTeacherAjax" i], a[href*="chapterid=" i], a[href*="knowledgeid=" i]';
  const names = '.posCatalog_name, .clicktitle, .catalog_name, .articlename';
  const selected = '.posCatalog_active, .active, .current, .currents, [aria-current="page"], [aria-current="true"], [aria-selected="true"]';
  const teacherCall = /\bgetTeacherAjax\s*\(\s*['"]?(\d+)['"]?\s*,\s*['"]?(\d+)['"]?\s*,\s*['"]?(\d+)['"]?\s*\)/i;
  const teacherHref = new RegExp('^javascript:\\s*(?:window\\.)?' + teacherCall.source + '\\s*;?\\s*$', 'i');

  function chapterInUrl(href, doc) {
    if (!href || /^(?:javascript:|#)/i.test(href)) return null;
    try {
      const url = new URL(href, doc.baseURI);
      if (!['https:', 'http:'].includes(url.protocol)) return null;
      for (const [name, value] of url.searchParams) {
        if (/^(?:chapterid|knowledgeid)$/i.test(name) && /^\d+$/.test(value)) return value;
      }
    } catch {}
    return null;
  }

  function chapterKey(el, row) {
    for (const node of [el, row]) {
      for (const attr of ['onclick', 'href']) {
        const match = teacherCall.exec(node.getAttribute(attr) || '');
        if (match) return match[3];
      }
    }
    const linkId = chapterInUrl(el.getAttribute('href'), el.ownerDocument);
    if (linkId) return linkId;

    const boundary = row.parentElement?.matches('li, [id^="treeid" i], [id^="cur" i]') ? row.parentElement : row;
    for (let node = el; node; node = node.parentElement) {
      for (const name of ['data-chapter-id', 'data-knowledge-id', 'data-chapterid', 'data-knowledgeid', 'chapterid', 'knowledgeid', 'data-id']) {
        const value = node.getAttribute(name);
        if (value && /^\d+$/.test(value)) return value;
      }
      const match = /^(?:cur|treeid|c|knowledge(?:id)?|chapter(?:id)?|nodeid)[_=-]?(\d+)$/i.exec(node.id);
      if (match) return match[1];
      if (node === boundary) break;
    }
    return null;
  }

  function isIncomplete(row) {
    const count = row.querySelector('.jobUnfinishCount, .unfinish-num, .unfinished-num');
    const countText = (count?.value || count?.textContent || '').trim();
    if (/^\d+$/.test(countText)) return Number(countText) > 0;
    if (row.matches('.completed, .finished') || row.querySelector('.icon_yiwanc, .icon_Completed, [title="已完成"], [aria-label="已完成"]')) return false;
    const marker = row.querySelector('.jobCount, .catalog_points_yi, .orangeNew, .orange, [title*="未完成"], [aria-label*="未完成"]');
    if (!marker) return false;
    return !/^0+$/.test((marker.value || marker.textContent || '').trim());
  }

  function catalogRow(node) {
    // In the newer catalog an h4 may sit inside the actual selectable row.
    return node.closest('.posCatalog_select, .chapter_item') || node.closest('h4, .ncells, li');
  }

  function describe(candidate) {
    if (candidate.matches('input, select, textarea')) return null;
    const owner = catalogRow(candidate);
    const row = owner || candidate;
    const el = candidate.matches(lessonLinks) ? candidate :
      candidate.querySelector(lessonLinks) || candidate.querySelector('.clicktitle, a, [onclick], button, .posCatalog_name') || candidate;
    if (catalogRow(el) !== owner) return null;
    if (row.classList.contains('firstLayer') && !el.matches(lessonLinks)) return null;

    const key = chapterKey(el, row);
    if (!key) return null;
    const label = row.querySelector(names) || el;
    const title = (label.getAttribute('title') || el.getAttribute('title') || label.textContent || row.textContent).trim().replace(/\s+/g, ' ');
    return { key, title: title || '课时 ' + key, el, row };
  }

  function collect(doc, onlyIncomplete) {
    const found = new Map();
    // One query keeps mixed versions of the catalog in document order.
    for (const candidate of doc.querySelectorAll([rows, lessonLinks, identity].join(', '))) {
      const item = describe(candidate);
      if (item && !found.has(item.key) && (!onlyIncomplete || isIncomplete(item.row))) {
        found.set(item.key, item);
      }
    }
    return [...found.values()];
  }

  function resolve(item) {
    if (item.el.isConnected && item.row.isConnected && chapterKey(item.el, item.row) === item.key) return item;
    return collect(item.el.ownerDocument, false).find(entry => entry.key === item.key);
  }

  function hasSelection(item) {
    return item.row.matches(selected) || item.el.matches(selected) ||
      !!item.row.querySelector(`:is(${names}):is(${selected})`);
  }

  function markedKey(doc, entries) {
    const selectedEntry = entries?.find(hasSelection);
    if (selectedEntry) return selectedEntry.key;
    for (const node of doc.querySelectorAll(`:is(${rows}, ${lessonLinks}, ${identity}, ${names}):is(${selected})`)) {
      const entry = describe(catalogRow(node) || node);
      if (entry) return entry.key;
    }
    return null;
  }

  function urlKey(doc) {
    return chapterInUrl(doc.URL, doc);
  }

  function selection(item, allowUrl = true, entries) {
    const live = resolve(item);
    if (!live) return 'unknown';
    if (hasSelection(live)) return 'current';
    const doc = live.row.ownerDocument;
    const marked = markedKey(doc, entries);
    if (marked) return marked === live.key ? 'current' : 'other';
    return allowUrl && urlKey(doc) === live.key ? 'current' : 'unknown';
  }

  function queueStart(doc, entries, pageKey) {
    const marked = markedKey(doc, entries);
    const keys = marked ? [marked] : [urlKey(doc), pageKey];
    for (const key of keys) {
      const index = entries.findIndex(item => item.key === key);
      if (index >= 0) return { index, marked: !!marked };
    }
    return null;
  }

  function isCurrent(item) {
    return selection(item) === 'current';
  }

  async function activate(item) {
    const live = resolve(item);
    if (!live) return { success: false, message: '目录已更新，找不到此课时' };
    const { el, row } = live;
    const doc = el.ownerDocument;
    const link = el.closest('a[href]');
    const href = link?.getAttribute('href')?.trim() || '';
    const handler = el.closest('[onclick]');
    const hasRowHandler = handler && (row.contains(handler) || handler === row.parentElement);
    const pureCall = teacherHref.exec(href);
    if (pureCall && !hasRowHandler) {
      // The page owns getTeacherAjax. The worker calls this one known function in this frame.
      try {
        const reply = await chrome.runtime.sendMessage({ action: 'activateLesson', args: pureCall.slice(1) });
        return reply || { success: false, message: '未收到课时切换回执' };
      } catch (error) {
        return { success: false, message: error.message };
      }
    }

    const regularLink = href && !/^(?:javascript:|#)/i.test(href);
    if (regularLink) {
      const target = link.getAttribute('target') || doc.querySelector('base[target]')?.target;
      const targetsChild = target && [...doc.querySelectorAll('iframe[name], frame[name]')].some(frame => frame.name === target);
      if (!targetsChild) {
        // A bubbling Event reaches inline and delegated click listeners. Unlike a
        // MouseEvent, it has no native hyperlink activation if nobody handles it.
        const wasCurrent = isCurrent(live);
        const event = new Event('click', { bubbles: true, cancelable: true, composed: true });
        if (!el.dispatchEvent(event) || (!wasCurrent && isCurrent(live))) return { success: true };
        return { success: false, message: '此课时链接会打开另一个页面，请在该学习页启动播放' };
      }
    }
    el.click();
    return { success: true };
  }

  globalThis.chaoxingCatalog = { collect, activate, isCurrent, selection, urlKey, queueStart };
})();
