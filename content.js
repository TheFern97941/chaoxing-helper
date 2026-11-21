// The top document coordinates the queue. Each embedded document handles its own DOM.
(() => {
  if (globalThis.chaoxingControllerLoaded) return;
  globalThis.chaoxingControllerLoaded = true;

  const catalog = globalThis.chaoxingCatalog;
  const player = globalThis.chaoxingPlayer;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const isTop = window === window.top;
  let run = null;
  let state = { success: true, isRunning: false, message: '已连接 · 准备就绪', level: '' };

  function broadcast(message) {
    chrome.runtime.sendMessage(message).catch(() => {}); // The panel may be closed.
  }

  function log(text, level = 'info') {
    broadcast({ type: 'log', text, level });
  }

  function setStatus(message, level = '') {
    state = { success: level !== 'error', isRunning: !!run, message, level };
    broadcast({ type: 'status', text: message, level, running: !!run });
  }

  // Window indices are accessible between origins without reading another frame's DOM.
  function indexIn(parentWindow, childWindow) {
    for (let i = 0; i < parentWindow.frames.length; i++) {
      if (parentWindow.frames[i] === childWindow) return i;
    }
    return -1;
  }

  function frameLayout() {
    const hiddenChildren = [];
    for (const el of document.querySelectorAll('iframe, frame')) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0 || getComputedStyle(el).visibility !== 'visible') {
        hiddenChildren.push(indexIn(window, el.contentWindow));
      }
    }
    return { index: isTop ? -1 : indexIn(window.parent, window), hiddenChildren };
  }

  async function localCommand(command) {
    switch (command.op) {
      case 'catalog': {
        const all = catalog.collect(document, false);
        let items = command.onlyIncomplete && all.length ? catalog.collect(document, true) : all;
        let start = null;
        if (command.fromCurrent && all.length) {
          const match = catalog.queueStart(document, all, command.pageKey);
          if (match) {
            const { key, title } = all[match.index];
            start = { key, title, marked: match.marked };
            const eligible = new Set(items.map(item => item.key));
            items = all.slice(match.index).filter(item => eligible.has(item.key));
          } else {
            items = [];
          }
        }
        return { total: all.length, start, items: items.map(({ key, title }) => ({ key, title })),
          ...(command.fromCurrent ? frameLayout() : {}) };
      }
      case 'locate':
      case 'activate': {
        const entries = catalog.collect(document, false);
        const item = entries.find(row => row.key === command.key);
        if (!item) return { found: false };
        const selection = catalog.selection(item, command.allowUrl, entries);
        const current = selection === 'current';
        if (command.op === 'activate' && !current) return await catalog.activate(item);
        return { found: true, current, selection, success: true };
      }
      case 'videos': return { videos: player.list(), ...frameLayout() };
      case 'play': return player.play(command.token, command.id, command.src);
      case 'playStatus': return player.status(command.token);
      case 'stopVideo': player.stop(command.token); return { success: true };
    }
  }

  async function frames() {
    const response = await chrome.runtime.sendMessage({ action: 'listFrames' });
    if (!Array.isArray(response?.frames)) throw new Error(response?.message || '无法读取课程页面框架');
    return response.frames.filter(frame => {
      if (!frame.url) return false;
      const url = new URL(frame.url);
      return (['https:', 'http:'].includes(url.protocol) &&
        (url.hostname === 'chaoxing.com' || url.hostname.endsWith('.chaoxing.com'))) ||
        ['about:blank', 'about:srcdoc'].includes(url.href);
    });
  }

  function command(frame, request) {
    if (frame.frameId === 0) return localCommand(request);
    return chrome.runtime.sendMessage({ action: 'frameCommand', documentId: frame.documentId, command: request });
  }

  async function survey(request, documents) {
    const results = await Promise.all((documents || await frames()).map(async frame => {
      const data = await command(frame, request).catch(() => null);
      return data && data.success !== false ? { frame, ...data } : null;
    }));
    return results.filter(Boolean);
  }

  function check(task) {
    if (task.stopped) throw new Error('已停止');
  }

  async function findQueue(task, options) {
    const deadline = Date.now() + 7000;
    const request = { op: 'catalog', ...options, pageKey: options.fromCurrent ? catalog.urlKey(document) : null };
    let sawCatalog = false;
    do {
      check(task);
      const results = await survey(request);
      const catalogs = results.filter(result => result.total).sort((a, b) => b.total - a.total);
      if (catalogs.length) {
        if (!options.fromCurrent) return catalogs[0];
        sawCatalog = true;
        const visible = new Set(visibleDocuments(results));
        const shown = catalogs.filter(result => visible.has(result));
        const candidates = shown.length ? shown : catalogs;
        // A highlighted row is stronger evidence than an ID left in an address bar.
        const selected = candidates.find(result => result.start?.marked) || candidates.find(result => result.start);
        if (selected) return selected;
      }
      await sleep(350);
    } while (Date.now() < deadline);
    throw new Error(sawCatalog ? '未识别到当前选中的课时，请先在目录中选中一个课时，再点击开始播放' :
      '未识别到课时目录，请打开课程的章节学习页面');
  }

  async function locateLesson(queue, key, allowUrl) {
    const request = { op: 'locate', key, allowUrl };
    const row = await command(queue.frame, request).catch(() => null);
    if (row?.found) return row;
    // A course can redraw the whole iframe that owns its catalog between lessons.
    const match = (await survey(request)).find(result => result.found);
    if (!match) throw new Error('目录已更新，找不到该课时');
    queue.frame = match.frame;
    return match;
  }

  function visibleDocuments(results) {
    const byId = new Map(results.map(result => [result.frame.frameId, result]));
    return results.filter(result => {
      let child = result;
      while (byId.has(child.frame.parentFrameId)) {
        const parent = byId.get(child.frame.parentFrameId);
        if (child.index >= 0 && parent.hiddenChildren.includes(child.index)) return false;
        child = parent;
      }
      return true;
    });
  }

  async function videos() {
    const results = visibleDocuments(await survey({ op: 'videos' }));
    return results.flatMap(result => result.videos.map(video => ({ ...video, frame: result.frame })));
  }

  function sameElement(a, b) {
    return a.id === b.id && a.frame.documentId === b.frame.documentId;
  }

  function sameMedia(a, b) {
    return sameElement(a, b) && (!a.src || !b.src || a.src === b.src);
  }

  // A readyState or duration change alone never establishes a chapter change.
  async function waitForVideo(task, before, current, queue, key) {
    const deadline = Date.now() + 22000;
    let candidate = null;
    let selectedOther = false;
    do {
      check(task);
      const available = (await videos()).filter(video => {
        if (!video.visible || (task.previous && sameMedia(video, task.previous))) return false;
        const old = before.find(entry => sameElement(video, entry));
        return current || !old || !old.visible || !sameMedia(old, video);
      });
      available.sort((a, b) => Number(a.ended) - Number(b.ended) || Number(b.ready) - Number(a.ready));
      const best = available[0];
      if (best && candidate && sameMedia(candidate, best)) {
        const row = await command(queue.frame, { op: 'locate', key, allowUrl: !task.switched }).catch(() => null);
        selectedOther = row?.selection === 'other';
        if (!selectedOther) return best;
      }
      candidate = best;
      await sleep(350);
    } while (Date.now() < deadline);
    if (selectedOther) throw new Error('目录仍选中其他课时，未播放该视频');
    return null;
  }

  async function processLesson(task, queue, item) {
    const row = await locateLesson(queue, item.key, !task.switched);
    check(task);
    const before = await videos();
    check(task);
    let current = row.current || (!task.switched && row.selection === 'unknown' && item.key === queue.start?.key);
    if (!current) {
      const result = await command(queue.frame, { op: 'activate', key: item.key, allowUrl: !task.switched });
      if (!result?.success) throw new Error(result?.message || '无法切换课时');
      current = result.current === true;
      // An AJAX switch can leave the address bar pointing to the initially open lesson.
      if (!current) task.switched = true;
    }

    const video = await waitForVideo(task, before, current, queue, item.key);
    check(task);
    if (!video) throw new Error(current ? '未检测到当前课时的视频' : '未检测到新课时的视频，可能是非视频课时或页面未切换');
    task.previous = video;
    task.playingFrame = video.frame;
    const token = task.token;
    try {
      let reportedResumes = 0;
      let result = await command(video.frame, { op: 'play', id: video.id, src: video.src, token });
      while (result?.state === 'playing') {
        check(task);
        await sleep(400);
        check(task);
        result = await command(video.frame, { op: 'playStatus', token });
        if (result?.resumes > reportedResumes) {
          reportedResumes = result.resumes;
          log(item.title + ' · 检测到视频暂停，已尝试继续播放（第 ' + reportedResumes + ' 次）');
        }
      }
      check(task);
      if (result?.state !== 'ended') throw new Error(result?.message || '播放期间播放器已关闭');
    } finally {
      if (task.stopped) await command(video.frame, { op: 'stopVideo', token }).catch(() => {});
      task.playingFrame = null;
    }
  }

  async function execute(task, options) {
    let ended = 0;
    let skipped = 0;
    let summary;
    let level = '';
    try {
      const queue = await findQueue(task, options);
      if (queue.start) log('已选定起始课时：' + queue.start.title);
      if (queue.items.length === 0) {
        summary = queue.start ? '从当前课时起没有标记为未完成的课时' : '目录中没有标记为未完成的课时';
      } else {
        log('已识别 ' + queue.items.length + ' 个待处理课时');
        for (const [index, item] of queue.items.entries()) {
          check(task);
          const title = (index + 1) + '/' + queue.items.length + ' ' + item.title;
          setStatus('正在处理 ' + title, 'running');
          log(title);
          try {
            await processLesson(task, queue, item);
            ended++;
            log(item.title + ' · 视频已播放结束', 'success');
          } catch (error) {
            check(task);
            skipped++;
            log(item.title + ' · 已跳过：' + error.message, 'warn');
          }
        }
        summary = '播放结束 ' + ended + ' 个课时，跳过 ' + skipped + ' 个';
        if (ended === 0) level = 'error';
      }
    } catch (error) {
      summary = error.message;
      level = 'error';
    } finally {
      if (task.stopped) {
        summary = '已停止，播放结束 ' + ended + ' 个课时';
        level = '';
      }
      run = null;
      log(summary, task.stopped ? 'warn' : level || 'info');
      setStatus(summary, level);
    }
  }

  chrome.runtime.onMessage.addListener((request, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (request.action === 'frameTask') {
      localCommand(request).then(respond, error => respond({ success: false, message: error.message }));
      return true;
    }
    if (!isTop) return;
    if (request.action === 'status') {
      respond(state);
    } else if (request.action === 'start') {
      if (!run) {
        run = { token: String(Date.now()) + '-' + Math.random(), stopped: false };
        setStatus('正在读取课时目录…', 'running');
        void execute(run, {
          onlyIncomplete: request.config?.ONLY_INCOMPLETE !== false,
          fromCurrent: request.config?.START_FROM_CURRENT === true
        });
      }
      respond(state);
    } else if (request.action === 'stop') {
      if (run) {
        run.stopped = true;
        if (run.playingFrame) command(run.playingFrame, { op: 'stopVideo', token: run.token }).catch(() => {});
        setStatus('正在停止…');
      }
      respond(state);
    }
  });
})();
