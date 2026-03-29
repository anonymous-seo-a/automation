function layout(title: string, content: string): string {
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
  nav { background: #161b22; padding: 12px 20px; border-bottom: 1px solid #30363d; margin-bottom: 20px; }
  nav a { color: #58a6ff; text-decoration: none; margin-right: 20px; font-size: 14px; }
  nav a:hover { text-decoration: underline; }
  nav .brand { color: #f0f6fc; font-weight: bold; font-size: 16px; margin-right: 30px; }
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
  .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; }
  .badge-success { background: #1b4332; color: #2dd4bf; }
  .badge-pending { background: #3b2f00; color: #f0c040; }
  .badge-running { background: #0c2d48; color: #58a6ff; }
  .badge-failed { background: #3d1418; color: #f85149; }
  .badge-hearing { background: #2d1b4e; color: #bc8cff; }
  .badge-defining { background: #2d1b4e; color: #bc8cff; }
  .badge-deployed { background: #1b4332; color: #2dd4bf; }
  .badge-implementing { background: #0c2d48; color: #58a6ff; }
  .log-info { color: #58a6ff; }
  .log-warn { color: #f0c040; }
  .log-error { color: #f85149; }
  pre { background: #1c2128; padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 13px; margin: 8px 0; border: 1px solid #30363d; }
  a { color: #58a6ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .truncate { max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  @media (max-width: 768px) {
    .container { padding: 12px; }
    .grid { grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; }
    .card .value { font-size: 18px; }
    nav { padding: 10px 12px; display: flex; flex-wrap: wrap; gap: 8px; }
    nav a { margin-right: 12px; font-size: 13px; }
    nav .brand { margin-right: 16px; font-size: 15px; width: 100%; }
    h1 { font-size: 18px; }
    th, td { padding: 6px 8px; font-size: 12px; }
    .truncate { max-width: 150px; }
    pre { font-size: 11px; padding: 8px; }
  }
</style>
</head>
<body>
<nav>
  <a href="/admin" class="brand">母艦管理</a>
  <a href="/admin">ダッシュボード</a>
  <a href="/admin/knowledge">ナレッジ</a>
</nav>
<div class="container">
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
    case 'dashboard': return layout('ダッシュボード', renderDashboard(data));
    case 'task-detail': return layout('タスク詳細', renderTaskDetail(data));
    case 'dev-detail': return layout('開発会話', renderDevDetail(data));
    case 'knowledge': return layout('ナレッジ', renderKnowledge(data));
    default: return layout('404', '<h1>ページが見つかりません</h1>');
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

<h2>開発会話 <form method="POST" action="/admin/dev/reset-all" style="display:inline"><button type="submit" style="background:#3d1418;color:#f85149;border:1px solid #f85149;border-radius:4px;padding:2px 10px;font-size:12px;cursor:pointer">全リセット</button></form></h2>
<div class="table-wrap"><table>
<tr><th>ID</th><th>トピック</th><th>状態</th><th>作成</th><th>更新</th><th></th></tr>
${devConvs.map(c => `<tr>
  <td><a href="/admin/dev/${c.id}">${(c.id as string).slice(0, 8)}</a></td>
  <td class="truncate">${escapeHtml((c.topic as string).slice(0, 60))}</td>
  <td>${badge(c.status as string)}</td>
  <td>${c.created_at}</td>
  <td>${c.updated_at}</td>
  <td>${!['deployed', 'failed'].includes(c.status as string) ? `<form method="POST" action="/admin/dev/${c.id}/cancel" style="display:inline"><button type="submit" style="background:none;color:#f85149;border:none;cursor:pointer;font-size:12px">✕</button></form>` : ''}</td>
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
<pre>作成: ${t.created_at}\n更新: ${t.updated_at}\n完了: ${t.completed_at || '(未完了)'}\nOpus: ${t.requires_opus ? 'はい' : 'いいえ'}</pre>
<p><a href="/admin">← 戻る</a></p>`;
}

function renderDevDetail(data: Record<string, unknown>): string {
  const c = data.conv as Record<string, unknown>;
  let hearingHtml = '';
  try {
    const log = JSON.parse(c.hearing_log as string) as Array<{ role: string; message: string }>;
    hearingHtml = log.map(e =>
      `<div style="margin:6px 0;padding:8px 12px;background:${e.role === 'user' ? '#1c2128' : '#0d1117'};border-radius:6px;border-left:3px solid ${e.role === 'user' ? '#58a6ff' : '#2dd4bf'}">
        <strong>${e.role === 'user' ? 'ユーザー' : 'エージェント'}:</strong> ${escapeHtml(e.message)}
      </div>`
    ).join('');
  } catch { hearingHtml = '<p>(なし)</p>'; }

  const files = JSON.parse((c.generated_files as string) || '[]') as string[];

  return `
<h1>開発: ${escapeHtml((c.topic as string).slice(0, 60))}</h1>
<div class="grid">
  <div class="card"><div class="label">状態</div><div class="value">${badge(c.status as string)}</div></div>
  <div class="card"><div class="label">作成</div><div class="value" style="font-size:14px">${c.created_at}</div></div>
</div>
<h2>ヒアリングログ</h2>
${hearingHtml}
<h2>要件定義</h2>
<pre>${escapeHtml((c.requirements as string) || '(未作成)')}</pre>
<h2>生成ファイル</h2>
${files.length > 0 ? `<ul>${files.map(f => `<li>${escapeHtml(f)}</li>`).join('')}</ul>` : '<p>(なし)</p>'}
<p><a href="/admin">← 戻る</a></p>`;
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

// Re-export config for views
import { config } from '../config';
