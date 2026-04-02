import { config } from '../config';

interface LayoutOptions {
  activePage?: string;
  breadcrumbs?: Array<{ label: string; href?: string }>;
}

function layout(title: string, content: string, opts: LayoutOptions = {}): string {
  const { activePage = '', breadcrumbs } = opts;
  const navItems = [
    { href: '/admin', label: 'ダッシュボード', key: 'dashboard' },
    { href: '/admin/dev', label: '開発', key: 'dev' },
    { href: '/admin/insights', label: '改善', key: 'insights' },
    { href: '/admin/live', label: 'オフィス', key: 'live' },
    { href: '/admin/knowledge', label: 'ナレッジ', key: 'knowledge' },
    { href: '/admin/mindmap', label: '記憶マップ', key: 'mindmap' },
  ];

  const breadcrumbHtml = breadcrumbs && breadcrumbs.length > 0
    ? `<div class="breadcrumbs">${breadcrumbs.map((b, i) =>
        i < breadcrumbs.length - 1 && b.href
          ? `<a href="${b.href}">${escapeHtml(b.label)}</a><span class="sep">/</span>`
          : `<span class="current">${escapeHtml(b.label)}</span>`
      ).join('')}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} - 母艦管理</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f1117; color: #e1e4e8; line-height: 1.6; }
  .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
  nav { background: #161b22; padding: 12px 20px; border-bottom: 1px solid #30363d; display: flex; align-items: center; flex-wrap: wrap; gap: 4px 0; }
  nav a { color: #8b949e; text-decoration: none; margin-right: 6px; font-size: 14px; padding: 4px 12px; border-radius: 6px; transition: color 0.15s, background 0.15s; }
  nav a:hover { color: #e1e4e8; background: #21262d; text-decoration: none; }
  nav a.active { color: #f0f6fc; background: #30363d; font-weight: 600; }
  nav .brand { color: #f0f6fc; font-weight: bold; font-size: 16px; margin-right: 20px; padding: 4px 0; }
  nav .brand:hover { background: none; }
  .breadcrumbs { padding: 8px 0 16px; font-size: 13px; color: #8b949e; }
  .breadcrumbs a { color: #58a6ff; text-decoration: none; }
  .breadcrumbs a:hover { text-decoration: underline; }
  .breadcrumbs .sep { margin: 0 6px; color: #484f58; }
  .breadcrumbs .current { color: #c9d1d9; }
  h1 { font-size: 20px; margin-bottom: 16px; color: #f0f6fc; }
  h2 { font-size: 16px; margin: 20px 0 10px; color: #c9d1d9; border-bottom: 1px solid #30363d; padding-bottom: 6px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 16px; margin-bottom: 20px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; }
  .card .label { font-size: 12px; color: #8b949e; text-transform: uppercase; margin-bottom: 4px; }
  .card .value { font-size: 24px; font-weight: bold; color: #f0f6fc; }
  .card .sub { font-size: 12px; color: #8b949e; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; background: #161b22; border: 1px solid #30363d; border-radius: 8px; overflow: hidden; margin-bottom: 20px; }
  th { background: #1c2128; text-align: left; padding: 8px 12px; font-size: 12px; color: #8b949e; text-transform: uppercase; }
  td { padding: 8px 12px; border-top: 1px solid #21262d; font-size: 13px; }
  tr:hover td { background: #1c2128; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; }
  .badge-success { background: #1b4332; color: #2dd4bf; }
  .badge-pending { background: #3b2f00; color: #f0c040; }
  .badge-running { background: #0c2d48; color: #58a6ff; }
  .badge-failed { background: #3d1418; color: #f85149; }
  .badge-hearing { background: #2d1b4e; color: #bc8cff; }
  .badge-defining { background: #2d1b4e; color: #bc8cff; }
  .badge-approved { background: #1b3a4b; color: #7ee8fa; }
  .badge-stuck { background: #4a3000; color: #ffb347; }
  .badge-deployed { background: #1b4332; color: #2dd4bf; }
  .badge-implementing { background: #0c2d48; color: #58a6ff; }
  .badge-testing { background: #0c2d48; color: #58a6ff; }
  .log-info { color: #58a6ff; }
  .log-warn { color: #f0c040; }
  .log-error { color: #f85149; }
  pre { background: #1c2128; padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 13px; margin: 8px 0; border: 1px solid #30363d; white-space: pre-wrap; word-break: break-word; }
  a { color: #58a6ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .truncate { max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  .filter-bar { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
  .filter-bar a { padding: 4px 14px; border-radius: 16px; font-size: 13px; color: #8b949e; border: 1px solid #30363d; transition: all 0.15s; }
  .filter-bar a:hover { color: #e1e4e8; border-color: #58a6ff; text-decoration: none; }
  .filter-bar a.active { color: #f0f6fc; background: #30363d; border-color: #58a6ff; }
  .timeline { position: relative; padding-left: 24px; margin: 12px 0; }
  .timeline::before { content: ''; position: absolute; left: 8px; top: 0; bottom: 0; width: 2px; background: #30363d; }
  .timeline-item { position: relative; margin-bottom: 12px; }
  .timeline-item::before { content: ''; position: absolute; left: -20px; top: 6px; width: 10px; height: 10px; border-radius: 50%; background: #30363d; border: 2px solid #0f1117; }
  .timeline-item.reject::before { background: #f85149; }
  .timeline-item.success::before { background: #2dd4bf; }
  .timeline-item.info::before { background: #58a6ff; }
  .timeline-item .time { font-size: 11px; color: #484f58; }
  .timeline-item .msg { font-size: 13px; color: #c9d1d9; }
  .section-card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  .section-card h3 { font-size: 14px; color: #c9d1d9; margin-bottom: 10px; }
  .stat-inline { display: inline-flex; align-items: center; gap: 6px; margin-right: 16px; font-size: 13px; }
  .stat-inline .num { font-weight: 700; font-size: 16px; }
  .chat-thread { margin: 8px 0; }
  .chat-bubble { margin: 6px 0; padding: 10px 14px; border-radius: 10px; font-size: 13px; line-height: 1.5; max-width: 85%; white-space: pre-wrap; word-break: break-word; }
  .chat-bubble .sender { font-size: 11px; font-weight: 700; margin-bottom: 3px; }
  .chat-bubble.user { background: #1a3a5c; border: 1px solid #1f4e79; margin-left: auto; }
  .chat-bubble.user .sender { color: #58a6ff; }
  .chat-bubble.pm { background: #1b2a1b; border: 1px solid #2d5a2d; }
  .chat-bubble.pm .sender { color: #2dd4bf; }
  .chat-bubble.engineer { background: #1c2128; border: 1px solid #30363d; }
  .chat-bubble.engineer .sender { color: #bc8cff; }
  .chat-bubble.reviewer { background: #2a1f00; border: 1px solid #4a3800; }
  .chat-bubble.reviewer .sender { color: #f0c040; }
  .chat-bubble.deployer { background: #1a1a2e; border: 1px solid #2e2e52; }
  .chat-bubble.deployer .sender { color: #7ee8fa; }
  .chat-bubble.system { background: #21262d; border: 1px solid #30363d; }
  .chat-bubble.system .sender { color: #8b949e; }
  .conv-block { border: 1px solid #30363d; border-radius: 8px; margin-bottom: 12px; overflow: hidden; }
  .conv-header { background: #1c2128; padding: 10px 14px; display: flex; justify-content: space-between; align-items: center; cursor: pointer; }
  .conv-header:hover { background: #21262d; }
  .conv-header .type-badge { font-size: 11px; font-weight: 700; padding: 2px 10px; border-radius: 10px; }
  .conv-header .type-reject { background: #3d1418; color: #f85149; }
  .conv-header .type-consult { background: #0c2d48; color: #58a6ff; }
  .conv-header .type-consensus { background: #2d1b4e; color: #bc8cff; }
  .conv-header .type-retrospective { background: #1b4332; color: #2dd4bf; }
  .conv-body { padding: 12px 14px; border-top: 1px solid #21262d; }
  .issue-card { background: #1c2128; border: 1px solid #30363d; border-radius: 6px; padding: 10px 12px; margin: 6px 0; }
  .issue-card .severity { font-size: 11px; font-weight: 700; padding: 1px 8px; border-radius: 8px; margin-right: 6px; }
  .severity-error { background: #3d1418; color: #f85149; }
  .severity-warning { background: #3b2f00; color: #f0c040; }
  .severity-info { background: #0c2d48; color: #58a6ff; }
  .severity-major { background: #3d1418; color: #f85149; }
  .severity-minor { background: #3b2f00; color: #f0c040; }
  .learning-item { padding: 8px 12px; border-left: 3px solid #30363d; margin: 6px 0; font-size: 13px; }
  .learning-item.pattern { border-left-color: #f0c040; }
  .learning-item.learning { border-left-color: #58a6ff; }
  .tabs { display: flex; gap: 0; border-bottom: 1px solid #30363d; margin-bottom: 16px; }
  .tabs a { padding: 8px 16px; font-size: 13px; color: #8b949e; border-bottom: 2px solid transparent; transition: all 0.15s; }
  .tabs a:hover { color: #e1e4e8; text-decoration: none; }
  .tabs a.active { color: #f0f6fc; border-bottom-color: #58a6ff; }
  @media (max-width: 768px) {
    .container { padding: 12px; }
    .grid { grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; }
    .card .value { font-size: 18px; }
    nav { padding: 10px 12px; gap: 6px; }
    nav a { margin-right: 4px; font-size: 13px; padding: 4px 8px; }
    nav .brand { margin-right: 12px; font-size: 15px; width: 100%; }
    h1 { font-size: 18px; }
    th, td { padding: 6px 8px; font-size: 12px; }
    .truncate { max-width: 150px; }
    pre { font-size: 11px; padding: 8px; }
    .filter-bar { gap: 6px; }
    .chat-bubble { max-width: 95%; }
  }
</style>
</head>
<body>
<nav>
  <a href="/admin" class="brand">母艦管理</a>
  ${navItems.map(n => `<a href="${n.href}"${activePage === n.key ? ' class="active"' : ''}>${n.label}</a>`).join('\n  ')}
</nav>
<div class="container">
${breadcrumbHtml}
${content}
</div>
</body>
</html>`;
}

function badge(status: string): string {
  const cls = status === 'success' || status === 'deployed' ? 'success'
    : status === 'pending' ? 'pending'
    : status === 'running' || status === 'implementing' ? 'running'
    : status === 'failed' ? 'failed'
    : status === 'stuck' ? 'stuck'
    : status === 'hearing' || status === 'defining' ? 'hearing'
    : 'pending';
  return `<span class="badge badge-${cls}">${status}</span>`;
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}h ${m}m ${s}s`;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderPage(page: string, data: Record<string, unknown>): string {
  switch (page) {
    case 'dashboard':
      return layout('ダッシュボード', renderDashboard(data), { activePage: 'dashboard' });
    case 'task-detail':
      return layout('タスク詳細', renderTaskDetail(data), {
        activePage: 'dashboard',
        breadcrumbs: [{ label: 'ダッシュボード', href: '/admin' }, { label: 'タスク詳細' }],
      });
    case 'dev-list':
      return layout('開発結果', renderDevList(data), { activePage: 'dev' });
    case 'dev-detail':
      return layout('開発詳細', renderDevDetail(data), {
        activePage: 'dev',
        breadcrumbs: [{ label: '開発', href: '/admin/dev' }, { label: (data.conv as Record<string, unknown>)?.topic ? escapeHtml(((data.conv as Record<string, unknown>).topic as string).slice(0, 40)) : '詳細' }],
      });
    case 'insights':
      return layout('改善', renderInsights(data), { activePage: 'insights' });
    case 'knowledge':
      return layout('ナレッジ', renderKnowledge(data), { activePage: 'knowledge' });
    default:
      return layout('404', '<h1>ページが見つかりません</h1>');
  }
}

function renderDashboard(data: Record<string, unknown>): string {
  const taskCounts = data.taskCounts as Array<{ status: string; cnt: number }>;
  const recentTasks = data.recentTasks as Array<Record<string, unknown>>;
  const devConvs = data.devConvs as Array<Record<string, unknown>>;
  const apiUsage = data.apiUsage as Record<string, unknown>;
  const monthlyUsage = data.monthlyUsage as Record<string, unknown>;
  const agents = data.agents as string[];

  const totalTasks = taskCounts.reduce((sum, r) => sum + r.cnt, 0);
  const pendingCount = taskCounts.find(r => r.status === 'pending')?.cnt || 0;
  const failedCount = taskCounts.find(r => r.status === 'failed')?.cnt || 0;

  return `
<h1>母艦ダッシュボード</h1>

<div class="grid">
  <div class="card">
    <div class="label">稼働時間</div>
    <div class="value">${formatUptime(data.uptime as number)}</div>
    <div class="sub">環境: ${data.env}</div>
  </div>
  <div class="card">
    <div class="label">タスク</div>
    <div class="value">${totalTasks}</div>
    <div class="sub">待機: ${pendingCount} / 失敗: ${failedCount}</div>
  </div>
  <div class="card">
    <div class="label">本日のAPI</div>
    <div class="value">$${((apiUsage.total_cost as number) || 0).toFixed(3)}</div>
    <div class="sub">${(apiUsage.call_count as number) || 0}回 / 上限 $${config.claude.dailyBudgetUsd}</div>
  </div>
  <div class="card">
    <div class="label">月間API</div>
    <div class="value">$${((monthlyUsage.total_cost as number) || 0).toFixed(2)}</div>
    <div class="sub">${(monthlyUsage.call_count as number) || 0}回 / 上限 $${config.claude.monthlyBudgetUsd}</div>
  </div>
</div>

<div class="grid">
  <div class="card">
    <div class="label">登録エージェント</div>
    <div class="value">${agents.length}</div>
    <div class="sub">${agents.join(', ')}</div>
  </div>
</div>

<h2>直近のタスク</h2>
<div class="table-wrap"><table>
<tr><th>ID</th><th>エージェント</th><th>内容</th><th>状態</th><th>優先度</th><th>作成日時</th></tr>
${recentTasks.map(t => `<tr>
  <td><a href="/admin/tasks/${t.id}">${(t.id as string).slice(0, 8)}</a></td>
  <td>${t.agent}</td>
  <td class="truncate">${escapeHtml((t.description as string).slice(0, 60))}</td>
  <td>${badge(t.status as string)}</td>
  <td>${t.priority}</td>
  <td>${t.created_at}</td>
</tr>`).join('\n')}
</table></div>

<h2>直近の開発 <a href="/admin/dev" style="font-size:12px;font-weight:normal;margin-left:12px">すべて表示 →</a></h2>
<div class="table-wrap"><table>
<tr><th>ID</th><th>トピック</th><th>状態</th><th>作成</th><th>更新</th></tr>
${devConvs.map(c => `<tr>
  <td><a href="/admin/dev/${c.id}">${(c.id as string).slice(0, 8)}</a></td>
  <td class="truncate"><a href="/admin/dev/${c.id}">${escapeHtml((c.topic as string).slice(0, 60))}</a></td>
  <td>${badge(c.status as string)}</td>
  <td>${c.created_at}</td>
  <td>${c.updated_at}</td>
</tr>`).join('\n')}
</table></div>

<h2>直近のログ</h2>
<div class="table-wrap"><table>
<tr><th>レベル</th><th>ソース</th><th>メッセージ</th><th>日時</th></tr>
${(data.recentLogs as Array<Record<string, unknown>>).map(l => `<tr>
  <td class="log-${l.level}">${l.level}</td>
  <td>${l.source}</td>
  <td class="truncate">${escapeHtml((l.message as string).slice(0, 80))}</td>
  <td>${l.created_at}</td>
</tr>`).join('\n')}
</table></div>`;
}

function renderTaskDetail(data: Record<string, unknown>): string {
  const t = data.task as Record<string, unknown>;
  return `
<h1>タスク: ${(t.id as string).slice(0, 8)}</h1>
<div class="grid">
  <div class="card"><div class="label">状態</div><div class="value">${badge(t.status as string)}</div></div>
  <div class="card"><div class="label">エージェント</div><div class="value">${t.agent}</div></div>
  <div class="card"><div class="label">優先度</div><div class="value">${t.priority}</div></div>
  <div class="card"><div class="label">リトライ</div><div class="value">${t.retry_count}/${t.max_retries}</div></div>
</div>
<h2>説明</h2>
<pre>${escapeHtml(t.description as string)}</pre>
<h2>出力</h2>
<pre>${escapeHtml((t.output_data as string) || '(なし)')}</pre>
<h2>エラーログ</h2>
<pre>${escapeHtml((t.error_log as string) || '[]')}</pre>
<h2>メタ情報</h2>
<pre>作成: ${t.created_at}\n更新: ${t.updated_at}\n完了: ${t.completed_at || '(未完了)'}\nOpus: ${t.requires_opus ? 'はい' : 'いいえ'}</pre>`;
}

// ── 開発結果一覧 ──

function renderDevList(data: Record<string, unknown>): string {
  const convs = data.convs as Array<Record<string, unknown>>;
  const filter = (data.filter as string) || 'all';
  const stats = data.stats as { total: number; deployed: number; failed: number; active: number };
  const rejectCounts = data.rejectCounts as Record<string, number>;

  const filters = [
    { key: 'all', label: `すべて (${stats.total})` },
    { key: 'deployed', label: `成功 (${stats.deployed})` },
    { key: 'failed', label: `失敗 (${stats.failed})` },
    { key: 'active', label: `進行中 (${stats.active})` },
  ];

  return `
<h1>開発結果</h1>

<div class="grid">
  <div class="card">
    <div class="label">総開発数</div>
    <div class="value">${stats.total}</div>
  </div>
  <div class="card">
    <div class="label">デプロイ成功</div>
    <div class="value" style="color:#2dd4bf">${stats.deployed}</div>
    <div class="sub">成功率: ${stats.total > 0 ? Math.round(stats.deployed / stats.total * 100) : 0}%</div>
  </div>
  <div class="card">
    <div class="label">失敗</div>
    <div class="value" style="color:#f85149">${stats.failed}</div>
  </div>
  <div class="card">
    <div class="label">進行中</div>
    <div class="value" style="color:#58a6ff">${stats.active}</div>
  </div>
</div>

<div class="filter-bar">
  ${filters.map(f => `<a href="/admin/dev?filter=${f.key}"${filter === f.key ? ' class="active"' : ''}>${f.label}</a>`).join('\n  ')}
</div>

<div class="table-wrap"><table>
<tr><th>ID</th><th>トピック</th><th>状態</th><th>ファイル</th><th>差し戻し</th><th>作成</th><th>更新</th><th></th></tr>
${convs.map(c => {
  const files = (() => { try { const p = JSON.parse((c.generated_files as string) || '[]'); return Array.isArray(p) ? [...new Set(p)] : []; } catch { return []; } })();
  const rejects = rejectCounts[(c.id as string)] || 0;
  return `<tr>
  <td><a href="/admin/dev/${c.id}">${(c.id as string).slice(0, 8)}</a></td>
  <td class="truncate"><a href="/admin/dev/${c.id}">${escapeHtml((c.topic as string).slice(0, 60))}</a></td>
  <td>${badge(c.status as string)}</td>
  <td>${files.length > 0 ? `${files.length}件` : '-'}</td>
  <td>${rejects > 0 ? `<span style="color:${rejects >= 5 ? '#f85149' : rejects >= 2 ? '#f0c040' : '#8b949e'}">${rejects}回</span>` : '-'}</td>
  <td>${c.created_at}</td>
  <td>${c.updated_at}</td>
  <td>${!['deployed', 'failed'].includes(c.status as string) ? `<form method="POST" action="/admin/dev/${c.id}/cancel" style="display:inline"><button type="submit" style="background:none;color:#f85149;border:none;cursor:pointer;font-size:12px" title="キャンセル">✕</button></form>` : ''}</td>
</tr>`;
}).join('\n')}
</table></div>

<div style="text-align:right;margin-top:8px;">
  <form method="POST" action="/admin/dev/reset-all" style="display:inline">
    <button type="submit" style="background:#3d1418;color:#f85149;border:1px solid #f85149;border-radius:4px;padding:4px 12px;font-size:12px;cursor:pointer">全リセット</button>
  </form>
</div>`;
}

// ── 開発詳細（強化版） ──

function renderDevDetail(data: Record<string, unknown>): string {
  const c = data.conv as Record<string, unknown>;
  const teamConvs = (data.teamConversations || []) as Array<Record<string, unknown>>;
  const metrics = (data.metrics || []) as Array<Record<string, unknown>>;
  const devLogs = (data.devLogs || []) as Array<Record<string, unknown>>;
  const agentLearnings = (data.agentLearnings || []) as Array<Record<string, unknown>>;
  const evaluations = (data.evaluations || []) as Array<Record<string, unknown>>;

  // ヒアリングログ → チャット形式
  let hearingHtml = '';
  try {
    const log = JSON.parse(c.hearing_log as string) as Array<{ role: string; message: string }>;
    if (log.length > 0) {
      hearingHtml = `<div class="chat-thread">${log.map(e =>
        `<div class="chat-bubble ${e.role === 'user' ? 'user' : 'pm'}">
          <div class="sender">${e.role === 'user' ? 'Daiki' : 'PM'}</div>
          ${escapeHtml(e.message)}
        </div>`
      ).join('')}</div>`;
    }
  } catch { /* ignore */ }

  // 生成ファイル
  const files = (() => { try { const p = JSON.parse((c.generated_files as string) || '[]'); return Array.isArray(p) ? [...new Set(p)] as string[] : []; } catch { return [] as string[]; } })();

  // メトリクス集計
  const reviewRejects = metrics.filter(m => m.metric_type === 'review_reject').length;
  const buildFails = metrics.filter(m => m.metric_type === 'build_fail').length;
  const testFails = metrics.filter(m => m.metric_type === 'test_fail').length;
  const deploySuccess = metrics.filter(m => m.metric_type === 'deploy_success').length;

  // チーム会話を種類別に分類
  const rejectConvs = teamConvs.filter(t => t.conversation_type === 'reject');
  const consultConvs = teamConvs.filter(t => t.conversation_type === 'consult');
  const consensusConvs = teamConvs.filter(t => t.conversation_type === 'consensus');
  const retroConvs = teamConvs.filter(t => t.conversation_type === 'retrospective');

  // 所要時間計算
  const created = new Date(c.created_at as string);
  const updated = new Date(c.updated_at as string);
  const durationMin = Math.round((updated.getTime() - created.getTime()) / 60000);

  // タイムライン（メトリクス + チーム会話 + ログから重要イベントを抽出）
  const timelineItems: Array<{ time: string; msg: string; type: string; detail?: string }> = [];
  for (const m of metrics) {
    const labels: Record<string, string> = { review_reject: '🔴 レビュー差し戻し', build_fail: '🔴 ビルド失敗', test_fail: '🔴 テスト失敗', deploy_success: '🟢 デプロイ成功' };
    const cls = (m.metric_type as string) === 'deploy_success' ? 'success' : 'reject';
    timelineItems.push({ time: m.created_at as string, msg: `${m.agent}: ${labels[m.metric_type as string] || m.metric_type}`, type: cls, detail: m.context as string });
  }
  for (const tc of consultConvs) {
    timelineItems.push({ time: tc.created_at as string, msg: '💬 PM相談', type: 'info' });
  }
  for (const tc of consensusConvs) {
    timelineItems.push({ time: tc.created_at as string, msg: '🤝 合議', type: 'info' });
  }
  // ログからフェーズ変更を抽出
  for (const l of devLogs) {
    const msg = l.message as string;
    if (msg.includes('フェーズ開始') || msg.includes('ブランチ作成') || msg.includes('サブタスク分解完了') || msg.includes('全サブタスク完了') || msg.includes('ビルド成功') || msg.includes('デプロイ開始')) {
      timelineItems.push({ time: l.created_at as string, msg: `📋 ${msg.replace(/\[.*?\]\s*/, '')}`, type: 'info' });
    }
  }
  timelineItems.sort((a, b) => a.time.localeCompare(b.time));

  // チーム会話をレンダリングするヘルパー
  const renderConvBlock = (tc: Record<string, unknown>, idx: number, typeLabel: string, typeCls: string, defaultOpen: boolean) => {
    let logItems: Array<{ role: string; message: string; timestamp?: string }> = [];
    try { logItems = JSON.parse(tc.log as string); } catch { /* ignore */ }
    const participants = (() => { try { return (JSON.parse(tc.participants as string) as string[]).join(' → '); } catch { return String(tc.participants); } })();
    return `
    <div class="conv-block">
      <div class="conv-header" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'block':'none'">
        <div>
          <span class="type-badge type-${typeCls}">${typeLabel}</span>
          <span style="color:#c9d1d9;font-size:13px;margin-left:8px">${participants}</span>
        </div>
        <span style="color:#484f58;font-size:12px">${tc.created_at}</span>
      </div>
      <div class="conv-body" style="display:${defaultOpen ? 'block' : 'none'}">
        <div class="chat-thread">
          ${logItems.map(e => {
            const role = (e.role || 'system').toLowerCase();
            const bubbleCls = role === 'pm' ? 'pm' : role === 'engineer' ? 'engineer' : role === 'reviewer' ? 'reviewer' : role === 'deployer' ? 'deployer' : role === 'user' || role === 'daiki' ? 'user' : 'system';
            const displayName = role === 'pm' ? 'PM' : role === 'engineer' ? 'エンジニア' : role === 'reviewer' ? 'レビュアー' : role === 'deployer' ? 'デプロイヤー' : role === 'user' || role === 'daiki' ? 'Daiki' : role;
            return `<div class="chat-bubble ${bubbleCls}">
              <div class="sender">${displayName}${e.timestamp ? ` <span style="font-weight:400;color:#484f58">${e.timestamp.slice(11, 19)}</span>` : ''}</div>
              ${escapeHtml(String(e.message))}
            </div>`;
          }).join('')}
        </div>
        ${tc.decision ? `<div style="margin-top:8px;padding:8px 12px;background:#1b4332;border-radius:6px;font-size:13px;border-left:3px solid #2dd4bf"><strong style="color:#2dd4bf">決定:</strong> ${escapeHtml(String(tc.decision))}</div>` : ''}
      </div>
    </div>`;
  };

  return `
<h1>${escapeHtml((c.topic as string).slice(0, 80))}</h1>

<div class="grid">
  <div class="card">
    <div class="label">状態</div>
    <div class="value">${badge(c.status as string)}</div>
  </div>
  <div class="card">
    <div class="label">所要時間</div>
    <div class="value" style="font-size:18px">${durationMin}分</div>
    <div class="sub">${c.created_at} → ${c.updated_at}</div>
  </div>
  <div class="card">
    <div class="label">生成ファイル</div>
    <div class="value">${files.length}</div>
  </div>
  <div class="card">
    <div class="label">品質指標</div>
    <div class="value" style="font-size:14px">
      <span class="stat-inline"><span class="num" style="color:${reviewRejects > 0 ? '#f85149' : '#2dd4bf'}">${reviewRejects}</span>差し戻し</span>
      <span class="stat-inline"><span class="num" style="color:${buildFails > 0 ? '#f85149' : '#2dd4bf'}">${buildFails}</span>ビルド失敗</span>
      <span class="stat-inline"><span class="num" style="color:${testFails > 0 ? '#f85149' : '#2dd4bf'}">${testFails}</span>テスト失敗</span>
      ${deploySuccess > 0 ? '<span class="stat-inline"><span class="num" style="color:#2dd4bf">✓</span>デプロイ成功</span>' : ''}
    </div>
  </div>
  <div class="card">
    <div class="label">チーム会話</div>
    <div class="value" style="font-size:14px">
      <span class="stat-inline"><span class="num">${rejectConvs.length}</span>差し戻し</span>
      <span class="stat-inline"><span class="num">${consultConvs.length}</span>相談</span>
      <span class="stat-inline"><span class="num">${consensusConvs.length}</span>合議</span>
    </div>
  </div>
</div>

${hearingHtml ? `
<div class="section-card">
  <h3>💬 ヒアリング（PM ↔ Daiki）</h3>
  ${hearingHtml}
</div>` : ''}

${c.requirements ? `
<div class="section-card">
  <h3>📋 要件定義</h3>
  <pre>${escapeHtml(c.requirements as string)}</pre>
</div>` : ''}

${files.length > 0 ? `
<div class="section-card">
  <h3>📁 生成ファイル（${files.length}件）</h3>
  <ul style="list-style:none;padding:0">
    ${files.map(f => `<li style="padding:4px 0;font-family:monospace;font-size:13px;color:#c9d1d9">📄 ${escapeHtml(f)}</li>`).join('\n    ')}
  </ul>
</div>` : ''}

${timelineItems.length > 0 ? `
<div class="section-card">
  <h3>⏱ タイムライン</h3>
  <div class="timeline">
    ${timelineItems.map(t => `<div class="timeline-item ${t.type}">
      <div class="time">${t.time}</div>
      <div class="msg">${escapeHtml(t.msg)}</div>
      ${t.detail ? `<div style="font-size:11px;color:#8b949e;margin-top:2px">${escapeHtml(t.detail.slice(0, 150))}</div>` : ''}
    </div>`).join('\n    ')}
  </div>
</div>` : ''}

${teamConvs.length > 0 ? `
<div class="section-card">
  <h3>🗣 エージェント間会話（${teamConvs.length}件）</h3>
  <p style="font-size:12px;color:#8b949e;margin-bottom:12px">クリックで展開・折りたたみ</p>

  ${rejectConvs.length > 0 ? `<h4 style="font-size:13px;color:#f85149;margin:12px 0 8px">差し戻し（${rejectConvs.length}件）</h4>` : ''}
  ${rejectConvs.map((tc, i) => renderConvBlock(tc, i, '差し戻し', 'reject', i === rejectConvs.length - 1)).join('')}

  ${consultConvs.length > 0 ? `<h4 style="font-size:13px;color:#58a6ff;margin:12px 0 8px">相談（${consultConvs.length}件）</h4>` : ''}
  ${consultConvs.map((tc, i) => renderConvBlock(tc, i, '相談', 'consult', i === consultConvs.length - 1)).join('')}

  ${consensusConvs.length > 0 ? `<h4 style="font-size:13px;color:#bc8cff;margin:12px 0 8px">合議（${consensusConvs.length}件）</h4>` : ''}
  ${consensusConvs.map((tc, i) => renderConvBlock(tc, i, '合議', 'consensus', true)).join('')}

  ${retroConvs.length > 0 ? `<h4 style="font-size:13px;color:#2dd4bf;margin:12px 0 8px">振り返り（${retroConvs.length}件）</h4>` : ''}
  ${retroConvs.map((tc, i) => renderConvBlock(tc, i, '振り返り', 'retrospective', true)).join('')}
</div>` : '<div class="section-card"><h3>🗣 エージェント間会話</h3><p style="color:#8b949e;font-size:13px">この開発ではエージェント間会話が記録されていません。</p></div>'}

${agentLearnings.length > 0 ? `
<div class="section-card">
  <h3>🧠 この開発での学習</h3>
  ${agentLearnings.map(l => `
    <div class="learning-item ${l.type}">
      <div style="display:flex;justify-content:space-between;margin-bottom:4px">
        <span style="color:${l.type === 'pattern' ? '#f0c040' : '#58a6ff'};font-size:11px;font-weight:700">${(l.agent as string).toUpperCase()} / ${l.type === 'pattern' ? 'パターン検出' : '学習'}</span>
        <span style="color:#484f58;font-size:11px">${l.created_at}</span>
      </div>
      <div style="color:#c9d1d9">${escapeHtml((l.content as string).slice(0, 300))}</div>
      <div style="color:#484f58;font-size:11px;margin-top:2px">ソース: ${l.source || '-'} / キー: ${l.key}</div>
    </div>
  `).join('')}
</div>` : ''}

${evaluations.length > 0 ? `
<div class="section-card">
  <h3>📊 エージェント評価</h3>
  <div class="table-wrap"><table>
    <tr><th>評価者</th><th>対象</th><th>観点</th><th>評価</th><th>フィードバック</th><th>日時</th></tr>
    ${evaluations.map(e => `<tr>
      <td>${e.evaluator}</td>
      <td>${e.target}</td>
      <td>${e.aspect || '-'}</td>
      <td style="color:${(e.sentiment as number) > 0 ? '#2dd4bf' : (e.sentiment as number) < 0 ? '#f85149' : '#8b949e'}">${(e.sentiment as number) > 0 ? '👍' : (e.sentiment as number) < 0 ? '👎' : '—'} ${e.sentiment}</td>
      <td class="truncate">${escapeHtml((e.raw_feedback as string || '').slice(0, 80))}</td>
      <td style="white-space:nowrap">${e.created_at}</td>
    </tr>`).join('')}
  </table></div>
</div>` : ''}

${devLogs.length > 0 ? `
<div class="section-card">
  <h3>📝 詳細ログ（${devLogs.length}件）</h3>
  <details>
    <summary style="cursor:pointer;color:#8b949e;font-size:13px;padding:4px 0">クリックで展開</summary>
    <div class="table-wrap" style="margin-top:8px"><table>
      <tr><th>レベル</th><th>メッセージ</th><th>日時</th></tr>
      ${devLogs.map(l => `<tr>
        <td class="log-${l.level}">${l.level}</td>
        <td style="font-size:12px">${escapeHtml((l.message as string).slice(0, 300))}</td>
        <td style="white-space:nowrap">${l.created_at}</td>
      </tr>`).join('\n      ')}
    </table></div>
  </details>
</div>` : ''}

${!['deployed', 'failed'].includes(c.status as string) ? `
<div style="margin-top:16px">
  <form method="POST" action="/admin/dev/${c.id}/cancel" style="display:inline">
    <button type="submit" style="background:#3d1418;color:#f85149;border:1px solid #f85149;border-radius:6px;padding:6px 16px;font-size:13px;cursor:pointer">この開発を中止</button>
  </form>
</div>` : ''}`;
}

// ── 改善ページ ──

function renderInsights(data: Record<string, unknown>): string {
  const agentMetrics = data.agentMetrics as Array<{ agent: string; metric_type: string; cnt: number }>;
  const patterns = (data.patterns || []) as Array<Record<string, unknown>>;
  const recentLearnings = (data.recentLearnings || []) as Array<Record<string, unknown>>;
  const rejectSummary = (data.rejectSummary || []) as Array<Record<string, unknown>>;
  const evalTrend = (data.evalTrend || []) as Array<Record<string, unknown>>;
  const devStats = (data.devStats || {}) as Record<string, unknown>;
  const routingCorrections = (data.routingCorrections || []) as Array<Record<string, unknown>>;
  const consultConvs = (data.consultConvs || []) as Array<Record<string, unknown>>;

  // エージェント別メトリクスをグループ化
  const metricsByAgent: Record<string, Array<{ metric_type: string; cnt: number }>> = {};
  for (const m of agentMetrics) {
    (metricsByAgent[m.agent] ||= []).push(m);
  }

  // 差し戻し理由を抽出
  const rejectReasons: Array<{ reason: string; time: string }> = [];
  for (const r of rejectSummary) {
    try {
      const log = JSON.parse(r.log as string) as Array<{ role: string; message: string }>;
      const msg = log.find(e => e.role === 'reviewer' || e.role === 'deployer');
      if (msg) rejectReasons.push({ reason: msg.message.slice(0, 200), time: r.created_at as string });
    } catch { /* ignore */ }
  }

  // 評価をエージェント別にグループ化
  const evalByAgent: Record<string, Array<Record<string, unknown>>> = {};
  for (const e of evalTrend) {
    (evalByAgent[e.target as string] ||= []).push(e);
  }

  const successRate = (devStats.total as number) > 0
    ? Math.round(((devStats.deployed as number) || 0) / (devStats.total as number) * 100)
    : 0;
  const avgMin = Math.round((devStats.avg_deploy_min as number) || 0);

  return `
<h1>チーム改善ダッシュボード</h1>

<div class="grid">
  <div class="card">
    <div class="label">30日間の開発</div>
    <div class="value">${devStats.total || 0}</div>
    <div class="sub">成功: ${devStats.deployed || 0} / 失敗: ${devStats.failed || 0}</div>
  </div>
  <div class="card">
    <div class="label">成功率</div>
    <div class="value" style="color:${successRate >= 70 ? '#2dd4bf' : successRate >= 40 ? '#f0c040' : '#f85149'}">${successRate}%</div>
  </div>
  <div class="card">
    <div class="label">平均デプロイ時間</div>
    <div class="value">${avgMin > 0 ? `${avgMin}分` : '-'}</div>
    <div class="sub">成功した開発のみ</div>
  </div>
</div>

<h2>🏢 エージェント別パフォーマンス</h2>
${Object.keys(metricsByAgent).length > 0 ? `
<div class="grid">
  ${Object.entries(metricsByAgent).map(([agent, items]) => {
    const labels: Record<string, string> = { review_reject: '差し戻し', build_fail: 'ビルド失敗', test_fail: 'テスト失敗', deploy_success: 'デプロイ成功' };
    return `<div class="card">
      <div class="label">${agent}</div>
      <div style="margin-top:8px">
        ${items.map(i => `<div style="display:flex;justify-content:space-between;padding:3px 0;font-size:13px">
          <span style="color:#c9d1d9">${labels[i.metric_type] || i.metric_type}</span>
          <span style="color:${i.metric_type === 'deploy_success' ? '#2dd4bf' : '#f85149'};font-weight:700">${i.cnt}</span>
        </div>`).join('')}
      </div>
    </div>`;
  }).join('')}
</div>` : '<p style="color:#8b949e">メトリクスデータがまだありません。</p>'}

${Object.keys(evalByAgent).length > 0 ? `
<h2>📊 エージェント評価サマリー</h2>
<div class="grid">
  ${Object.entries(evalByAgent).map(([agent, evals]) => `
    <div class="card">
      <div class="label">${agent}</div>
      <div style="margin-top:8px">
        ${evals.map(e => {
          const avg = e.avg_sentiment as number;
          const color = avg > 0.3 ? '#2dd4bf' : avg < -0.3 ? '#f85149' : '#f0c040';
          return `<div style="display:flex;justify-content:space-between;padding:3px 0;font-size:13px">
            <span style="color:#c9d1d9">${e.aspect || '総合'}</span>
            <span style="color:${color};font-weight:700">${avg >= 0 ? '+' : ''}${(avg as number).toFixed(1)} (${e.cnt}件)</span>
          </div>`;
        }).join('')}
      </div>
    </div>
  `).join('')}
</div>` : ''}

${rejectReasons.length > 0 ? `
<h2>🔴 差し戻し理由（直近30件）</h2>
<div class="section-card">
  <p style="font-size:12px;color:#8b949e;margin-bottom:10px">レビュアー・デプロイヤーが指摘した内容。繰り返し出る指摘はシステム改善のヒントになります。</p>
  ${rejectReasons.map(r => `
    <div class="issue-card">
      <div style="display:flex;justify-content:space-between;margin-bottom:4px">
        <span style="font-size:13px;color:#c9d1d9">${escapeHtml(r.reason)}</span>
      </div>
      <div style="font-size:11px;color:#484f58">${r.time}</div>
    </div>
  `).join('')}
</div>` : ''}

${patterns.length > 0 ? `
<h2>🔁 検出されたパターン</h2>
<div class="section-card">
  <p style="font-size:12px;color:#8b949e;margin-bottom:10px">同じ種類のエラーが2回以上発生した場合に自動検出されます。</p>
  ${patterns.map(p => `
    <div class="learning-item pattern">
      <div style="display:flex;justify-content:space-between">
        <span style="color:#f0c040;font-size:12px;font-weight:700">${(p.agent as string).toUpperCase()}: ${p.key}</span>
        <span style="color:#484f58;font-size:11px">${p.updated_at}</span>
      </div>
      <div style="color:#c9d1d9;font-size:13px;margin-top:4px">${escapeHtml((p.content as string).slice(0, 300))}</div>
    </div>
  `).join('')}
</div>` : ''}

${consultConvs.length > 0 ? `
<h2>💬 相談会話（直近20件）</h2>
<div class="section-card">
  <p style="font-size:12px;color:#8b949e;margin-bottom:10px">エンジニアがPMに相談した内容。判断に迷うポイントが分かります。</p>
  ${consultConvs.map(tc => {
    let logItems: Array<{ role: string; message: string }> = [];
    try { logItems = JSON.parse(tc.log as string); } catch { /* ignore */ }
    const taskId = (tc.task_id as string || '').slice(0, 8);
    return `
    <div class="conv-block">
      <div class="conv-header" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'block':'none'">
        <div>
          <span class="type-badge type-consult">相談</span>
          <span style="color:#8b949e;font-size:12px;margin-left:8px">${taskId ? `開発: ${taskId}` : ''}</span>
        </div>
        <span style="color:#484f58;font-size:12px">${tc.created_at}</span>
      </div>
      <div class="conv-body" style="display:none">
        <div class="chat-thread">
          ${logItems.map(e => {
            const role = (e.role || 'system').toLowerCase();
            const bubbleCls = role === 'pm' ? 'pm' : role === 'engineer' ? 'engineer' : 'system';
            const name = role === 'pm' ? 'PM' : role === 'engineer' ? 'エンジニア' : role;
            return `<div class="chat-bubble ${bubbleCls}"><div class="sender">${name}</div>${escapeHtml(String(e.message))}</div>`;
          }).join('')}
        </div>
        ${tc.decision ? `<div style="margin-top:8px;padding:8px 12px;background:#1b4332;border-radius:6px;font-size:13px;border-left:3px solid #2dd4bf"><strong style="color:#2dd4bf">決定:</strong> ${escapeHtml(String(tc.decision))}</div>` : ''}
      </div>
    </div>`;
  }).join('')}
</div>` : ''}

${recentLearnings.length > 0 ? `
<h2>🧠 最近の学習記録</h2>
<div class="section-card">
  <p style="font-size:12px;color:#8b949e;margin-bottom:10px">エージェントが過去の失敗から学んだ内容。次回の開発に活かされます。</p>
  ${recentLearnings.map(l => `
    <div class="learning-item learning">
      <div style="display:flex;justify-content:space-between;margin-bottom:3px">
        <span style="color:#58a6ff;font-size:11px;font-weight:700">${(l.agent as string).toUpperCase()} / ${l.source || 'unknown'}</span>
        <span style="color:#484f58;font-size:11px">${l.created_at}</span>
      </div>
      <div style="color:#c9d1d9;font-size:13px">${escapeHtml((l.content as string).slice(0, 250))}</div>
    </div>
  `).join('')}
</div>` : ''}

${routingCorrections.length > 0 ? `
<h2>🔀 ルーティング修正履歴</h2>
<div class="section-card">
  <p style="font-size:12px;color:#8b949e;margin-bottom:10px">@分身/@PM セーフワードで手動修正されたルーティング。AIの自動判定改善に使われます。</p>
  <div class="table-wrap"><table>
    <tr><th>メッセージ</th><th>フェーズ</th><th>自動判定</th><th>正解</th><th>日時</th></tr>
    ${routingCorrections.map(r => `<tr>
      <td style="font-size:12px">${escapeHtml((r.message as string).slice(0, 60))}</td>
      <td>${badge(r.dev_phase as string)}</td>
      <td style="color:#f85149">${r.auto_target === 'pm' ? 'PM' : '分身'}</td>
      <td style="color:#2dd4bf">${r.corrected_target === 'pm' ? 'PM' : '分身'}</td>
      <td style="white-space:nowrap">${r.created_at}</td>
    </tr>`).join('')}
  </table></div>
</div>` : ''}`;
}

function renderKnowledge(data: Record<string, unknown>): string {
  const items = data.items as Array<Record<string, unknown>>;
  return `
<h1>ナレッジ</h1>
<table>
<tr><th>ファイル</th><th>セクション</th><th>バージョン</th><th>更新日</th></tr>
${items.map(k => `<tr>
  <td>${k.file_name}</td>
  <td>${escapeHtml((k.section as string) || '(全体)')}</td>
  <td>${k.version}</td>
  <td>${k.updated_at}</td>
</tr>
<tr><td colspan="4"><pre>${escapeHtml((k.content as string).slice(0, 500))}</pre></td></tr>`).join('\n')}
</table>`;
}

