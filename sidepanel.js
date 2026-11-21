const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusBox = document.getElementById('statusBox');
const statusText = document.getElementById('statusText');
const logBox = document.getElementById('logBox');
const onlyIncomplete = document.getElementById('onlyIncomplete');
const startFromCurrent = document.getElementById('startFromCurrent');
const currentUrlEl = document.getElementById('currentUrl');
document.getElementById('version').textContent = 'v' + chrome.runtime.getManifest().version;

startFromCurrent.checked = localStorage.getItem('startFromCurrent') === 'true';
startFromCurrent.addEventListener('change', () => {
  localStorage.setItem('startFromCurrent', String(startFromCurrent.checked));
});

let panelWindowId;
let activeTabId = null;
let pageRevision = 0;
let statusRevision = 0;

function displayStatus(message, level = '', running = false, connected = true) {
  statusText.textContent = message;
  statusBox.className = 'status-box' + (level ? ' ' + level : '');
  startBtn.disabled = !connected || running;
  stopBtn.disabled = !connected || !running;
}

function log(message, level = '') {
  const line = document.createElement('div');
  line.className = level ? 'log-line log-' + level : 'log-line';
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  line.textContent = '[' + time + '] ' + message;
  logBox.appendChild(line);
  logBox.scrollTop = logBox.scrollHeight;
}

function isCourseUrl(value) {
  try {
    const { protocol, hostname } = new URL(value);
    return (protocol === 'http:' || protocol === 'https:') &&
      (hostname === 'chaoxing.com' || hostname.endsWith('.chaoxing.com'));
  } catch {
    return false;
  }
}

function sendToPage(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
}

async function connectPage(tabId) {
  try {
    const state = await sendToPage(tabId, { action: 'status' });
    if (typeof state?.isRunning === 'boolean') return state;
  } catch (error) {
    if (!/receiving end does not exist/i.test(error.message)) throw error;
  }

  // 安装或重新加载扩展后，已经打开的页面可能还没有内容脚本。
  const files = ['catalog.js', 'player.js', 'content.js'];
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files });
  } catch {
    // 部分页面内嵌了无权限访问的第三方框架，分别连接可访问的课程文档。
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    const children = (frames || []).filter(frame => frame.frameId !== 0 && isCourseUrl(frame.url));
    await Promise.allSettled(children.map(frame => chrome.scripting.executeScript({
      target: { tabId, documentIds: [frame.documentId] }, files
    })));
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files });
  }
  const state = await sendToPage(tabId, { action: 'status' });
  if (typeof state?.isRunning !== 'boolean') throw new Error('课程页面未响应');
  return state;
}

function showState(state) {
  const message = state.message || (state.isRunning ? '正在自动播放中…' : '已连接 · 准备就绪');
  displayStatus(message, state.level || (state.isRunning ? 'running' : ''), state.isRunning);
}

async function refreshTabInfo() {
  const page = ++pageRevision;
  const previousTabId = activeTabId;
  activeTabId = null;
  displayStatus('正在连接页面…', '', false, false);
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId: panelWindowId });
    if (page !== pageRevision) return;
    if (previousTabId !== tab?.id) logBox.replaceChildren();
    const courseUrl = isCourseUrl(tab?.url) ? new URL(tab.url) : null;
    const displayUrl = courseUrl ? courseUrl.origin + courseUrl.pathname : '';
    currentUrlEl.textContent = displayUrl;
    currentUrlEl.title = displayUrl;
    if (!courseUrl) {
      displayStatus('请切换到超星课程章节页面', '', false, false);
      return;
    }

    activeTabId = tab.id;
    const version = ++statusRevision;
    const state = await connectPage(tab.id);
    if (page === pageRevision && version === statusRevision) showState(state);
  } catch (error) {
    if (page !== pageRevision) return;
    displayStatus('连接失败，请确认扩展有权访问此页面后重试', 'error', false, activeTabId !== null);
    log(error.message, 'error');
  }
}

async function controlPage(action) {
  if (activeTabId === null) return;
  const page = pageRevision;
  const tabId = activeTabId;
  const version = ++statusRevision;
  if (action === 'start') logBox.replaceChildren();
  displayStatus(action === 'start' ? '正在启动…' : '正在停止…', '', false, false);
  try {
    await connectPage(tabId);
    if (page !== pageRevision) return;
    const message = { action };
    if (action === 'start') {
      message.config = {
        ONLY_INCOMPLETE: onlyIncomplete.checked,
        START_FROM_CURRENT: startFromCurrent.checked
      };
    }
    const response = await sendToPage(tabId, message);
    if (page !== pageRevision || version !== statusRevision) return;
    if (typeof response?.isRunning !== 'boolean') throw new Error('课程页面未返回状态');
    showState(response);
    if (response.success === false) log(response.message || '操作失败', 'error');
  } catch (error) {
    if (page !== pageRevision || version !== statusRevision) return;
    displayStatus('操作失败，请确认页面已加载后重试', 'error', action === 'stop');
    log(error.message, 'error');
  }
}

startBtn.addEventListener('click', () => controlPage('start'));
stopBtn.addEventListener('click', () => controlPage('stop'));

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!sender.tab || sender.tab.id !== activeTabId ||
      sender.tab.windowId !== panelWindowId || sender.frameId !== 0) return;
  if (message.type === 'log') log(message.text, message.level);
  if (message.type === 'status') {
    statusRevision++;
    displayStatus(message.text, message.level, message.running);
  }
});

chrome.tabs.onActivated.addListener(({ windowId }) => {
  if (windowId === panelWindowId) refreshTabInfo();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab.windowId !== panelWindowId || !tab.active) return;
  if (changeInfo.status === 'complete' || changeInfo.url) refreshTabInfo();
});

chrome.windows.getCurrent().then(window => {
  panelWindowId = window.id;
  return refreshTabInfo();
}).catch(error => {
  displayStatus('无法获取当前窗口', 'error', false, false);
  log(error.message, 'error');
});
