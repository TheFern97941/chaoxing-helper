// Each frame owns its media elements. Only serializable identities cross frames.
(() => {
  if (globalThis.chaoxingPlayer) return;
  const ids = new WeakMap();
  let nextId = 0;
  let job = null;

  function source(video) {
    return video.currentSrc || video.src || video.querySelector('source')?.src || '';
  }

  function list() {
    return Array.from(document.querySelectorAll('video'), video => {
      if (!ids.has(video)) ids.set(video, ++nextId);
      const rect = video.getBoundingClientRect();
      return {
        id: ids.get(video),
        src: source(video),
        visible: rect.width > 0 && rect.height > 0 && getComputedStyle(video).visibility === 'visible',
        ready: video.readyState >= HTMLMediaElement.HAVE_METADATA,
        ended: video.ended
      };
    });
  }

  const resumeIntervalMs = 1000;
  const stallTimeoutMs = 30000;

  function ownsVideo(task) {
    return task.video.isConnected && (!task.src || source(task.video) === task.src);
  }

  function finish(task, state, message) {
    task.listeners.abort();
    task.state = state;
    task.message = message;
  }

  function stop(token) {
    if (job?.token === token && job.state === 'playing') {
      finish(job, 'stopped', '已停止播放');
      if (ownsVideo(job)) job.video.pause();
    }
  }

  async function requestPlay(task, initial = false) {
    const video = task.video;
    task.pending = true;
    try {
      try {
        await video.play();
      } catch (error) {
        // A pause during a seek can interrupt even the initial play() promise.
        if (task.listeners.signal.aborted || !ownsVideo(task)) return;
        if (error.name === 'AbortError' && video.paused) return;
        const button = initial && video.paused && video.closest('.video-js, .ans-attach-ct, .prism-player')
          ?.querySelector('.vjs-big-play-button, .playButton, .prism-big-play-btn');
        if (!button) throw error;
        button.click();
        await video.play();
      }
    } catch (error) {
      if (task.listeners.signal.aborted || !ownsVideo(task)) return;
      if (error.name === 'AbortError' && video.paused) return;
      if (initial) finish(task, 'error', '播放器未能开始播放：' + error.message);
      else task.resumeError = error.message;
    } finally {
      task.pending = false;
    }
  }

  function play(token, id, expectedSrc) {
    const video = Array.from(document.querySelectorAll('video')).find(el => ids.get(el) === id);
    if (!video || (expectedSrc && source(video) !== expectedSrc)) {
      return { state: 'error', message: '播放器已切换' };
    }
    if (job) stop(job.token);
    const listeners = new AbortController();
    const task = {
      token, video, listeners, src: source(video), state: 'playing', message: '',
      time: video.currentTime, lastProgress: performance.now(), started: false, pending: false,
      resumes: 0, retryAt: 0, resumeError: ''
    };
    job = task;
    const listen = (event, handler) => video.addEventListener(event, handler, { signal: listeners.signal });

    // Seek only once. Resuming always plays from the current position.
    function onPlaying() {
      if (task.started || !ownsVideo(task)) return;
      task.started = true;
      if (!task.src) task.src = source(video);
      const target = video.duration - 1.5;
      if (!Number.isFinite(target) || target <= video.currentTime) return;
      for (let i = 0; i < video.seekable.length; i++) {
        if (video.seekable.start(i) <= target && target <= video.seekable.end(i)) {
          try { video.currentTime = target; } catch {}
          break;
        }
      }
    }
    listen('playing', onPlaying);
    listen('seeked', () => { task.time = video.currentTime; });
    listen('pause', () => {
      // A natural end can dispatch pause and ended back-to-back.
      task.retryAt = Math.max(task.retryAt, performance.now() + 250);
    });
    listen('ended', event => {
      // Some players rewind in their own ended listener before ours runs.
      if (task.started && ownsVideo(task) && (event.isTrusted || video.ended)) {
        finish(task, 'ended', '视频已播放结束');
      }
    });
    listen('error', () => finish(task, 'error', video.error?.message || '视频加载失败'));

    video.muted = true;
    if (!video.paused && video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) onPlaying();
    void requestPlay(task, true);
    return { state: task.state, message: task.message };
  }

  function resumeIfDue(task, now) {
    if (now < task.retryAt) return;
    // Measure progress from this attempt so repeated immediate pauses cannot add up.
    task.time = task.video.currentTime;
    task.retryAt = now + resumeIntervalMs;
    task.resumes++;
    task.resumeError = '';
    void requestPlay(task);
  }

  function status(token) {
    if (job?.token !== token) return { state: 'error', message: '播放器任务已失效' };
    if (job.state === 'playing') {
      const video = job.video;
      const now = performance.now();
      if (!ownsVideo(job)) {
        finish(job, 'error', '播放期间课时或视频已切换');
      } else if (video.error) {
        finish(job, 'error', video.error.message || '视频加载失败');
      } else if (job.started && video.ended) {
        finish(job, 'ended', '视频已播放结束');
      } else {
        // A seek or an immediately interrupted play() does not renew the wait.
        if (!video.seeking && video.currentTime >= job.time + 0.1) {
          job.time = video.currentTime;
          job.lastProgress = now;
          job.resumeError = '';
        }
        if (now - job.lastProgress >= stallTimeoutMs) {
          const detail = job.resumeError ? '：' + job.resumeError : '，请检查播放器';
          finish(job, 'error', '视频连续 30 秒没有播放进度' + detail);
          video.pause();
        } else if (video.paused && !video.ended && !video.seeking && !job.pending) {
          resumeIfDue(job, now);
        }
      }
    }
    return { state: job.state, message: job.message, resumes: job.resumes };
  }

  globalThis.chaoxingPlayer = { list, play, status, stop };
})();
