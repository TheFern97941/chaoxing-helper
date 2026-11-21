// Runs in the question document's isolated world. Navigation uses its visible controls.
function inspectQuestionDocument(command) {
  const visible = el => el.getClientRects().length > 0 &&
    getComputedStyle(el).visibility !== 'hidden' && !el.closest('[hidden],[inert],[aria-hidden="true"]');
  const text = el => el.innerText.trim();
  const usable = el => !el.matches(':disabled,[disabled],[aria-disabled="true"],.disabled,.disable') &&
    !el.closest('[inert],.disabled,[aria-disabled="true"]');
  const tables = [...document.querySelectorAll('.mark_table')].filter(visible);
  const questions = [...document.querySelectorAll('.questionLi')].filter(visible);
  const roots = questions.length > tables.length ? questions : tables;
  if (!roots.length) return null;
  const key = Symbol.for('chaoxing.questionView');
  const last = globalThis[key];
  if (last?.root !== roots[0]) {
    last?.observer.disconnect();
    const view = { root: roots[0], revision: (last?.revision || 0) + 1 };
    view.observer = new MutationObserver(() => { view.revision++; });
    view.observer.observe(view.root, { childList: true, characterData: true, subtree: true });
    globalThis[key] = view;
  }

  const url = new URL(location.href);
  const paper = JSON.stringify([url.origin, url.pathname, ...['courseId', 'classId', 'id', 'examId', 'workId']
    .map(key => url.searchParams.get(key))]);
  const cards = new Map();
  let selected = null;
  const current = '[aria-current="true"],[aria-current="page"],[aria-current="step"],.current,.active,.cur,.on';
  const selector = [
    '[data-question-index]', '[onclick*="getTheQuestionByStart"]', 'a[href*="getTheQuestionByStart"]',
    '.answerCard li', '.answerCard_list li', '.answerSheet li', '.answer-sheet li', '.answer-card li',
    '[aria-label="答题卡"] li', 'li a[href*="start="]'
  ].join(',');
  const controls = new Set(document.querySelectorAll(selector));
  // Older answer cards have no container label, just sibling numbered items and li.current.
  for (const marker of document.querySelectorAll('li.current')) {
    if (!visible(marker) || !/^\d+$/.test(text(marker)) || marker.closest('.mark_table,.questionLi')) continue;
    const group = [...marker.parentElement.children];
    if (group.length > 1 && group.every(li => li.matches('li') && /^\d+$/.test(li.textContent.trim()))) {
      for (const item of group) controls.add(item);
    }
  }
  for (const el of controls) {
    if (!visible(el)) continue;
    if (el.closest('.mark_table,.questionLi') && !el.closest('[aria-label="答题卡"],.answerCard,.answerSheet')) continue;
    const label = text(el);
    if (!/^\d+$/.test(label)) continue;
    const index = Number(label) - 1;
    if (!Number.isSafeInteger(index) || index < 0) continue;
    const target = el.querySelector('a,button') || el;
    if (target.matches('a[href]') && /^https?:$/.test(target.protocol) && target.origin !== url.origin) continue;
    cards.set(index, target);
    if (el.matches(current) || el.closest('li')?.matches(current) || target.matches(current)) selected = index;
  }

  // Some layouts expose only previous/next links, without a numbered answer card.
  let prev;
  let next;
  for (const el of document.querySelectorAll('a,button,input[type="button"],[role="button"]')) {
    if (!visible(el) || !usable(el) || el.closest('.answerBg,[role="radio"],[role="option"]')) continue;
    const label = (el.value || text(el) || el.getAttribute('aria-label') || '').replace(/\s+/g, '');
    if (label === '上一题') prev = el;
    if (label === '下一题') next = el;
  }
  const start = url.searchParams.get('start');
  const index = selected ?? (start !== null && /^\d+$/.test(start) ? Number(start) : null);
  const contents = roots.map(text);
  const indices = [...cards.keys()].sort((a, b) => a - b);
  if (command) {
    if (paper !== command.paper || index !== command.index || contents[0] !== command.first) {
      throw new Error('题目页已变化，请重新开始抓取。');
    }
    const target = command.move === 'prev' ? prev : command.move === 'next' ? next : cards.get(command.move);
    if (!target || !usable(target) || target.closest('a[download],a[target="_blank"]')) {
      throw new Error('页面上的目标题号当前不可用。');
    }
    target.click();
    return true;
  }
  return { paper, index, contents, indices, revision: globalThis[key].revision, prev: !!prev, next: !!next };
}

async function collectChaoxingQuestions(tabId, { onProgress, signal }) {
  function check() { signal.throwIfAborted(); }
  async function inspect(target, command = null) {
    check();
    const [entry] = await chrome.scripting.executeScript({
      target: { tabId, ...target }, func: inspectQuestionDocument, args: [command]
    });
    check();
    if (!entry?.result) return null;
    return { ...entry.result, frameId: entry.frameId, documentId: entry.documentId };
  }

  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  const candidates = (frames || []).filter(frame => isCourseUrl(frame.url));
  const snapshots = await Promise.allSettled(candidates.map(frame => inspect({ documentIds: [frame.documentId] })));
  check();
  const found = snapshots.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : []);
  if (!found.length) throw new Error('当前页面没有可读取的题目。请打开超星题目页，等待题干出现后再试。');
  if (found.length !== 1) throw new Error('当前标签包含多个题目页面，请单独打开要抓取的题目页。');

  let page = found[0];
  const { paper, frameId } = page;
  const rows = new Map();
  const ordered = () => [...rows].sort(([a], [b]) => a - b).map(([start, content]) => ({ start, content }));
  const known = new Set(page.indices);
  const progress = () => onProgress({ rows: ordered(), total: known.size || null });

  async function move(control, wanted) {
    const before = page;
    check();
    await chrome.scripting.executeScript({
      target: { tabId, documentIds: [before.documentId] }, func: inspectQuestionDocument,
      args: [{ paper, index: before.index, first: before.contents[0], move: control }]
    });
    let previousSample;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      check();
      await new Promise(resolve => setTimeout(resolve, 180));
      let after;
      try {
        after = await inspect({ frameIds: [frameId] });
      } catch (error) {
        check();
        if (!/frame|document|context/i.test(error.message)) throw error;
      }
      if (!after) { previousSample = null; continue; }
      if (after.paper !== paper) throw new Error('已离开原题目页面，抓取已停止。');
      const first = after.contents[0];
      const changed = before.documentId !== after.documentId || before.revision !== after.revision || first !== before.contents[0];
      const rightIndex = wanted == null || after.index == null || after.index === wanted;
      if (first && rightIndex && changed) {
        const sample = JSON.stringify([after.documentId, after.revision, after.index, after.contents]);
        if (previousSample === sample) {
          page = after;
          for (const i of page.indices) known.add(i);
          return;
        }
        previousSample = sample;
      } else {
        previousSample = null;
      }
    }
    throw new Error('翻题后未能确认新题目，已保留本次抓取的内容。');
  }

  function save(start) {
    for (const [offset, content] of page.contents.entries()) {
      if (!content) throw new Error('题目内容为空，已保留此前读取的题目。');
      const i = start + offset;
      if (rows.has(i) && rows.get(i) !== content) throw new Error('同一题号的内容发生变化，抓取已停止。');
      rows.set(i, content);
    }
    progress();
  }

  // A review sheet may render every question together with its entire answer card.
  if (page.contents.length > 1 && page.contents.length === known.size &&
      [...known].every((_, i) => known.has(i))) {
    save(0);
    return ordered();
  }

  if (page.index !== null) save(page.index);
  if (known.has(0) && page.index !== 0) {
    await move(0, 0);
  } else {
    const backwards = new Set();
    while (page.prev && page.index !== 0) {
      const key = JSON.stringify([page.index, page.contents]);
      if (backwards.has(key)) throw new Error('上一题链接返回了重复页面，抓取已停止。');
      backwards.add(key);
      await move('prev', page.index == null ? null : page.index - 1);
    }
    if (page.index > 0) throw new Error('当前页面没有可用的首题入口。');
  }

  let start = 0;
  const visited = new Set();
  for (;;) {
    check();
    start = page.index ?? start;
    const key = JSON.stringify([page.index, page.contents]);
    if (visited.has(key)) throw new Error('翻题后返回了重复页面，已保留已抓取的题目。');
    visited.add(key);
    save(start);
    const wanted = start + page.contents.length;
    if (page.indices.includes(wanted)) {
      await move(wanted, wanted);
    } else if (page.next) {
      await move('next', wanted);
    } else {
      if ([...known].some(i => !rows.has(i))) throw new Error('还有题号未读取，当前页面未提供可用的翻题入口。');
      return ordered();
    }
    start = wanted;
  }
}
