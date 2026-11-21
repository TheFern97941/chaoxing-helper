chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

function isCourseOrigin(value) {
  try {
    const { protocol, hostname } = new URL(value);
    return (protocol === 'https:' || protocol === 'http:') &&
      (hostname === 'chaoxing.com' || hostname.endsWith('.chaoxing.com'));
  } catch {
    return false;
  }
}

async function handlePageRequest(request, sender) {
  const tabId = sender.tab.id;

  if (request.action === 'activateLesson') {
    if (!sender.documentId || !Array.isArray(request.args) || request.args.length !== 3 ||
        !request.args.every(arg => typeof arg === 'string' && /^\d+$/.test(arg))) {
      throw new Error('课时链接缺少有效的课程、班级或课时编号');
    }

    const [execution] = await chrome.scripting.executeScript({
      target: { tabId, documentIds: [sender.documentId] },
      world: 'MAIN',
      args: [request.args],
      func: (args) => {
        if (typeof window.getTeacherAjax !== 'function') {
          return { success: false, message: '页面没有提供课时切换函数' };
        }
        try {
          window.getTeacherAjax(...args);
          return { success: true };
        } catch (error) {
          return { success: false, message: String(error.message || error) };
        }
      }
    });
    return execution?.result || { success: false, message: '课时所在页面已关闭或刷新' };
  }

  if (sender.frameId !== 0) throw new Error('请从课程主页操作');

  if (request.action === 'listFrames') {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    return {
      frames: (frames || [])
        .filter(frame => frame.documentId && frame.documentLifecycle === 'active')
        .map(({ frameId, documentId, url, parentFrameId }) => ({ frameId, documentId, url, parentFrameId }))
    };
  }

  if (!request.documentId || !request.command || typeof request.command !== 'object') {
    throw new Error('课程页面命令无效');
  }
  return await chrome.tabs.sendMessage(tabId, { ...request.command, action: 'frameTask' }, {
    documentId: request.documentId
  });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!['listFrames', 'frameCommand', 'activateLesson'].includes(request?.action)) return;
  if (sender.tab?.id == null || !(isCourseOrigin(sender.url) || isCourseOrigin(sender.origin))) return;

  handlePageRequest(request, sender).then(sendResponse, error => {
    sendResponse({ success: false, message: error.message });
  });
  return true;
});
