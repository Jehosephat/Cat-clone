// WebSocket connection to the game server with automatic reconnection.

const SESSION_KEY = 'catan-online-session-v1';

export function loadSession() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY));
    return s && typeof s.room === 'string' && typeof s.token === 'string' ? s : null;
  } catch {
    return null;
  }
}

export function saveSession(session) {
  try {
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* storage unavailable */
  }
}

/**
 * @param {{onMessage: (msg: object) => void, onStatus: (status: 'connecting'|'open'|'closed') => void}} handlers
 */
export function createConnection({ onMessage, onStatus }) {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  let ws = null;
  let attempts = 0;
  let closed = false;
  let retryTimer = null;
  const queue = [];

  function connect() {
    onStatus('connecting');
    ws = new WebSocket(url);
    ws.onopen = () => {
      attempts = 0;
      onStatus('open');
      while (queue.length && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(queue.shift()));
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      onMessage(msg);
    };
    ws.onclose = () => {
      ws = null;
      if (closed) return;
      onStatus('closed');
      const delay = Math.min(1000 * 2 ** attempts, 10000);
      attempts += 1;
      retryTimer = setTimeout(connect, delay);
    };
  }

  // Reconnect promptly when a phone comes back from the background.
  const onVisible = () => {
    if (document.visibilityState === 'visible' && !ws && !closed) {
      clearTimeout(retryTimer);
      connect();
    }
  };
  document.addEventListener('visibilitychange', onVisible);

  connect();

  return {
    /** Send now if connected, otherwise queue until the socket opens. */
    send(msg) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      else queue.push(msg);
    },
    get isOpen() {
      return !!ws && ws.readyState === WebSocket.OPEN;
    },
    close() {
      closed = true;
      clearTimeout(retryTimer);
      document.removeEventListener('visibilitychange', onVisible);
      if (ws) ws.close();
    },
  };
}
