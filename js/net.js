// 點對點連線（PeerJS / WebRTC）。房主的瀏覽器就是伺服器：
// 客戶端 → 房主：{t:'hello'|'action'|'chat'}，房主 → 客戶端：{t:'lobby'|'state'|'error'|'chat'|'kick'}
/* global Peer */

const PREFIX = 'daxuanzhan-v1-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function genCode(len = 5) {
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

export function normalizeCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

const PEER_OPTS = {
  debug: 1,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
    ],
  },
};

function errorText(err) {
  const map = {
    'unavailable-id': '這個房間代碼已被使用',
    'peer-unavailable': '找不到這個房間（代碼錯誤或房主已離線）',
    network: '無法連到配對伺服器，請檢查網路',
    'server-error': '配對伺服器錯誤，請稍後再試',
    'socket-error': '配對伺服器連線失敗',
    'socket-closed': '配對伺服器連線中斷',
    'browser-incompatible': '此瀏覽器不支援 WebRTC',
    disconnected: '已與配對伺服器斷線',
  };
  return map[err?.type] || err?.message || String(err);
}

export class HostNet {
  constructor(code, { onReady, onData, onClose, onError }) {
    this.code = code;
    this.h = { onReady, onData, onClose, onError };
    this.conns = new Set();
  }

  start() {
    if (typeof Peer === 'undefined') {
      this.h.onError({ type: 'lib', text: '無法載入 PeerJS，請檢查網路連線' });
      return;
    }
    const peer = new Peer(PREFIX + this.code, PEER_OPTS);
    this.peer = peer;
    peer.on('open', () => this.h.onReady());
    peer.on('connection', (conn) => {
      conn.on('open', () => this.conns.add(conn));
      conn.on('data', (msg) => this.h.onData(conn, msg));
      conn.on('close', () => {
        this.conns.delete(conn);
        this.h.onClose(conn);
      });
      conn.on('error', () => {});
    });
    // 與配對伺服器斷線不影響已建立的 P2P 連線，但要重新連上才能接受新玩家
    peer.on('disconnected', () => {
      if (!peer.destroyed) setTimeout(() => !peer.destroyed && peer.reconnect(), 1500);
    });
    peer.on('error', (err) => this.h.onError({ type: err.type, text: errorText(err) }));
  }

  send(conn, msg) {
    if (conn && conn.open) conn.send(msg);
  }

  destroy() {
    this.peer?.destroy();
  }
}

export class ClientNet {
  constructor(code, { onOpen, onData, onClose, onError }) {
    this.code = code;
    this.h = { onOpen, onData, onClose, onError };
  }

  start() {
    if (typeof Peer === 'undefined') {
      this.h.onError({ type: 'lib', text: '無法載入 PeerJS，請檢查網路連線' });
      return;
    }
    const peer = new Peer(PEER_OPTS);
    this.peer = peer;
    let opened = false;
    peer.on('open', () => {
      const conn = peer.connect(PREFIX + this.code, { reliable: true, serialization: 'json' });
      this.conn = conn;
      const timer = setTimeout(() => {
        if (!opened) this.h.onError({ type: 'timeout', text: '連線逾時：可能是房間不存在，或雙方網路環境無法直接點對點連線' });
      }, 15000);
      conn.on('open', () => {
        opened = true;
        clearTimeout(timer);
        this.h.onOpen();
      });
      conn.on('data', (msg) => this.h.onData(msg));
      conn.on('close', () => this.h.onClose());
      conn.on('error', () => {});
    });
    peer.on('disconnected', () => {
      if (!peer.destroyed) setTimeout(() => !peer.destroyed && peer.reconnect(), 1500);
    });
    peer.on('error', (err) => this.h.onError({ type: err.type, text: errorText(err) }));
  }

  send(msg) {
    if (this.conn && this.conn.open) this.conn.send(msg);
  }

  destroy() {
    this.peer?.destroy();
  }
}
