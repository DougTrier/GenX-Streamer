'use strict';
const pairForm = document.getElementById('pair');
const view = document.getElementById('view');
const control = document.getElementById('control');
const status = document.getElementById('status');
const video = document.getElementById('video');
let channels = [],
  commandOwner = null,
  pollOwner = null,
  startup = null;
let paired = false,
  role = 'viewer',
  paused = true,
  revision = null,
  generation = 0,
  sequence = 0,
  engine = null,
  timer = null;
let epoch = 0,
  disposed = false;
const pending = new Set();
const message = (text) => {
  status.textContent = text;
};
const canceled = () => new DOMException('This connection is no longer active.', 'AbortError');
const current = (owner) => {
  if (disposed || document.hidden || owner !== epoch) throw canceled();
};
const unload = () => {
  generation++;
  if (startup) {
    startup.controller.abort();
    clearTimeout(startup.deadline);
    startup = null;
  }
  const previous = engine;
  engine = null;
  video.removeAttribute('src');
  if (previous) previous.destroy();
  video.pause();
  video.load();
};
function invalidate() {
  epoch++;
  clearTimeout(timer);
  timer = null;
  for (const request of pending) request.abort();
  pollOwner = null;
  commandOwner = null;
  paused = true;
  unload();
}
async function request(path, body, owner, limit = 16384) {
  current(owner);
  const controller = new AbortController();
  pending.add(controller);
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 10000);
  try {
    const options = { credentials: 'same-origin', signal: controller.signal };
    if (body !== undefined)
      Object.assign(options, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const response = await fetch(path, options);
    current(owner);
    if (!response.ok)
      throw new Error(
        response.status === 401
          ? 'Your invitation has expired. Connect again.'
          : 'The host could not confirm this request.',
      );
    const reader = response.body?.getReader();
    if (!reader) throw new Error('The host returned an incomplete response.');
    const chunks = [];
    let length = 0;
    try {
      while (true) {
        const item = await reader.read();
        current(owner);
        if (controller.signal.aborted) throw canceled();
        if (item.done) break;
        length += item.value.length;
        if (length > limit) throw new Error('The host response exceeded its safe limit.');
        chunks.push(item.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    current(owner);
    if (controller.signal.aborted) throw canceled();
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw new Error('The host returned an unsupported response.');
    }
  } catch (error) {
    current(owner);
    if (timedOut) throw new Error('The host did not respond in time. Try again.');
    if (error.name === 'AbortError') throw canceled();
    const safe = [
      'Your invitation has expired. Connect again.',
      'The host could not confirm this request.',
      'The host returned an incomplete response.',
      'The host response exceeded its safe limit.',
      'The host returned an unsupported response.',
    ];
    throw new Error(
      safe.includes(error.message)
        ? error.message
        : 'The host could not complete this request. Try again.',
    );
  } finally {
    clearTimeout(deadline);
    pending.delete(controller);
  }
}
async function load(path, lifecycle) {
  current(lifecycle);
  unload();
  const owner = generation;
  const owned = () => lifecycle === epoch && !disposed && !document.hidden && owner === generation && !paused;
  const controller = new AbortController();
  let timedOut = false;
  const start = { controller, deadline: null };
  startup = start;
  const interrupted = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(canceled()), { once: true });
  });
  void interrupted.catch(() => {});
  start.deadline = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 10000);
  try {
    if (window.Hls && Hls.isSupported()) {
      engine = new Hls({ maxBufferLength: 20, maxMaxBufferLength: 30, backBufferLength: 10 });
      engine.on(Hls.Events.ERROR, (_event, data) => {
        if (owned() && data.fatal) {
          paused = true;
          unload();
          message('Playback stopped. Ask the host to check this channel.');
        }
      });
      engine.loadSource(path);
      engine.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) video.src = path;
    else {
      paused = true;
      unload();
      message('This browser cannot play this stream. Use a supported browser.');
      return;
    }
    await Promise.race([video.play(), interrupted]);
    if (owned()) message('Following the host channel.');
  } catch (error) {
    if (owned() && (timedOut || error.name !== 'AbortError')) {
      paused = true;
      unload();
      message(timedOut ? 'Playback did not begin in time. Press Watch to try again.' : 'Press Watch to begin watching.');
    }
  } finally {
    clearTimeout(start.deadline);
    if (startup === start) startup = null;
  }
}
async function poll() {
  if (!paired || disposed || document.hidden || pollOwner !== null || commandOwner !== null) return;
  const owner = epoch;
  pollOwner = owner;
  try {
    const state = await request('/state', { paused: role === 'controller' || paused }, owner);
    current(owner);
    if (
      !state ||
      typeof state !== 'object' ||
      Array.isArray(state) ||
      (state.revision === null
        ? state.mediaPath !== null
        : !Number.isSafeInteger(state.revision) ||
          state.revision <= 0 ||
          (state.mediaPath !== null &&
            (typeof state.mediaPath !== 'string' ||
              !new RegExp(`^/media/${state.revision}/[A-Za-z0-9_-]+$`).test(state.mediaPath))))
    )
      throw new Error('The host returned an unsupported channel state.');
    if (role === 'controller') revision = state.revision;
    if (role === 'viewer' && state.revision !== revision) {
      revision = state.revision;
      if (state.mediaPath && !paused) void load(state.mediaPath, owner);
      else unload();
    }
  } catch (error) {
    if (owner === epoch && !disposed && !document.hidden && error.name !== 'AbortError') {
      paired = false;
      invalidate();
      pairForm.hidden = false;
      view.hidden = true;
      control.hidden = true;
      message(error.message);
    }
  } finally {
    if (pollOwner === owner) pollOwner = null;
    if (owner === epoch && paired && !disposed && !document.hidden && commandOwner === null) {
      clearTimeout(timer);
      timer = setTimeout(poll, 2000);
    }
  }
}
pairForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (disposed || document.hidden) return;
  invalidate();
  paired = false;
  channels = [];
  const owner = epoch;
  const button = pairForm.querySelector('button');
  button.disabled = true;
  try {
    const result = await request(
      '/pair',
      { secret: document.getElementById('secret').value.trim() },
      owner,
    );
    current(owner);
    if (!result || !['viewer', 'controller'].includes(result.role))
      throw new Error('The host returned an unsupported invitation.');
    let nextChannels = [];
    if (result.role === 'controller') {
      nextChannels = await request('/channels', undefined, owner, 8 * 1024 * 1024);
      current(owner);
      if (
        !Array.isArray(nextChannels) ||
        nextChannels.length > 100000 ||
        nextChannels.some(
          (channel) =>
            !channel ||
            typeof channel.id !== 'string' ||
            !channel.id.length ||
            channel.id.length > 256 ||
            typeof channel.name !== 'string' ||
            !channel.name.trim() ||
            channel.name.length > 160,
        )
      )
        throw new Error('The host returned unsupported channels.');
      if (new Set(nextChannels.map((channel) => channel.id)).size !== nextChannels.length)
        throw new Error('The host returned duplicate channels.');
    }
    current(owner);
    document.getElementById('secret').value = '';
    role = result.role;
    paired = true;
    sequence = 0;
    channels = nextChannels;
    renderChannels();
    paused = true;
    revision = null;
    pairForm.hidden = true;
    view.hidden = role !== 'viewer';
    control.hidden = role !== 'controller';
    message(
      role === 'viewer'
        ? 'Connected. Press Watch to follow the host.'
        : 'Controller connected. Channel changes need host confirmation.',
    );
    await poll();
  } catch (error) {
    if (owner === epoch && !disposed && !document.hidden && error.name !== 'AbortError')
      message(error.message);
  } finally {
    if (owner === epoch && !disposed && !document.hidden) button.disabled = false;
  }
});
document.getElementById('watch').addEventListener('click', async () => {
  if (!paired || disposed || document.hidden) return;
  paused = false;
  revision = null;
  clearTimeout(timer);
  await poll();
});
video.addEventListener('pause', () => {
  if (video.readyState > 0 && (video.getAttribute('src') || engine)) {
    paused = true;
    unload();
  }
});
video.addEventListener('play', () => {
  if (!disposed && !document.hidden && paired && !paused && !video.paused && (engine || video.getAttribute('src'))) {
    paused = false;
    if (engine) engine.startLoad();
  }
});
async function hostCommand(action, payload = {}) {
  if (commandOwner !== null || !paired || role !== 'controller' || disposed || document.hidden)
    return;
  const owner = epoch;
  commandOwner = owner;
  const buttons = control.querySelectorAll('button');
  for (const button of buttons) button.disabled = true;
  clearTimeout(timer);
  try {
    const result = await request(
      '/control',
      { sequence: ++sequence, revision: revision || 0, action, ...payload },
      owner,
    );
    current(owner);
    message(
      result.applied === true
        ? 'The host confirmed your request.'
        : 'The host could not confirm your request.',
    );
  } catch (error) {
    if (owner === epoch && !disposed && !document.hidden && error.name !== 'AbortError')
      message(error.message);
  } finally {
    if (commandOwner === owner) commandOwner = null;
    if (owner === epoch && !disposed && !document.hidden) {
      for (const button of buttons) button.disabled = false;
      if (paired) void poll();
    }
  }
}
control.addEventListener('submit', (event) => {
  event.preventDefault();
  void hostCommand('select', { channelId: document.getElementById('channel').value.trim() });
});
for (const button of control.querySelectorAll('[data-action]'))
  button.addEventListener('click', () => {
    void hostCommand(
      button.dataset.action,
      button.dataset.action === 'mute' ? { muted: button.dataset.muted === 'true' } : {},
    );
  });
document.getElementById('volume').addEventListener('change', (event) => {
  void hostCommand('volume', { volume: Number(event.target.value) });
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) invalidate();
  else if (!disposed) {
    pairForm.querySelector('button').disabled = false;
    for (const button of control.querySelectorAll('button')) button.disabled = false;
    if (paired) {
      message(
        role === 'viewer' ? 'Press Watch to resume following the host.' : 'Controller connected.',
      );
      void poll();
    }
  }
});
window.addEventListener('pagehide', () => {
  disposed = true;
  paired = false;
  invalidate();
});
function renderChannels() {
  const query = document.getElementById('search').value.toLocaleLowerCase();
  const matches = channels.filter((channel) => channel.name.toLocaleLowerCase().includes(query));
  const choices = document.getElementById('channel');
  choices.replaceChildren();
  for (const channel of matches.slice(0, 50)) {
    const option = document.createElement('option');
    option.value = channel.id;
    option.textContent = channel.name;
    choices.append(option);
  }
  document.getElementById('matches').textContent =
    matches.length > 50
      ? `Showing 50 of ${matches.length} matches. Type to narrow the list.`
      : `${matches.length} matching channels`;
}
document.getElementById('search').addEventListener('input', renderChannels);

