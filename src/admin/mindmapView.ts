/**
 * 記憶マインドマップ - HTML/CSS/JSテンプレート生成
 *
 * D3.js v7 (CDN) によるforce-directedグラフで
 * memories・agent_memoriesテーブルをマインドマップ表示する。
 */

export function renderMindmapPage(): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>記憶マインドマップ - 母艦管理</title>
<script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f1117; color: #e1e4e8; overflow: hidden; height: 100vh; display: flex; flex-direction: column; }

  /* ── ナビゲーション ── */
  nav { background: #161b22; padding: 10px 20px; border-bottom: 1px solid #30363d; display: flex; align-items: center; flex-wrap: wrap; gap: 4px 0; flex-shrink: 0; }
  nav a { color: #8b949e; text-decoration: none; margin-right: 6px; font-size: 14px; padding: 4px 12px; border-radius: 6px; transition: color 0.15s, background 0.15s; }
  nav a:hover { color: #e1e4e8; background: #21262d; }
  nav a.active { color: #f0f6fc; background: #30363d; font-weight: 600; }
  nav .brand { color: #f0f6fc; font-weight: bold; font-size: 16px; margin-right: 20px; padding: 4px 0; }
  nav .brand:hover { background: none; }

  /* ── SVGキャンバス ── */
  #graph-container { flex: 1; position: relative; overflow: hidden; }
  #mindmap-svg { width: 100%; height: 100%; display: block; }

  /* ── ノード ── */
  .node circle { cursor: pointer; stroke-width: 2; transition: stroke 0.15s; }
  .node circle:hover { stroke: #f0f6fc; }
  .node.selected circle { stroke: #f0c040 !important; stroke-width: 3; }
  .node text { pointer-events: none; font-size: 11px; fill: #e1e4e8; text-anchor: middle; dominant-baseline: middle; }
  .node.root text { font-size: 14px; font-weight: bold; fill: #f0f6fc; }
  .node.table-node text { font-size: 12px; font-weight: 600; }
  .node.group-node text { font-size: 11px; }
  .node.leaf text { font-size: 10px; }

  .link { stroke: #30363d; stroke-opacity: 0.6; fill: none; }
  .link.to-root { stroke: #484f58; stroke-width: 2; }
  .link.to-table { stroke: #3d4450; stroke-width: 1.5; }
  .link.to-group { stroke: #30363d; stroke-width: 1; }
  .link.to-leaf { stroke: #21262d; stroke-width: 1; stroke-opacity: 0.4; }

  /* ── 右サイドパネル ── */
  #side-panel {
    position: fixed; right: 0; top: 0; height: 100vh; width: 340px;
    background: #161b22; border-left: 1px solid #30363d;
    padding: 20px; overflow-y: auto; z-index: 100;
    transform: translateX(100%); transition: transform 0.25s ease;
    display: flex; flex-direction: column; gap: 12px;
  }
  #side-panel.open { transform: translateX(0); }
  #side-panel h2 { font-size: 15px; color: #f0f6fc; border-bottom: 1px solid #30363d; padding-bottom: 8px; }
  #side-panel .close-btn { position: absolute; top: 16px; right: 16px; background: none; border: none; color: #8b949e; font-size: 20px; cursor: pointer; line-height: 1; }
  #side-panel .close-btn:hover { color: #e1e4e8; }
  .detail-row { display: flex; flex-direction: column; gap: 2px; }
  .detail-row .label { font-size: 11px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.5px; }
  .detail-row .value { font-size: 13px; color: #c9d1d9; word-break: break-all; background: #1c2128; padding: 6px 8px; border-radius: 4px; }
  .detail-row .value.content { white-space: pre-wrap; max-height: 160px; overflow-y: auto; }
  .panel-actions { display: flex; gap: 8px; margin-top: 8px; }
  .btn { padding: 7px 16px; border-radius: 6px; border: none; cursor: pointer; font-size: 13px; font-weight: 600; transition: opacity 0.15s; }
  .btn:hover { opacity: 0.85; }
  .btn-primary { background: #238636; color: #fff; }
  .btn-warning { background: #9e6a03; color: #fff; }
  .btn-danger { background: #da3633; color: #fff; }
  .btn-secondary { background: #30363d; color: #c9d1d9; }
  .badge-embedding { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; }
  .badge-yes { background: #0c2d48; color: #4A90D9; }
  .badge-no { background: #21262d; color: #999; }

  /* ── モーダル共通 ── */
  .modal-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.7);
    display: flex; align-items: center; justify-content: center;
    z-index: 200; opacity: 0; pointer-events: none; transition: opacity 0.2s;
  }
  .modal-overlay.open { opacity: 1; pointer-events: all; }
  .modal {
    background: #161b22; border: 1px solid #30363d; border-radius: 10px;
    padding: 24px; width: 480px; max-width: 95vw; max-height: 90vh;
    overflow-y: auto; display: flex; flex-direction: column; gap: 14px;
  }
  .modal h3 { font-size: 16px; color: #f0f6fc; border-bottom: 1px solid #30363d; padding-bottom: 8px; }
  .form-group { display: flex; flex-direction: column; gap: 5px; }
  .form-group label { font-size: 12px; color: #8b949e; }
  .form-group input, .form-group select, .form-group textarea {
    background: #0f1117; border: 1px solid #30363d; border-radius: 6px;
    color: #e1e4e8; padding: 7px 10px; font-size: 13px; font-family: inherit;
    outline: none; transition: border-color 0.15s;
  }
  .form-group input:focus, .form-group select:focus, .form-group textarea:focus { border-color: #58a6ff; }
  .form-group textarea { resize: vertical; min-height: 100px; }
  .form-group select option { background: #161b22; }
  .modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 4px; }

  /* ── フローティング追加ボタン ── */
  #fab {
    position: fixed; bottom: 28px; right: 28px; z-index: 150;
    width: 52px; height: 52px; border-radius: 50%;
    background: #238636; border: none; cursor: pointer;
    font-size: 26px; color: #fff; line-height: 1;
    box-shadow: 0 4px 12px rgba(0,0,0,0.4);
    display: flex; align-items: center; justify-content: center;
    transition: background 0.15s, transform 0.15s;
  }
  #fab:hover { background: #2ea043; transform: scale(1.08); }

  /* ── ツールチップ ── */
  #tooltip {
    position: fixed; background: #1c2128; border: 1px solid #30363d;
    border-radius: 6px; padding: 6px 10px; font-size: 12px; color: #c9d1d9;
    pointer-events: none; z-index: 300; max-width: 240px;
    opacity: 0; transition: opacity 0.15s;
    white-space: pre-wrap; word-break: break-all;
  }

  /* ── ローディング ── */
  #loading {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    color: #8b949e; font-size: 14px; background: #0f1117; z-index: 50;
  }

  /* ── レジェンド ── */
  #legend {
    position: fixed; bottom: 20px; left: 20px; background: #161b22;
    border: 1px solid #30363d; border-radius: 8px; padding: 10px 14px;
    font-size: 12px; z-index: 50; display: flex; flex-direction: column; gap: 5px;
  }
  #legend .legend-title { color: #8b949e; font-size: 11px; margin-bottom: 2px; }
  #legend .legend-row { display: flex; align-items: center; gap: 7px; color: #c9d1d9; }
  #legend .dot { width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0; }

  /* ── エラートースト ── */
  #toast {
    position: fixed; top: 70px; left: 50%; transform: translateX(-50%);
    background: #3d1418; border: 1px solid #f85149; border-radius: 8px;
    padding: 10px 18px; color: #f85149; font-size: 13px; z-index: 500;
    opacity: 0; pointer-events: none; transition: opacity 0.2s;
  }
  #toast.show { opacity: 1; }
  #toast.success { background: #1b4332; border-color: #2dd4bf; color: #2dd4bf; }
</style>
</head>
<body>

<nav>
  <span class="brand">⚡ 母艦</span>
  <a href="/admin">ダッシュボード</a>
  <a href="/admin/dev">開発</a>
  <a href="/admin/insights">改善</a>
  <a href="/admin/live">オフィス</a>
  <a href="/admin/knowledge">ナレッジ</a>
  <a href="/admin/mindmap" class="active">記憶MAP</a>
</nav>

<div id="graph-container">
  <div id="loading">データを読み込み中...</div>
  <svg id="mindmap-svg"></svg>
</div>

<!-- 右サイドパネル -->
<div id="side-panel">
  <button class="close-btn" onclick="closePanel()">×</button>
  <h2 id="panel-title">記憶の詳細</h2>
  <div id="panel-content"></div>
  <div class="panel-actions" id="panel-actions" style="display:none;">
    <button class="btn btn-warning" onclick="openEditModal()">編集</button>
    <button class="btn btn-danger" onclick="confirmDelete()">削除</button>
  </div>
</div>

<!-- フローティング追加ボタン -->
<button id="fab" onclick="openAddModal()" title="記憶を追加">+</button>

<!-- ツールチップ -->
<div id="tooltip"></div>

<!-- トースト -->
<div id="toast"></div>

<!-- レジェンド -->
<div id="legend">
  <div class="legend-title">凡例</div>
  <div class="legend-row"><div class="dot" style="background:#4A90D9;"></div>embedding あり</div>
  <div class="legend-row"><div class="dot" style="background:#999;"></div>embedding なし</div>
  <div class="legend-row"><div class="dot" style="background:#2dd4bf; width:8px; height:8px;"></div>小 (importance 1)</div>
  <div class="legend-row"><div class="dot" style="background:#2dd4bf; width:16px; height:16px;"></div>大 (importance 5)</div>
</div>

<!-- 編集モーダル -->
<div class="modal-overlay" id="edit-modal-overlay">
  <div class="modal">
    <h3>記憶を編集</h3>
    <div class="form-group">
      <label>content</label>
      <textarea id="edit-content" rows="5"></textarea>
    </div>
    <div class="form-group">
      <label>importance (1〜5)</label>
      <select id="edit-importance">
        <option value="1">1 - 低</option>
        <option value="2">2</option>
        <option value="3" selected>3 - 普通</option>
        <option value="4">4</option>
        <option value="5">5 - 高</option>
      </select>
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeEditModal()">キャンセル</button>
      <button class="btn btn-primary" onclick="submitEdit()">保存</button>
    </div>
  </div>
</div>

<!-- 追加モーダル -->
<div class="modal-overlay" id="add-modal-overlay">
  <div class="modal">
    <h3>記憶を追加</h3>
    <div class="form-group">
      <label>テーブル</label>
      <select id="add-table" onchange="onAddTableChange()">
        <option value="memories">memories（ユーザー記憶）</option>
        <option value="agent_memories">agent_memories（エージェント記憶）</option>
      </select>
    </div>
    <div class="form-group" id="add-userid-group">
      <label>user_id</label>
      <input type="text" id="add-userid" placeholder="例: U1234abcd">
    </div>
    <div class="form-group" id="add-agent-group" style="display:none;">
      <label>agent</label>
      <input type="text" id="add-agent" placeholder="例: soico">
    </div>
    <div class="form-group">
      <label>type</label>
      <input type="text" id="add-type" placeholder="例: profile, project, memo">
    </div>
    <div class="form-group">
      <label>key</label>
      <input type="text" id="add-key" placeholder="例: user_name">
    </div>
    <div class="form-group">
      <label>content</label>
      <textarea id="add-content" rows="4" placeholder="記憶の内容"></textarea>
    </div>
    <div class="form-group">
      <label>importance (1〜5)</label>
      <select id="add-importance">
        <option value="1">1 - 低</option>
        <option value="2">2</option>
        <option value="3" selected>3 - 普通</option>
        <option value="4">4</option>
        <option value="5">5 - 高</option>
      </select>
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeAddModal()">キャンセル</button>
      <button class="btn btn-primary" onclick="submitAdd()">追加</button>
    </div>
  </div>
</div>

<!-- 削除確認ダイアログ -->
<div class="modal-overlay" id="delete-modal-overlay">
  <div class="modal" style="max-width:380px;">
    <h3>削除の確認</h3>
    <p style="color:#c9d1d9; font-size:13px;" id="delete-confirm-text">この記憶を削除しますか？</p>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeDeleteModal()">キャンセル</button>
      <button class="btn btn-danger" onclick="submitDelete()">削除する</button>
    </div>
  </div>
</div>

<script>
// ── グローバル状態 ──
let allData = [];
let selectedNode = null;
let simulation = null;
let svg = null;
let g = null; // ズーム用グループ

// ── データ取得 ──
async function fetchData() {
  const res = await fetch('/admin/mindmap/api/memories');
  if (!res.ok) throw new Error('データ取得失敗: ' + res.status);
  return res.json();
}

// ── ツリー構築 ──
function buildGraph(data) {
  const nodes = [];
  const links = [];
  let idCounter = 0;
  const makeId = () => 'n' + (idCounter++);

  // 中心ノード
  const rootId = makeId();
  nodes.push({ id: rootId, label: '記憶', type: 'root', r: 28, color: '#58a6ff', stroke: '#1f4e79' });

  // テーブル別グループ
  const tables = ['memories', 'agent_memories'];
  const tableColors = { memories: '#2dd4bf', agent_memories: '#bc8cff' };
  const tableStrokes = { memories: '#0d4a43', agent_memories: '#4a1e7d' };

  for (const table of tables) {
    const tableData = data.filter(d => d.table === table);
    if (tableData.length === 0) continue;

    const tableId = makeId();
    nodes.push({ id: tableId, label: table, type: 'table', r: 20, color: tableColors[table], stroke: tableStrokes[table] });
    links.push({ source: rootId, target: tableId, linkType: 'to-root' });

    // グループキー: memoriesはuser_id、agent_memoriesはagent
    const groupKey = table === 'memories' ? 'user_id' : 'agent';
    const groups = {};
    for (const row of tableData) {
      const gk = row[groupKey] || '(unknown)';
      if (!groups[gk]) groups[gk] = [];
      groups[gk].push(row);
    }

    for (const [groupVal, rows] of Object.entries(groups)) {
      const groupId = makeId();
      const shortGroupVal = groupVal.length > 14 ? groupVal.slice(0, 12) + '…' : groupVal;
      nodes.push({ id: groupId, label: shortGroupVal, type: 'group', r: 15, color: '#484f58', stroke: '#30363d', fullLabel: groupVal });
      links.push({ source: tableId, target: groupId, linkType: 'to-table' });

      // typeサブグループ
      const typeGroups = {};
      for (const row of rows) {
        const t = row.type || '(unknown)';
        if (!typeGroups[t]) typeGroups[t] = [];
        typeGroups[t].push(row);
      }

      for (const [typeVal, typeRows] of Object.entries(typeGroups)) {
        const typeId = makeId();
        nodes.push({ id: typeId, label: typeVal, type: 'type', r: 12, color: '#3d4450', stroke: '#21262d' });
        links.push({ source: groupId, target: typeId, linkType: 'to-group' });

        // 個別記憶ノード
        for (const row of typeRows) {
          const leafId = makeId();
          const imp = row.importance ?? 3;
          const r = 8 + imp * 4;
          const color = row.has_embedding ? '#4A90D9' : '#999';
          const stroke = row.has_embedding ? '#1a3d6e' : '#555';
          const shortKey = row.key.length > 12 ? row.key.slice(0, 10) + '…' : row.key;
          nodes.push({
            id: leafId,
            label: shortKey,
            type: 'leaf',
            r,
            color,
            stroke,
            data: row,   // 元データを保持
          });
          links.push({ source: typeId, target: leafId, linkType: 'to-leaf' });
        }
      }
    }
  }

  return { nodes, links };
}

// ── D3描画 ──
function render(data) {
  const container = document.getElementById('graph-container');
  const W = container.clientWidth;
  const H = container.clientHeight;

  // 既存のSVGをクリア
  d3.select('#mindmap-svg').selectAll('*').remove();

  svg = d3.select('#mindmap-svg')
    .attr('viewBox', [0, 0, W, H])
    .attr('preserveAspectRatio', 'xMidYMid meet');

  // ズーム・パン
  const zoom = d3.zoom()
    .scaleExtent([0.2, 4])
    .on('zoom', (event) => {
      g.attr('transform', event.transform);
    });
  svg.call(zoom);

  g = svg.append('g');

  const { nodes, links } = buildGraph(data);

  // シミュレーション
  simulation = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(d => d.id).distance(d => {
      if (d.linkType === 'to-root') return 120;
      if (d.linkType === 'to-table') return 90;
      if (d.linkType === 'to-group') return 70;
      return 55;
    }).strength(0.6))
    .force('charge', d3.forceManyBody().strength(d => {
      if (d.type === 'root') return -800;
      if (d.type === 'table') return -400;
      if (d.type === 'group') return -200;
      if (d.type === 'type') return -150;
      return -80;
    }))
    .force('center', d3.forceCenter(W / 2, H / 2).strength(0.05))
    .force('collision', d3.forceCollide().radius(d => d.r + 6));

  // リンク描画
  const link = g.append('g').attr('class', 'links')
    .selectAll('line')
    .data(links)
    .join('line')
    .attr('class', d => 'link ' + d.linkType);

  // ノードグループ描画
  const node = g.append('g').attr('class', 'nodes')
    .selectAll('g')
    .data(nodes)
    .join('g')
    .attr('class', d => 'node ' + d.type + '-node' + (d.type === 'root' ? ' root' : '') + (d.type === 'leaf' ? ' leaf' : ''))
    .call(d3.drag()
      .on('start', dragStarted)
      .on('drag', dragged)
      .on('end', dragEnded)
    )
    .on('click', (event, d) => {
      event.stopPropagation();
      if (d.data) {
        selectNode(d);
      }
    })
    .on('mouseover', (event, d) => showTooltip(event, d))
    .on('mousemove', (event) => moveTooltip(event))
    .on('mouseout', () => hideTooltip());

  node.append('circle')
    .attr('r', d => d.r)
    .attr('fill', d => d.color)
    .attr('stroke', d => d.stroke)
    .attr('stroke-width', 2);

  node.append('text')
    .attr('dy', d => d.type === 'leaf' ? d.r + 11 : 0)
    .text(d => d.label);

  // グラフ全体クリックでパネルを閉じる
  svg.on('click', () => {
    deselectNode();
    closePanel();
  });

  // シミュレーションtick
  simulation.on('tick', () => {
    link
      .attr('x1', d => d.source.x)
      .attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x)
      .attr('y2', d => d.target.y);
    node.attr('transform', d => \`translate(\${d.x},\${d.y})\`);
  });
}

// ── ドラッグ ──
function dragStarted(event, d) {
  if (!event.active) simulation.alphaTarget(0.3).restart();
  d.fx = d.x; d.fy = d.y;
}
function dragged(event, d) { d.fx = event.x; d.fy = event.y; }
function dragEnded(event, d) {
  if (!event.active) simulation.alphaTarget(0);
  d.fx = null; d.fy = null;
}

// ── ノード選択 ──
function selectNode(d) {
  selectedNode = d;
  // 選択スタイル
  d3.selectAll('.node').classed('selected', n => n === d);
  showPanel(d.data);
}
function deselectNode() {
  selectedNode = null;
  d3.selectAll('.node').classed('selected', false);
}

// ── サイドパネル ──
function showPanel(row) {
  const panel = document.getElementById('side-panel');
  const title = document.getElementById('panel-title');
  const content = document.getElementById('panel-content');
  const actions = document.getElementById('panel-actions');

  title.textContent = row.key;

  const groupLabel = row.table === 'memories' ? 'user_id' : 'agent';
  const groupVal = row.table === 'memories' ? row.user_id : row.agent;
  const imp = row.importance ?? 3;

  content.innerHTML = \`
    <div class="detail-row"><div class="label">ID</div><div class="value">\${esc(String(row.id))}</div></div>
    <div class="detail-row"><div class="label">テーブル</div><div class="value">\${esc(row.table)}</div></div>
    <div class="detail-row"><div class="label">\${esc(groupLabel)}</div><div class="value">\${esc(groupVal || '')}</div></div>
    <div class="detail-row"><div class="label">type</div><div class="value">\${esc(row.type)}</div></div>
    <div class="detail-row"><div class="label">key</div><div class="value">\${esc(row.key)}</div></div>
    <div class="detail-row"><div class="label">content</div><div class="value content">\${esc(row.content)}</div></div>
    <div class="detail-row"><div class="label">importance</div><div class="value">\${esc(String(imp))}</div></div>
    <div class="detail-row"><div class="label">embedding</div><div class="value"><span class="badge-embedding \${row.has_embedding ? 'badge-yes' : 'badge-no'}">\${row.has_embedding ? 'あり' : 'なし'}</span></div></div>
    \${row.source ? \`<div class="detail-row"><div class="label">source</div><div class="value">\${esc(row.source)}</div></div>\` : ''}
    <div class="detail-row"><div class="label">created_at</div><div class="value">\${esc(row.created_at)}</div></div>
    <div class="detail-row"><div class="label">updated_at</div><div class="value">\${esc(row.updated_at)}</div></div>
  \`;

  actions.style.display = 'flex';
  panel.classList.add('open');
}

function closePanel() {
  document.getElementById('side-panel').classList.remove('open');
  document.getElementById('panel-actions').style.display = 'none';
}

// ── ツールチップ ──
function showTooltip(event, d) {
  const tooltip = document.getElementById('tooltip');
  let text = d.label;
  if (d.fullLabel) text = d.fullLabel;
  if (d.data) {
    const imp = d.data.importance ?? 3;
    text = d.data.key + '\\n' + (d.data.content || '').slice(0, 80) + (d.data.content?.length > 80 ? '…' : '') + '\\nimportance: ' + imp;
  }
  tooltip.textContent = text;
  tooltip.style.opacity = '1';
  moveTooltip(event);
}
function moveTooltip(event) {
  const t = document.getElementById('tooltip');
  t.style.left = (event.clientX + 14) + 'px';
  t.style.top = (event.clientY - 10) + 'px';
}
function hideTooltip() {
  document.getElementById('tooltip').style.opacity = '0';
}

// ── 編集モーダル ──
function openEditModal() {
  if (!selectedNode || !selectedNode.data) return;
  const row = selectedNode.data;
  const imp = row.importance ?? 3;
  document.getElementById('edit-content').value = row.content || '';
  document.getElementById('edit-importance').value = String(imp);
  document.getElementById('edit-modal-overlay').classList.add('open');
}
function closeEditModal() {
  document.getElementById('edit-modal-overlay').classList.remove('open');
}
async function submitEdit() {
  if (!selectedNode || !selectedNode.data) return;
  const row = selectedNode.data;
  const content = document.getElementById('edit-content').value.trim();
  const importance = parseInt(document.getElementById('edit-importance').value, 10);
  if (!content) { showToast('contentを入力してください', false); return; }
  try {
    const res = await fetch(\`/admin/mindmap/api/memories/\${encodeURIComponent(row.id)}?table=\${encodeURIComponent(row.table)}\`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, importance }),
    });
    if (!res.ok) throw new Error(await res.text());
    closeEditModal();
    closePanel();
    showToast('更新しました', true);
    await reloadGraph();
  } catch (e) {
    showToast('更新失敗: ' + e.message, false);
  }
}

// ── 追加モーダル ──
function openAddModal() {
  document.getElementById('add-table').value = 'memories';
  document.getElementById('add-userid').value = '';
  document.getElementById('add-agent').value = '';
  document.getElementById('add-type').value = '';
  document.getElementById('add-key').value = '';
  document.getElementById('add-content').value = '';
  document.getElementById('add-importance').value = '3';
  onAddTableChange();
  document.getElementById('add-modal-overlay').classList.add('open');
}
function closeAddModal() {
  document.getElementById('add-modal-overlay').classList.remove('open');
}
function onAddTableChange() {
  const table = document.getElementById('add-table').value;
  document.getElementById('add-userid-group').style.display = table === 'memories' ? '' : 'none';
  document.getElementById('add-agent-group').style.display = table === 'agent_memories' ? '' : 'none';
}
async function submitAdd() {
  const table = document.getElementById('add-table').value;
  const user_id = document.getElementById('add-userid').value.trim();
  const agent = document.getElementById('add-agent').value.trim();
  const type = document.getElementById('add-type').value.trim();
  const key = document.getElementById('add-key').value.trim();
  const content = document.getElementById('add-content').value.trim();
  const importance = parseInt(document.getElementById('add-importance').value, 10);

  if (!type || !key || !content) { showToast('type / key / content は必須です', false); return; }
  if (table === 'memories' && !user_id) { showToast('user_id は必須です', false); return; }
  if (table === 'agent_memories' && !agent) { showToast('agent は必須です', false); return; }

  try {
    const res = await fetch('/admin/mindmap/api/memories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ table, user_id, agent, type, key, content, importance }),
    });
    if (!res.ok) throw new Error(await res.text());
    closeAddModal();
    showToast('追加しました', true);
    await reloadGraph();
  } catch (e) {
    showToast('追加失敗: ' + e.message, false);
  }
}

// ── 削除 ──
function confirmDelete() {
  if (!selectedNode || !selectedNode.data) return;
  const row = selectedNode.data;
  document.getElementById('delete-confirm-text').textContent =
    \`「\${row.key}」を削除しますか？この操作は取り消せません。\`;
  document.getElementById('delete-modal-overlay').classList.add('open');
}
function closeDeleteModal() {
  document.getElementById('delete-modal-overlay').classList.remove('open');
}
async function submitDelete() {
  if (!selectedNode || !selectedNode.data) return;
  const row = selectedNode.data;
  try {
    const res = await fetch(\`/admin/mindmap/api/memories/\${encodeURIComponent(row.id)}?table=\${encodeURIComponent(row.table)}\`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error(await res.text());
    closeDeleteModal();
    closePanel();
    deselectNode();
    showToast('削除しました', true);
    await reloadGraph();
  } catch (e) {
    showToast('削除失敗: ' + e.message, false);
  }
}

// ── グラフ再描画 ──
async function reloadGraph() {
  try {
    allData = await fetchData();
    render(allData);
  } catch (e) {
    showToast('再描画失敗: ' + e.message, false);
  }
}

// ── トースト ──
function showToast(msg, success = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'show' + (success ? ' success' : '');
  setTimeout(() => { t.className = ''; }, 3000);
}

// ── エスケープ ──
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── ESCキー ──
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeEditModal();
    closeAddModal();
    closeDeleteModal();
    closePanel();
    deselectNode();
  }
});

// ── 初期化 ──
(async () => {
  try {
    allData = await fetchData();
    document.getElementById('loading').style.display = 'none';
    render(allData);
  } catch (e) {
    document.getElementById('loading').textContent = 'データ取得エラー: ' + e.message;
  }
})();

// ウィンドウリサイズ対応
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (allData.length > 0) render(allData); }, 300);
});
</script>
</body>
</html>`;
}
