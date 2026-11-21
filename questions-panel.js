(() => {
  const tabs = [...document.querySelectorAll('.feature-tabs [role="tab"]')];
  const collect = document.getElementById('collectQuestionsBtn');
  const cancel = document.getElementById('cancelQuestionsBtn');
  const copy = document.getElementById('copyQuestionsBtn');
  const statusBox = document.getElementById('questionsStatusBox');
  const status = document.getElementById('questionsStatus');
  const source = document.getElementById('questionsSource');
  const copyStatus = document.getElementById('questionsCopyStatus');
  const jsonField = document.getElementById('questionsJson');
  let rows = [];
  let controller = null;

  function selectTab(selected) {
    for (const tab of tabs) {
      const active = tab === selected;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      document.getElementById(tab.getAttribute('aria-controls')).hidden = !active;
    }
  }

  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', event => {
      let next;
      switch (event.key) {
        case 'ArrowLeft': next = (index + tabs.length - 1) % tabs.length; break;
        case 'ArrowRight': next = (index + 1) % tabs.length; break;
        case 'Home': next = 0; break;
        case 'End': next = tabs.length - 1; break;
        default: return;
      }
      event.preventDefault();
      selectTab(tabs[next]);
      tabs[next].focus();
    });
  }

  function showStatus(message, level = '') {
    status.textContent = message;
    statusBox.className = level ? 'status-box ' + level : 'status-box';
  }

  function updateControls() {
    collect.disabled = Boolean(controller);
    cancel.hidden = !controller;
    cancel.disabled = Boolean(controller?.signal.aborted);
    copy.disabled = Boolean(controller) || rows.length === 0;
  }

  collect.addEventListener('click', async () => {
    if (controller) return;
    controller = new AbortController();
    const { signal } = controller;
    updateControls();
    showStatus('正在读取当前标签页…');
    let started = false;
    try {
      const panelWindow = await chrome.windows.getCurrent();
      const [tab] = await chrome.tabs.query({ active: true, windowId: panelWindow.id });
      signal.throwIfAborted();
      if (!Number.isInteger(tab?.id) || !isCourseUrl(tab.url)) {
        throw new Error('请先切换到超星题目页。');
      }

      started = true;
      rows = [];
      jsonField.hidden = true;
      jsonField.value = '';
      copyStatus.textContent = '';
      source.hidden = false;
      source.textContent = '来源：' + (tab.title || new URL(tab.url).hostname);
      showStatus('正在查找题目…', 'running');
      rows = await collectChaoxingQuestions(tab.id, {
        signal,
        onProgress(progress) {
          rows = progress.rows;
          if (signal.aborted) return;
          const count = progress.total == null ? String(rows.length) : rows.length + ' / ' + progress.total;
          showStatus('已抓取 ' + count + ' 题', 'running');
        }
      });
      signal.throwIfAborted();
      showStatus(rows.length ? '抓取完成，共 ' + rows.length + ' 题。' : '当前页面没有可抓取的题目。');
    } catch (error) {
      const message = signal.aborted ? '已停止抓取。' : (error?.message || '抓取失败。');
      let retained = '';
      if (rows.length) {
        retained = started ? '已保留 ' + rows.length + ' 题，可复制。' : '上次抓取的 ' + rows.length + ' 题仍可复制。';
      }
      showStatus(message + (retained ? ' ' + retained : ''), signal.aborted ? '' : 'error');
    } finally {
      controller = null;
      updateControls();
    }
  });

  cancel.addEventListener('click', () => {
    if (!controller) return;
    controller.abort();
    updateControls();
    showStatus('正在停止抓取…');
  });

  copy.addEventListener('click', async () => {
    if (controller || !rows.length) return;
    const snapshot = rows;
    const json = JSON.stringify(snapshot, null, 2);
    try {
      await navigator.clipboard.writeText(json);
    } catch {
      if (snapshot !== rows || controller) return;
      jsonField.value = json;
      jsonField.hidden = false;
      jsonField.focus();
      jsonField.select();
      let copied = false;
      try { copied = document.execCommand('copy'); } catch {}
      if (!copied) {
        copyStatus.textContent = '请选中下方 JSON 并按 Ctrl+C 或 ⌘C 复制。';
        return;
      }
      copy.focus();
    }
    if (snapshot === rows && !controller) {
      jsonField.hidden = true;
      copyStatus.textContent = '已复制 ' + snapshot.length + ' 题的 JSON。';
    }
  });
})();
