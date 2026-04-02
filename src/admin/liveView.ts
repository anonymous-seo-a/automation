/**
 * 母艦開発オフィス - リアルタイム可視化ページ
 *
 * SSE (Server-Sent Events) で開発エージェントの活動をリアルタイム配信し、
 * 会社のオフィスを覗くようにチームの動きを可視化するフロントエンド
 */
import { Router, Request, Response } from 'express';
import { getDB } from '../db/database';
import { devEventBus, DevActivityEvent } from '../events/devEvents';

// ── SSE クライアント管理 ──

const sseClients = new Set<Response>();

// イベントバスからSSE全クライアントへブロードキャスト
devEventBus.on('activity', (event: DevActivityEvent) => {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    try { client.write(data); } catch { sseClients.delete(client); }
  }
});

// 30秒ごとにハートビート送信（プロキシのタイムアウト防止）
setInterval(() => {
  for (const client of sseClients) {
    try { client.write(`:heartbeat\n\n`); } catch { sseClients.delete(client); }
  }
}, 30_000);

// ── ルート登録 ──

export function setupLiveRoutes(router: Router): void {
  // ライブオフィスページ
  router.get('/live', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderLivePage());
  });

  // SSEストリーム
  router.get('/live/events', (req: Request, res: Response) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`data: ${JSON.stringify({ type: 'connected', convId: '', timestamp: new Date().toISOString() })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  });

  // 現在の状態を返すAPI
  router.get('/live/api/state', (_req: Request, res: Response) => {
    try {
      const db = getDB();
      const conversations = db.prepare(
        `SELECT id, user_id, status, topic, hearing_log, requirements, generated_files, created_at, updated_at
         FROM dev_conversations ORDER BY updated_at DESC LIMIT 5`
      ).all();
      const recentLogs = db.prepare(
        `SELECT level, source, message, metadata, created_at
         FROM logs WHERE source = 'dev-agent' ORDER BY created_at DESC LIMIT 60`
      ).all();

      let teamConvs: unknown[] = [];
      try {
        teamConvs = db.prepare(
          `SELECT conversation_type, participants, log, decision, created_at
           FROM team_conversations ORDER BY created_at DESC LIMIT 20`
        ).all();
      } catch { /* table may not exist yet */ }

      let apiUsage: unknown = { cost: 0, calls: 0 };
      try {
        apiUsage = db.prepare(
          `SELECT COALESCE(SUM(cost_usd),0) as cost, COUNT(*) as calls
           FROM api_usage WHERE created_at >= date('now','start of day')`
        ).get();
      } catch { /* table may not exist yet */ }

      res.json({ conversations, recentLogs, teamConversations: teamConvs, apiUsage });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}

// ── HTML生成 ──

function renderLivePage(): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>母艦開発オフィス</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🏢</text></svg>">
<style>
/* ── Reset & Base ── */
*{margin:0;padding:0;box-sizing:border-box}
html{font-size:14px}
body{
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Hiragino Sans',sans-serif;
  background:#080c14;
  color:#e2e8f0;
  line-height:1.6;
  min-height:100vh;
  background:linear-gradient(160deg,#080c14 0%,#0f172a 40%,#0c1222 100%);
}
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:#334155;border-radius:3px}

/* ── CSS Variables ── */
:root{
  --pm-color:#a78bfa; --pm-rgb:167,139,250; --pm-bg:rgba(167,139,250,0.08);
  --eng-color:#22d3ee; --eng-rgb:34,211,238; --eng-bg:rgba(34,211,238,0.08);
  --rev-color:#fbbf24; --rev-rgb:251,191,36; --rev-bg:rgba(251,191,36,0.08);
  --dep-color:#34d399; --dep-rgb:52,211,153; --dep-bg:rgba(52,211,153,0.08);
  --sys-color:#94a3b8; --sys-rgb:148,163,184;
  --card-bg:#111827; --card-border:#1e293b;
}

/* ── Layout ── */
.office{max-width:1440px;margin:0 auto;padding:12px 16px 40px}

/* ── Header ── */
.office-header{
  display:flex;align-items:center;justify-content:space-between;
  padding:12px 0;margin-bottom:12px;
}
.office-header h1{
  font-size:18px;font-weight:700;color:#f1f5f9;
  display:flex;align-items:center;gap:8px;
}
.office-header h1 .logo{font-size:24px}
.header-right{display:flex;align-items:center;gap:16px;font-size:13px}
.header-right a{color:#64748b;text-decoration:none;transition:color .2s}
.header-right a:hover{color:#94a3b8}

.conn-badge{
  display:flex;align-items:center;gap:6px;
  padding:4px 10px;border-radius:20px;font-size:11px;font-weight:600;
  background:rgba(239,68,68,0.15);color:#f87171;
  transition:all .3s;
}
.conn-badge.connected{background:rgba(34,197,94,0.15);color:#4ade80}
.conn-dot{
  width:7px;height:7px;border-radius:50%;
  background:currentColor;
}
.conn-badge.connected .conn-dot{animation:blink 2s ease-in-out infinite}

/* ── Task Bar ── */
.task-bar{
  background:var(--card-bg);border:1px solid var(--card-border);border-radius:10px;
  padding:10px 16px;margin-bottom:12px;
  display:flex;align-items:center;gap:10px;font-size:13px;
}
.task-bar.hidden{display:none}
.task-topic{color:#e2e8f0;font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.task-status{
  padding:3px 10px;border-radius:12px;font-size:11px;font-weight:600;
  background:rgba(96,165,250,0.15);color:#93c5fd;
}
.task-status.deployed{background:rgba(52,211,153,0.15);color:#6ee7b7}
.task-status.failed{background:rgba(248,113,113,0.15);color:#fca5a5}
.task-status.stuck{background:rgba(251,191,36,0.15);color:#fde68a}

/* ── Pipeline ── */
.pipeline{
  display:flex;align-items:center;gap:4px;
  padding:14px 16px;margin-bottom:12px;
  background:var(--card-bg);border:1px solid var(--card-border);border-radius:10px;
  overflow-x:auto;-webkit-overflow-scrolling:touch;
}
.pipe-step{
  display:flex;align-items:center;gap:6px;
  padding:6px 14px;border-radius:20px;
  font-size:12px;font-weight:500;white-space:nowrap;
  background:rgba(255,255,255,0.03);color:#475569;
  transition:all .4s ease;flex-shrink:0;
}
.pipe-icon{font-size:14px}
.pipe-step.active{
  background:rgba(59,130,246,0.2);color:#93c5fd;font-weight:700;
  box-shadow:0 0 16px rgba(59,130,246,0.2);
}
.pipe-step.completed{background:rgba(16,185,129,0.15);color:#6ee7b7}
.pipe-step.failed-step{background:rgba(239,68,68,0.15);color:#fca5a5;font-weight:700;box-shadow:0 0 16px rgba(239,68,68,0.15)}
.pipe-step.stuck-step{background:rgba(251,191,36,0.2);color:#fde68a;font-weight:700;box-shadow:0 0 16px rgba(251,191,36,0.15)}
.pipe-arrow{color:#334155;font-size:13px;flex-shrink:0}

/* ── Agent Desks Grid ── */
.desks{
  display:grid;
  grid-template-columns:repeat(4,1fr);
  gap:12px;margin-bottom:12px;
}

/* ── Single Desk Card ── */
.desk{
  background:var(--card-bg);border:1px solid var(--card-border);border-radius:12px;
  padding:16px;position:relative;overflow:hidden;
  transition:border-color .4s,box-shadow .4s;
}
.desk::before{
  content:'';position:absolute;top:0;left:0;right:0;height:3px;
  background:var(--agent-color,#475569);opacity:0.2;
  transition:opacity .4s,box-shadow .4s;
}
.desk.active{border-color:color-mix(in srgb,var(--agent-color) 40%,transparent)}
.desk.active::before{
  opacity:1;
  box-shadow:0 0 20px color-mix(in srgb,var(--agent-color) 30%,transparent);
}

.desk[data-agent="pm"]{--agent-color:var(--pm-color);--agent-rgb:var(--pm-rgb);--agent-bg:var(--pm-bg)}
.desk[data-agent="engineer"]{--agent-color:var(--eng-color);--agent-rgb:var(--eng-rgb);--agent-bg:var(--eng-bg)}
.desk[data-agent="reviewer"]{--agent-color:var(--rev-color);--agent-rgb:var(--rev-rgb);--agent-bg:var(--rev-bg)}
.desk[data-agent="deployer"]{--agent-color:var(--dep-color);--agent-rgb:var(--dep-rgb);--agent-bg:var(--dep-bg)}

.desk-header{display:flex;align-items:center;gap:10px;margin-bottom:10px}
.desk-avatar{
  width:40px;height:40px;border-radius:50%;
  display:flex;align-items:center;justify-content:center;
  font-size:20px;background:var(--agent-bg);flex-shrink:0;
  transition:box-shadow .4s;
}
.desk.active .desk-avatar{
  box-shadow:0 0 12px color-mix(in srgb,var(--agent-color) 30%,transparent);
}
.desk-info{flex:1;min-width:0}
.desk-name{font-size:13px;font-weight:700;color:#f1f5f9}
.desk-role{font-size:11px;color:#64748b}
.status-dot{
  width:8px;height:8px;border-radius:50%;flex-shrink:0;
  background:#334155;transition:background .3s;
}
.status-dot.active{background:#22c55e;animation:pulse-dot 2s ease-in-out infinite}
.status-dot.error{background:#ef4444;animation:pulse-dot 1s ease-in-out infinite}
.status-dot.warning{background:#f59e0b}

.desk-activity{
  font-size:12px;color:#94a3b8;padding:8px 10px;
  background:rgba(255,255,255,0.02);border-radius:8px;
  min-height:36px;display:flex;align-items:center;
  transition:color .3s;
}
.desk.active .desk-activity{color:#cbd5e1}

.desk-detail{
  margin-top:8px;font-size:11px;color:#64748b;
  max-height:80px;overflow-y:auto;
}
.desk-detail:empty{display:none}
.desk-detail .file-tag{
  display:inline-block;padding:2px 8px;border-radius:4px;
  background:rgba(255,255,255,0.05);color:#94a3b8;font-family:monospace;
  font-size:11px;margin:2px 0;
}
.desk-detail .code-preview{
  font-family:'SF Mono',Monaco,Consolas,monospace;
  font-size:10px;color:#64748b;white-space:pre-wrap;word-break:break-all;
  background:rgba(0,0,0,0.3);padding:6px 8px;border-radius:6px;
  margin-top:4px;max-height:50px;overflow:hidden;
}

/* ── Typing Indicator ── */
.typing{display:inline-flex;align-items:center;gap:3px;margin-left:4px}
.typing span{
  width:5px;height:5px;border-radius:50%;
  background:var(--agent-color,#64748b);opacity:0.4;
  animation:typing-anim 1.4s ease-in-out infinite;
}
.typing span:nth-child(2){animation-delay:.2s}
.typing span:nth-child(3){animation-delay:.4s}

/* ── Chat Room ── */
.chat-room{
  background:var(--card-bg);border:1px solid var(--card-border);border-radius:12px;
  overflow:hidden;
}
.chat-header{
  padding:10px 16px;border-bottom:1px solid var(--card-border);
  font-size:13px;font-weight:600;color:#94a3b8;
  display:flex;align-items:center;justify-content:space-between;
}
.chat-count{
  font-size:11px;padding:2px 8px;border-radius:10px;
  background:rgba(255,255,255,0.05);color:#64748b;
}
.chat-messages{
  max-height:320px;overflow-y:auto;padding:8px 12px;
  scroll-behavior:smooth;
}
.chat-empty{
  text-align:center;padding:40px 20px;color:#334155;font-size:13px;
}

/* ── Chat Message ── */
.chat-msg{
  display:flex;align-items:flex-start;gap:8px;
  padding:5px 4px;border-radius:6px;
  animation:msg-in .3s ease;
}
.chat-msg:hover{background:rgba(255,255,255,0.02)}
.chat-msg-avatar{
  width:24px;height:24px;border-radius:50%;flex-shrink:0;
  display:flex;align-items:center;justify-content:center;
  font-size:12px;margin-top:2px;
}
.chat-msg-body{flex:1;min-width:0}
.chat-msg-head{display:flex;align-items:baseline;gap:6px;margin-bottom:1px}
.chat-msg-name{font-size:11px;font-weight:700}
.chat-msg-time{font-size:10px;color:#475569}
.chat-msg-text{font-size:12px;color:#94a3b8;line-height:1.5;word-break:break-word}
.chat-msg-text .tag{
  display:inline-block;padding:1px 6px;border-radius:3px;
  font-size:10px;font-weight:600;margin-right:4px;
}
.tag-build{background:rgba(34,211,238,0.15);color:#67e8f9}
.tag-test{background:rgba(251,191,36,0.15);color:#fde68a}
.tag-deploy{background:rgba(52,211,153,0.15);color:#6ee7b7}
.tag-error{background:rgba(248,113,113,0.15);color:#fca5a5}
.tag-diagnosis{background:rgba(167,139,250,0.15);color:#c4b5fd}

/* ── Animations ── */
@keyframes pulse-dot{0%,100%{opacity:1}50%{opacity:.3}}
@keyframes typing-anim{0%,100%{opacity:.3;transform:translateY(0)}50%{opacity:1;transform:translateY(-3px)}}
@keyframes msg-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}

/* ── Responsive: Tablet ── */
@media(max-width:1100px){
  .desks{grid-template-columns:repeat(2,1fr)}
}
/* ── Responsive: SP ── */
@media(max-width:640px){
  html{font-size:13px}
  .office{padding:8px 10px 32px}
  .office-header h1{font-size:15px}
  .office-header h1 .logo{font-size:20px}
  .desks{grid-template-columns:1fr}
  .desk{padding:14px}
  .pipeline{padding:10px 12px;gap:2px}
  .pipe-step{padding:5px 10px;font-size:11px}
  .pipe-label{display:none}
  .chat-messages{max-height:250px}
  .task-bar{flex-wrap:wrap}
}
</style>
</head>
<body>
<div class="office">

  <!-- Header -->
  <header class="office-header">
    <h1><span class="logo">🏢</span> 母艦開発オフィス</h1>
    <div class="header-right">
      <div id="conn" class="conn-badge"><span class="conn-dot"></span> <span id="conn-text">接続中...</span></div>
      <a href="/admin">ダッシュボード</a>
      <a href="/admin/dev">開発</a>
      <a href="/admin/insights">改善</a>
      <a href="/admin/knowledge">ナレッジ</a>
      <a href="/admin/mindmap">記憶マップ</a>
    </div>
  </header>

  <!-- Task Bar -->
  <div id="task-bar" class="task-bar hidden">
    <span>📌</span>
    <span id="task-topic" class="task-topic"></span>
    <span id="task-status" class="task-status"></span>
  </div>

  <!-- Pipeline -->
  <div class="pipeline" id="pipeline">
    <div class="pipe-step" data-phase="hearing"><span class="pipe-icon">👂</span><span class="pipe-label">ヒアリング</span></div>
    <span class="pipe-arrow">›</span>
    <div class="pipe-step" data-phase="defining"><span class="pipe-icon">📝</span><span class="pipe-label">要件定義</span></div>
    <span class="pipe-arrow">›</span>
    <div class="pipe-step" data-phase="approved"><span class="pipe-icon">✅</span><span class="pipe-label">承認</span></div>
    <span class="pipe-arrow">›</span>
    <div class="pipe-step" data-phase="implementing"><span class="pipe-icon">⚙️</span><span class="pipe-label">実装</span></div>
    <span class="pipe-arrow">›</span>
    <div class="pipe-step" data-phase="testing"><span class="pipe-icon">🧪</span><span class="pipe-label">テスト</span></div>
    <span class="pipe-arrow">›</span>
    <div class="pipe-step" data-phase="deployed"><span class="pipe-icon">✨</span><span class="pipe-label">完了</span></div>
  </div>

  <!-- Agent Desks -->
  <div class="desks">
    <div class="desk" id="desk-pm" data-agent="pm">
      <div class="desk-header">
        <div class="desk-avatar">📋</div>
        <div class="desk-info"><div class="desk-name">PM</div><div class="desk-role">プロジェクトマネージャー</div></div>
        <span class="status-dot" id="dot-pm"></span>
      </div>
      <div class="desk-activity" id="act-pm">待機中</div>
      <div class="desk-detail" id="det-pm"></div>
    </div>

    <div class="desk" id="desk-engineer" data-agent="engineer">
      <div class="desk-header">
        <div class="desk-avatar">⌨️</div>
        <div class="desk-info"><div class="desk-name">エンジニア</div><div class="desk-role">コード実装担当</div></div>
        <span class="status-dot" id="dot-engineer"></span>
      </div>
      <div class="desk-activity" id="act-engineer">待機中</div>
      <div class="desk-detail" id="det-engineer"></div>
    </div>

    <div class="desk" id="desk-reviewer" data-agent="reviewer">
      <div class="desk-header">
        <div class="desk-avatar">🔍</div>
        <div class="desk-info"><div class="desk-name">レビュアー</div><div class="desk-role">品質管理担当</div></div>
        <span class="status-dot" id="dot-reviewer"></span>
      </div>
      <div class="desk-activity" id="act-reviewer">待機中</div>
      <div class="desk-detail" id="det-reviewer"></div>
    </div>

    <div class="desk" id="desk-deployer" data-agent="deployer">
      <div class="desk-header">
        <div class="desk-avatar">🚀</div>
        <div class="desk-info"><div class="desk-name">デプロイヤー</div><div class="desk-role">インフラ・配備担当</div></div>
        <span class="status-dot" id="dot-deployer"></span>
      </div>
      <div class="desk-activity" id="act-deployer">待機中</div>
      <div class="desk-detail" id="det-deployer"></div>
    </div>
  </div>

  <!-- Chat Room -->
  <div class="chat-room">
    <div class="chat-header">
      <span>💬 チームチャット</span>
      <span class="chat-count" id="chat-count">0</span>
    </div>
    <div class="chat-messages" id="chat-feed">
      <div class="chat-empty" id="chat-empty">イベントを待機中...</div>
    </div>
  </div>

</div>

<script>
// ── Config ──
const AGENTS = {
  pm:       { name: 'PM',         emoji: '📋', color: '#a78bfa', bg: 'rgba(167,139,250,0.12)' },
  engineer: { name: 'エンジニア',  emoji: '⌨️',  color: '#22d3ee', bg: 'rgba(34,211,238,0.12)' },
  reviewer: { name: 'レビュアー',  emoji: '🔍', color: '#fbbf24', bg: 'rgba(251,191,36,0.12)' },
  deployer: { name: 'デプロイヤー', emoji: '🚀', color: '#34d399', bg: 'rgba(52,211,153,0.12)' },
  system:   { name: 'システム',    emoji: '⚙️',  color: '#94a3b8', bg: 'rgba(148,163,184,0.12)' },
};

const PHASE_ORDER = ['hearing','defining','approved','implementing','testing','deployed'];
const PHASE_LABELS = { hearing:'ヒアリング', defining:'要件定義', approved:'承認済み', implementing:'実装中', testing:'テスト中', deployed:'完了', stuck:'スタック', failed:'失敗' };

const MAX_CHAT = 100;

// ── DOM ──
const $ = id => document.getElementById(id);

// ── State ──
const state = {
  connected: false,
  currentConv: null,
  currentPhase: null,
  lastNormalPhase: null,
  agents: { pm:'idle', engineer:'idle', reviewer:'idle', deployer:'idle' },
  chatMessages: [],
};

// ── SSE Connection ──
let es = null;
let reconnectTimer = null;

function connectSSE() {
  if (es) { try { es.close(); } catch {} }
  es = new EventSource('/admin/live/events');

  es.onopen = () => {
    state.connected = true;
    updateConn();
  };

  es.onerror = () => {
    state.connected = false;
    updateConn();
    if (es) es.close();
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectSSE, 3000);
  };

  es.onmessage = (e) => {
    try {
      const evt = JSON.parse(e.data);
      if (evt.type === 'connected') return;
      handleEvent(evt);
    } catch {}
  };
}

function updateConn() {
  const el = $('conn');
  const txt = $('conn-text');
  if (state.connected) {
    el.classList.add('connected');
    txt.textContent = 'Live';
  } else {
    el.classList.remove('connected');
    txt.textContent = '再接続中...';
  }
}

// ── Event Handler ──
function handleEvent(evt) {
  const agent = evt.agent || 'system';
  const d = evt.data || {};

  switch (evt.type) {
    case 'phase_change':
      setPhase(d.phase, d.topic);
      if (d.phase === 'hearing' || d.phase === 'defining') setAgentActive('pm');
      if (d.phase === 'implementing') setAgentActive('engineer');
      if (d.phase === 'testing') setAgentActive('deployer');
      if (d.phase === 'deployed') setAllIdle();
      if (d.phase === 'failed') setAllIdle();
      if (d.phase === 'stuck') {
        setAgentStatus('pm', 'warning', 'ユーザーに相談中');
        ['engineer','reviewer','deployer'].forEach(a => setAgentStatus(a, 'idle', '待機中'));
      }
      break;

    case 'agent_activity': {
      // 3状態: idle / active / warning / error をそのまま反映
      const agentStatus = d.status === 'idle' ? 'idle'
        : d.status === 'error' ? 'error'
        : d.status === 'warning' ? 'warning'
        : 'active';
      setAgentStatus(agent, agentStatus, d.message || '');
      if (d.file) setAgentDetail(agent, '<span class="file-tag">' + esc(d.file) + '</span>');
      break;
    }

    case 'agent_message':
      setAgentStatus(agent, 'active', d.message || '');
      break;

    case 'code_write':
      setAgentStatus('engineer', 'active', '書き込み完了: ' + (d.file || ''));
      setAgentDetail('engineer', '<span class="file-tag">' + esc(d.file || '') + '</span> ' + esc(d.action || ''));
      break;

    case 'build':
      if (d.status === 'building') {
        setAgentStatus('deployer', 'active', 'ビルド中...');
      } else if (d.status === 'success') {
        setAgentStatus('deployer', 'active', 'ビルド成功 ✓');
      } else {
        setAgentStatus('deployer', 'error', 'ビルド失敗');
        setAgentDetail('deployer', d.error ? '<div class="code-preview">' + esc(String(d.error).slice(0,150)) + '</div>' : '');
      }
      break;

    case 'test':
      if (d.status === 'testing') {
        setAgentStatus('deployer', 'active', 'テスト実行中...');
      } else if (d.status === 'passed') {
        setAgentStatus('deployer', 'active', 'テスト通過 ✓');
      } else {
        setAgentStatus('deployer', 'error', 'テスト失敗: ' + (d.message || ''));
      }
      break;

    case 'deploy':
      setAgentStatus('deployer', 'active', 'デプロイ中...');
      break;

    case 'diagnosis':
      if (d.status === 'meeting') {
        ['pm','engineer','reviewer','deployer'].forEach(a => setAgentStatus(a, 'active', '診断会議参加中'));
      } else if (d.recommendation) {
        setAgentStatus('pm', 'active', '診断結果: ' + d.recommendation);
        if (d.rootCause) setAgentDetail('pm', '<div class="code-preview">' + esc(String(d.rootCause).slice(0,200)) + '</div>');
      }
      break;

    case 'escalation':
      setAgentStatus('pm', 'warning', 'ユーザーにエスカレーション中');
      if (d.file) setAgentDetail('pm', '<span class="file-tag">' + esc(d.file) + '</span> ' + esc(d.reason || ''));
      break;

    case 'batch_start':
      setAgentStatus('engineer', 'active', 'バッチ' + (d.batchIndex || '') + ' 並列実行中 (' + (d.count || '') + '件)');
      break;

    case 'batch_complete':
      if (d.failed > 0) {
        setAgentStatus('engineer', 'warning', 'バッチ' + (d.batchIndex || '') + ' 完了 (' + d.failed + '件失敗)');
      } else {
        setAgentStatus('engineer', 'active', 'バッチ' + (d.batchIndex || '') + ' 完了 ✓');
      }
      break;
  }

  addChat(agent, formatChatText(evt), evt.timestamp);
}

// ── Agent State Updates ──
function setAgentActive(agent) {
  Object.keys(state.agents).forEach(a => {
    if (a === agent) setAgentStatus(a, 'active', '');
    else if (state.agents[a] === 'active') setAgentStatus(a, 'idle', '');
  });
}

function setAllIdle() {
  Object.keys(state.agents).forEach(a => setAgentStatus(a, 'idle', '待機中'));
}

function setAgentStatus(agent, status, activity) {
  state.agents[agent] = status;
  const desk = $('desk-' + agent);
  const dot = $('dot-' + agent);
  const act = $('act-' + agent);
  if (!desk) return;

  desk.classList.toggle('active', status === 'active' || status === 'error');
  dot.className = 'status-dot ' + (status === 'error' ? 'error' : status === 'active' ? 'active' : status === 'warning' ? 'warning' : '');

  if (activity) {
    act.innerHTML = esc(activity) + (status === 'active' ? ' <span class="typing"><span></span><span></span><span></span></span>' : '');
  } else if (status === 'idle') {
    act.textContent = '待機中';
  }
}

function setAgentDetail(agent, html) {
  const el = $('det-' + agent);
  if (el) el.innerHTML = html;
}

// ── Pipeline ──
function setPhase(phase, topic) {
  // stuck/failedの場合、直前の正常フェーズを記憶
  if (phase !== 'stuck' && phase !== 'failed' && PHASE_ORDER.includes(phase)) {
    state.lastNormalPhase = phase;
  }
  state.currentPhase = phase;
  if (topic) {
    state.currentConv = { topic, status: phase };
    $('task-topic').textContent = topic;
  }

  // Update task bar
  const bar = $('task-bar');
  bar.classList.remove('hidden');
  const st = $('task-status');
  st.textContent = PHASE_LABELS[phase] || phase;
  st.className = 'task-status' + (phase === 'deployed' ? ' deployed' : phase === 'failed' ? ' failed' : phase === 'stuck' ? ' stuck' : '');

  // Update pipeline steps
  // stuck/failedは正常フェーズのステップを色変え（黄/赤）で表現
  const isStuck = phase === 'stuck';
  const isFailed = phase === 'failed';
  const effectivePhase = (isStuck || isFailed) ? (state.lastNormalPhase || 'implementing') : phase;
  const idx = PHASE_ORDER.indexOf(effectivePhase);

  document.querySelectorAll('.pipe-step').forEach(el => {
    const stepPhase = el.dataset.phase;
    const stepIdx = PHASE_ORDER.indexOf(stepPhase);
    el.classList.remove('active', 'completed', 'failed-step', 'stuck-step');

    if (stepIdx < idx) {
      el.classList.add('completed');
    } else if (stepIdx === idx) {
      if (isStuck) el.classList.add('stuck-step');
      else if (isFailed) el.classList.add('failed-step');
      else el.classList.add('active');
    }
  });
}

// ── Chat ──
function addChat(agent, text, timestamp) {
  if (!text) return;
  const info = AGENTS[agent] || AGENTS.system;
  const time = timestamp ? new Date(timestamp).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit',second:'2-digit'}) : '';

  state.chatMessages.push({ agent, text, time });
  if (state.chatMessages.length > MAX_CHAT) state.chatMessages.shift();

  const feed = $('chat-feed');
  const empty = $('chat-empty');
  if (empty) empty.remove();

  const div = document.createElement('div');
  div.className = 'chat-msg';
  div.innerHTML =
    '<div class="chat-msg-avatar" style="background:' + info.bg + '">' + info.emoji + '</div>' +
    '<div class="chat-msg-body">' +
      '<div class="chat-msg-head">' +
        '<span class="chat-msg-name" style="color:' + info.color + '">' + info.name + '</span>' +
        '<span class="chat-msg-time">' + time + '</span>' +
      '</div>' +
      '<div class="chat-msg-text">' + text + '</div>' +
    '</div>';
  feed.appendChild(div);
  feed.scrollTop = feed.scrollHeight;

  $('chat-count').textContent = state.chatMessages.length;
}

function formatChatText(evt) {
  const d = evt.data || {};
  switch (evt.type) {
    case 'phase_change':
      if (d.phase === 'stuck') return '<span class="tag tag-error">⚠️ スタック</span> ' + esc(String(d.reason || '').slice(0,80));
      if (d.phase === 'failed') return '<span class="tag tag-error">❌ 失敗</span> ' + esc(String(d.reason || '').slice(0,80));
      return '<span class="tag tag-deploy">' + (PHASE_LABELS[d.phase] || d.phase) + '</span> フェーズに移行' + (d.topic ? ' - ' + esc(d.topic) : '');
    case 'agent_activity':
      return esc(d.message || d.status || '');
    case 'agent_message':
      return esc(d.message || '');
    case 'code_write':
      return '<span class="tag tag-build">コード</span> ' + esc(d.file || '') + ' (' + esc(d.action || '') + ')';
    case 'build':
      if (d.status === 'success') return '<span class="tag tag-build">ビルド</span> 成功 ✓';
      if (d.status === 'failed') return '<span class="tag tag-error">ビルド失敗</span> ' + esc(String(d.error || '').slice(0,80));
      return '<span class="tag tag-build">ビルド</span> 実行中...';
    case 'test':
      if (d.status === 'passed') return '<span class="tag tag-test">テスト</span> 通過 ✓';
      if (d.status === 'failed') return '<span class="tag tag-error">テスト失敗</span> ' + esc(String(d.message || '').slice(0,80));
      return '<span class="tag tag-test">テスト</span> 実行中...';
    case 'deploy':
      return '<span class="tag tag-deploy">デプロイ</span> 開始...';
    case 'diagnosis':
      if (d.status === 'meeting') return '<span class="tag tag-diagnosis">チーム診断</span> 会議開始';
      return '<span class="tag tag-diagnosis">診断結果</span> ' + esc(d.recommendation || '') + (d.rootCause ? ' - 原因: ' + esc(String(d.rootCause).slice(0,60)) : '');
    case 'escalation':
      return '<span class="tag tag-error">⚠️ エスカレーション</span> ' + esc(d.reason || '') + (d.file ? ' (' + esc(d.file) + ')' : '');
    case 'batch_start':
      return '<span class="tag tag-build">バッチ' + (d.batchIndex || '') + '</span> 並列実行開始 (' + (d.count || '') + '件)';
    case 'batch_complete':
      if (d.failed > 0) return '<span class="tag tag-error">バッチ' + (d.batchIndex || '') + '</span> ' + d.succeeded + '件成功 / ' + d.failed + '件失敗';
      return '<span class="tag tag-build">バッチ' + (d.batchIndex || '') + '</span> 完了 ✓ (' + (d.succeeded || '') + '件)';
    default:
      return esc(JSON.stringify(d).slice(0, 100));
  }
}

// ── Utility ──
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// ── Initial State Load ──
async function loadInitialState() {
  try {
    const res = await fetch('/admin/live/api/state');
    const data = await res.json();

    if (data.conversations && data.conversations.length > 0) {
      const conv = data.conversations[0];
      state.currentConv = conv;
      setPhase(conv.status, conv.topic);

      // Derive agent states from conversation status
      switch (conv.status) {
        case 'hearing': case 'defining': setAgentStatus('pm', 'active', PHASE_LABELS[conv.status] + '中'); break;
        case 'implementing': setAgentStatus('engineer', 'active', '実装中'); break;
        case 'testing': setAgentStatus('deployer', 'active', 'テスト中'); break;
        case 'stuck': ['pm','engineer'].forEach(a => setAgentStatus(a, 'warning', 'スタック')); break;
      }
    }

    // Load recent logs into chat
    if (data.recentLogs && data.recentLogs.length > 0) {
      const logs = data.recentLogs.slice().reverse().slice(-30);
      for (const log of logs) {
        const agent = inferAgent(log.message);
        const text = esc(log.message.replace(/^\\[.*?\\]\\s*/, ''));
        const levelTag = log.level === 'error' ? '<span class="tag tag-error">ERROR</span> ' :
                        log.level === 'warn' ? '<span class="tag tag-error">WARN</span> ' : '';
        addChat(agent, levelTag + text, log.created_at);
      }
    }
  } catch (err) {
    addChat('system', 'データ取得に失敗: ' + esc(err.message), new Date().toISOString());
  }
}

function inferAgent(msg) {
  if (/\\[PM\\]/.test(msg)) return 'pm';
  if (/\\[エンジニア|\\[Engineer/.test(msg)) return 'engineer';
  if (/\\[レビュアー|\\[Reviewer/.test(msg)) return 'reviewer';
  if (/\\[デプロイヤー|\\[Deployer/.test(msg)) return 'deployer';
  return 'system';
}

// ── Init ──
loadInitialState().then(() => connectSSE());
</script>
</body>
</html>`;
}
