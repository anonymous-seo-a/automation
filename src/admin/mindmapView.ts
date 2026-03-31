export function renderMindmapPage(): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>記憶マインドマップ</title>
<script src="https://d3js.org/d3.v7.min.js"></script>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', sans-serif; background: #1a1a2e; color: #e0e0e0; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }

  #header {
    background: #16213e;
    padding: 10px 20px;
    display: flex;
    align-items: center;
    gap: 16px;
    border-bottom: 1px solid #0f3460;
    flex-shrink: 0;
  }
  #header a { color: #4A90D9; text-decoration: none; font-size: 14px; }
  #header a:hover { text-decoration: underline; }
  #header h1 { font-size: 18px; color: #e0e0e0; }

  #main {
    display: flex;
    flex: 1;
    overflow: hidden;
  }

  #graph-container {
    flex: 1;
    position: relative;
    overflow: hidden;
  }

  #graph-svg {
    width: 100%;
    height: 100%;
    cursor: grab;
  }
  #graph-svg:active { cursor: grabbing; }

  .node circle {
    stroke-width: 2;
    cursor: pointer;
    transition: filter 0.2s;
  }
  .node circle:hover { filter: brightness(1.3); }
  .node text {
    font-size: 11px;
    fill: #e0e0e0;
    pointer-events: none;
    text-anchor: middle;
    dominant-baseline: central;
  }
  .link {
    stroke: #334;
    stroke-opacity: 0.6;
    stroke-width: 1.5;
    fill: none;
  }

  #side-panel {
    width: 350px;
    background: #16213e;
    border-left: 1px solid #0f3460;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    flex-shrink: 0;
    transition: transform 0.3s;
  }
  #side-panel.hidden { transform: translateX(350px); width: 0; border: none; }

  #panel-header {
    padding: 14px 16px;
    background: #0f3460;
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-shrink: 0;
  }
  #panel-header h2 { font-size: 15px; }
  #panel-close { background: none; border: none; color: #aaa; font-size: 18px; cursor: pointer; line-height: 1; }
  #panel-close:hover { color: #fff; }

  #panel-content {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
  }
  .detail-row { margin-bottom: 12px; }
  .detail-label { font-size: 11px; color: #888; margin-bottom: 3px; text-transform: uppercase; letter-spacing: 0.5px; }
  .detail-value { font-size: 13px; word-break: break-all; }
  .detail-value.content-val { background: #1a1a2e; padding: 8px; border-radius: 4px; white-space: pre-wrap; max-height: 200px; overflow-y: auto; }

  #panel-actions { padding: 12px 16px; border-top: 1px solid #0f3460; display: flex; gap: 10px; flex-shrink: 0; }
  .btn { padding: 8px 16px; border: none; border-radius: 5px; cursor: pointer; font-size: 13px; font-weight: 600; }
  .btn-edit { background: #4A90D9; color: #fff; }
  .btn-edit:hover { background: #357abd; }
  .btn-delete { background: #c0392b; color: #fff; }
  .btn-delete:hover { background: #962d22; }
  .btn-cancel { background: #555; color: #fff; }
  .btn-cancel:hover { background: #444; }
  .btn-save { background: #27ae60; color: #fff; }
  .btn-save:hover { background: #1e8449; }

  #fab {
    position: absolute;
    right: 370px;
    bottom: 30px;
    width: 52px;
    height: 52px;
    border-radius: 50%;
    background: #4A90D9;
    color: #fff;
    font-size: 28px;
    border: none;
    cursor: pointer;
    box-shadow: 0 4px 12px rgba(74,144,217,0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
    transition: background 0.2s, right 0.3s;
    z-index: 10;
  }
  #fab:hover { background: #357abd; }

  .modal-overlay {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.7);
    z-index: 100;
    align-items: center;
    justify-content: center;
  }
  .modal-overlay.show { display: flex; }
  .modal {
    background: #16213e;
    border: 1px solid #0f3460;
    border-radius: 8px;
    width: 460px;
    max-width: 95vw;
    max-height: 90vh;
    overflow-y: auto;
    padding: 24px;
  }
  .modal h3 { font-size: 16px; margin-bottom: 18px; }
  .form-group { margin-bottom: 14px; }
  .form-group label { display: block; font-size: 12px; color: #aaa; margin-bottom: 5px; }
  .form-group input, .form-group textarea, .form-group select {
    width: 100%;
    background: #1a1a2e;
    border: 1px solid #0f3460;
    color: #e0e0e0;
    border-radius: 4px;
    padding: 8px 10px;
    font-size: 13px;
    font-family: inherit;
  }
  .form-group textarea { resize: vertical; min-height: 100px; }
  .radio-group { display: flex; gap: 16px; }
  .radio-group label { display: flex; align-items: center; gap: 6px; font-size: 13px; color: #e0e0e0; cursor: pointer; }
  .modal-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 18px; }

  #loading {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    color: #888;
    background: #1a1a2e;
    z-index: 5;
  }
  #error-msg { position: absolute; top: 20px; left: 50%; transform: translateX(-50%); background: #c0392b; color: #fff; padding: 10px 20px; border-radius: 5px; display: none; z-index: 50; }
</style>
</head>
<body>

<div id="header">
  <a href="/admin">← ダッシュボード</a>
  <h1>記憶マインドマップ</h1>
</div>

<div id="main">
  <div id="graph-container">
    <div id="loading">データ読み込み中...</div>
    <div id="error-msg"></div>
    <svg id="graph-svg"></svg>
    <button id="fab" title="記憶を追加">＋</button>
  </div>

  <div id="side-panel" class="hidden">
    <div id="panel-header">
      <h2>記憶の詳細</h2>
      <button id="panel-close">✕</button>
    </div>
    <div id="panel-content"></div>
    <div id="panel-actions">
      <button class="btn btn-edit" id="btn-edit">編集</button>
      <button class="btn btn-delete" id="btn-delete">削除</button>
    </div>
  </div>
</div>

<!-- 編集モーダル -->
<div class="modal-overlay" id="edit-modal">
  <div class="modal">
    <h3>記憶を編集</h3>
    <div class="form-group">
      <label>内容 (content)</label>
      <textarea id="edit-content" rows="5"></textarea>
    </div>
    <div class="form-group">
      <label>重要度 (importance)</label>
      <select id="edit-importance">
        <option value="1">1 - 低</option>
        <option value="2">2</option>
        <option value="3" selected>3 - 普通</option>
        <option value="4">4</option>
        <option value="5">5 - 高</option>
      </select>
    </div>
    <div class="modal-actions">
      <button class="btn btn-cancel" id="edit-cancel">キャンセル</button>
      <button class="btn btn-save" id="edit-save">保存</button>
    </div>
  </div>
</div>

<!-- 追加モーダル -->
<div class="modal-overlay" id="add-modal">
  <div class="modal">
    <h3>記憶を追加</h3>
    <div class="form-group">
      <label>テーブル</label>
      <div class="radio-group">
        <label><input type="radio" name="add-table" value="memories" checked> memories</label>
        <label><input type="radio" name="add-table" value="agent_memories"> agent_memories</label>
      </div>
    </div>
    <div class="form-group" id="add-userid-group">
      <label id="add-owner-label">user_id</label>
      <input type="text" id="add-owner" placeholder="例: U1234567890abcdef">
    </div>
    <div class="form-group">
      <label>type</label>
      <input type="text" id="add-type" placeholder="例: preference, fact">
    </div>
    <div class="form-group">
      <label>key</label>
      <input type="text" id="add-key" placeholder="例: favorite_color">
    </div>
    <div class="form-group">
      <label>content</label>
      <textarea id="add-content" rows="4" placeholder="記憶の内容..."></textarea>
    </div>
    <div class="form-group">
      <label>重要度 (importance)</label>
      <select id="add-importance">
        <option value="1">1 - 低</option>
        <option value="2">2</option>
        <option value="3" selected>3 - 普通</option>
        <option value="4">4</option>
        <option value="5">5 - 高</option>
      </select>
    </div>
    <div class="modal-actions">
      <button class="btn btn-cancel" id="add-cancel">キャンセル</button>
      <button class="btn btn-save" id="add-save">追加</button>
    </div>
  </div>
</div>

<script>
/* browser-side script, not type-checked */
(function() {
  // ---- State ----
  let allMemories = [];
  let selectedNode = null;
  let simulation = null;

  // ---- Color palette ----
  const COLORS = {
    root: '#e8a838',
    tableMemories: '#9b59b6',
    tableAgent: '#16a085',
    owner: '#2980b9',
    type: '#8e44ad',
    leafYes: '#4A90D9',
    leafNo: '#999'
  };

  // ---- Helpers ----
  function escHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function showError(msg) {
    const el = document.getElementById('error-msg');
    el.textContent = msg;
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 4000);
  }

  function leafRadius(importance) {
    const imp = Math.max(1, Math.min(5, Number(importance) || 3));
    return 8 + imp * 3.2;
  }

  // ---- Build tree from flat memories array ----
  function buildTree(memories) {
    const root = { id: '__root__', label: '記憶', level: 0, children: [], data: null };

    const tables = {};
    for (const mem of memories) {
      const tbl = mem.table;
      if (!tables[tbl]) {
        tables[tbl] = { id: '__tbl__' + tbl, label: tbl, level: 1, children: [], data: null };
        root.children.push(tables[tbl]);
      }
      const ownerKey = tbl === 'memories' ? (mem.user_id || '(unknown)') : (mem.agent || '(unknown)');
      const ownerId = '__owner__' + tbl + '__' + ownerKey;
      let ownerNode = tables[tbl].children.find(n => n.id === ownerId);
      if (!ownerNode) {
        ownerNode = { id: ownerId, label: ownerKey, level: 2, children: [], data: null };
        tables[tbl].children.push(ownerNode);
      }
      const typeKey = mem.type || '(none)';
      const typeId = '__type__' + tbl + '__' + ownerKey + '__' + typeKey;
      let typeNode = ownerNode.children.find(n => n.id === typeId);
      if (!typeNode) {
        typeNode = { id: typeId, label: typeKey, level: 3, children: [], data: null };
        ownerNode.children.push(typeNode);
      }
      typeNode.children.push({
        id: '__leaf__' + tbl + '__' + mem.id,
        label: mem.key || String(mem.id),
        level: 4,
        children: [],
        data: mem
      });
    }
    return root;
  }

  // ---- Flatten tree to nodes/links for D3 ----
  function flattenTree(root) {
    const nodes = [];
    const links = [];
    function walk(node, parent) {
      nodes.push(node);
      if (parent) links.push({ source: parent.id, target: node.id });
      for (const child of node.children) walk(child, node);
    }
    walk(root, null);
    return { nodes, links };
  }

  // ---- Node color ----
  function nodeColor(d) {
    if (d.level === 0) return COLORS.root;
    if (d.level === 1) return d.label === 'memories' ? COLORS.tableMemories : COLORS.tableAgent;
    if (d.level === 2) return COLORS.owner;
    if (d.level === 3) return COLORS.type;
    // leaf
    return d.data && (d.data.has_embedding ?? false) ? COLORS.leafYes : COLORS.leafNo;
  }

  function nodeRadius(d) {
    if (d.level === 0) return 22;
    if (d.level === 1) return 18;
    if (d.level === 2) return 14;
    if (d.level === 3) return 11;
    return leafRadius(d.data ? d.data.importance : 3);
  }

  // ---- Draw ----
  function draw(memories) {
    const root = buildTree(memories);
    const { nodes, links } = flattenTree(root);

    const svg = d3.select('#graph-svg');
    svg.selectAll('*').remove();

    const container = svg.append('g').attr('class', 'zoom-layer');

    const zoom = d3.zoom()
      .scaleExtent([0.1, 5])
      .on('zoom', (event) => container.attr('transform', event.transform));
    svg.call(zoom);

    const svgEl = svg.node();
    const width = svgEl ? (svgEl.clientWidth || 800) : 800;
    const height = svgEl ? (svgEl.clientHeight || 600) : 600;

    // Initial center
    svg.call(zoom.transform, d3.zoomIdentity.translate(width / 2, height / 2));

    // Build id->node map for links
    const nodeById = {};
    for (const n of nodes) nodeById[n.id] = n;

    const linkData = links.map(l => ({ source: nodeById[l.source], target: nodeById[l.target] }));

    simulation = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(linkData).id(d => d.id).distance(d => {
        const lvl = d.source.level;
        return lvl === 0 ? 120 : lvl === 1 ? 100 : lvl === 2 ? 80 : 60;
      }).strength(0.8))
      .force('charge', d3.forceManyBody().strength(d => {
        if (d.level === 0) return -800;
        if (d.level === 1) return -400;
        if (d.level === 2) return -200;
        if (d.level === 3) return -100;
        return -60;
      }))
      .force('collision', d3.forceCollide().radius(d => nodeRadius(d) + 4))
      .force('center', d3.forceCenter(0, 0));

    const link = container.append('g').attr('class', 'links')
      .selectAll('line')
      .data(linkData)
      .join('line')
      .attr('class', 'link');

    const node = container.append('g').attr('class', 'nodes')
      .selectAll('g')
      .data(nodes)
      .join('g')
      .attr('class', 'node')
      .call(d3.drag()
        .on('start', (event, d) => {
          if (!event.active) simulation.alphaTarget(0.3).restart();
          d.fx = d.x; d.fy = d.y;
        })
        .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
        .on('end', (event, d) => {
          if (!event.active) simulation.alphaTarget(0);
          d.fx = null; d.fy = null;
        })
      )
      .on('click', (event, d) => {
        event.stopPropagation();
        if (d.data) showPanel(d.data);
      });

    node.append('circle')
      .attr('r', d => nodeRadius(d))
      .attr('fill', d => nodeColor(d))
      .attr('stroke', d => { const c = d3.color(nodeColor(d)); return c ? c.darker(0.5).toString() : '#333'; });

    node.append('text')
      .text(d => {
        const maxLen = d.level === 4 ? 10 : 14;
        const lbl = d.label || '';
        return lbl.length > maxLen ? lbl.slice(0, maxLen) + '…' : lbl;
      })
      .attr('y', d => nodeRadius(d) + 10)
      .attr('dominant-baseline', 'auto')
      .style('font-size', d => (d.level === 0 ? 13 : d.level <= 2 ? 11 : 10) + 'px');

    simulation.on('tick', () => {
      link
        .attr('x1', d => d.source.x)
        .attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x)
        .attr('y2', d => d.target.y);
      node.attr('transform', d => \`translate(\${d.x},\${d.y})\`);
    });

    // Click on blank = deselect
    svg.on('click', () => hidePanel());
  }

  // ---- Side panel ----
  function showPanel(mem) {
    selectedNode = mem;
    const panel = document.getElementById('side-panel');
    panel.classList.remove('hidden');
    document.getElementById('fab').style.right = '370px';

    const fmt = v => v ? new Date(v).toLocaleString('ja-JP') : '-';
    const ownerLabel = mem.table === 'memories' ? 'user_id' : 'agent';
    const ownerVal = mem.table === 'memories' ? (mem.user_id || '-') : (mem.agent || '-');

    document.getElementById('panel-content').innerHTML =
      '<div class="detail-row"><div class="detail-label">ID</div><div class="detail-value">' + escHtml(String(mem.id)) + '</div></div>' +
      '<div class="detail-row"><div class="detail-label">テーブル</div><div class="detail-value">' + escHtml(String(mem.table)) + '</div></div>' +
      '<div class="detail-row"><div class="detail-label">' + escHtml(ownerLabel) + '</div><div class="detail-value">' + escHtml(String(ownerVal)) + '</div></div>' +
      '<div class="detail-row"><div class="detail-label">type</div><div class="detail-value">' + escHtml(String(mem.type || '-')) + '</div></div>' +
      '<div class="detail-row"><div class="detail-label">key</div><div class="detail-value">' + escHtml(String(mem.key || '-')) + '</div></div>' +
      '<div class="detail-row"><div class="detail-label">content</div><div class="detail-value content-val">' + escHtml(String(mem.content || '')) + '</div></div>' +
      '<div class="detail-row"><div class="detail-label">importance</div><div class="detail-value">' + escHtml(String(mem.importance ?? 3)) + '</div></div>' +
      '<div class="detail-row"><div class="detail-label">embedding</div><div class="detail-value">' + escHtml(mem.has_embedding ? 'あり' : 'なし') + '</div></div>' +
      '<div class="detail-row"><div class="detail-label">作成日時</div><div class="detail-value">' + escHtml(fmt(mem.created_at)) + '</div></div>' +
      '<div class="detail-row"><div class="detail-label">更新日時</div><div class="detail-value">' + escHtml(fmt(mem.updated_at)) + '</div></div>';
  }

  function hidePanel() {
    selectedNode = null;
    document.getElementById('side-panel').classList.add('hidden');
    document.getElementById('fab').style.right = '30px';
  }

  // ---- Fetch + redraw ----
  async function loadAndDraw() {
    document.getElementById('loading').style.display = 'flex';
    try {
      const res = await fetch('./api/memories');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      allMemories = await res.json();
      document.getElementById('loading').style.display = 'none';
      draw(allMemories);
    } catch (e) {
      document.getElementById('loading').style.display = 'none';
      showError('データ取得エラー: ' + e.message);
    }
  }

  // ---- Edit modal ----
  document.getElementById('btn-edit').addEventListener('click', () => {
    if (!selectedNode) return;
    document.getElementById('edit-content').value = selectedNode.content || '';
    document.getElementById('edit-importance').value = String(selectedNode.importance ?? 3);
    document.getElementById('edit-modal').classList.add('show');
  });

  document.getElementById('edit-cancel').addEventListener('click', () => {
    document.getElementById('edit-modal').classList.remove('show');
  });

  document.getElementById('edit-save').addEventListener('click', async () => {
    if (!selectedNode) return;
    const body = {
      table: selectedNode.table,
      content: document.getElementById('edit-content').value,
      importance: parseInt(document.getElementById('edit-importance').value, 10)
    };
    try {
      const res = await fetch('./api/memories/' + selectedNode.id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      document.getElementById('edit-modal').classList.remove('show');
      hidePanel();
      await loadAndDraw();
    } catch (e) {
      showError('更新エラー: ' + e.message);
    }
  });

  // ---- Delete ----
  document.getElementById('btn-delete').addEventListener('click', async () => {
    if (!selectedNode) return;
    if (!window.confirm('記憶「' + String(selectedNode.key || selectedNode.id).replace(/[\r\n]/g, ' ') + '」を削除しますか？')) return;
    try {
      const res = await fetch('./api/memories/' + selectedNode.id, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ table: selectedNode.table })
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      hidePanel();
      await loadAndDraw();
    } catch (e) {
      showError('削除エラー: ' + e.message);
    }
  });

  document.getElementById('panel-close').addEventListener('click', hidePanel);

  // ---- Add modal ----
  document.getElementById('fab').addEventListener('click', () => {
    document.getElementById('add-modal').classList.add('show');
  });

  document.querySelectorAll('input[name="add-table"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      const isAgent = e.target.value === 'agent_memories';
      document.getElementById('add-owner-label').textContent = isAgent ? 'agent' : 'user_id';
      document.getElementById('add-owner').placeholder = isAgent ? '例: soico' : '例: U1234567890abcdef';
    });
  });

  document.getElementById('add-cancel').addEventListener('click', () => {
    document.getElementById('add-modal').classList.remove('show');
  });

  document.getElementById('add-save').addEventListener('click', async () => {
    const table = document.querySelector('input[name="add-table"]:checked').value;
    const owner = document.getElementById('add-owner').value.trim();
    const type = document.getElementById('add-type').value.trim();
    const key = document.getElementById('add-key').value.trim();
    const content = document.getElementById('add-content').value.trim();
    const importance = parseInt(document.getElementById('add-importance').value, 10);

    if (!owner || !key || !content) {
      showError('owner / key / content は必須です');
      return;
    }

    const body = {
      table,
      type,
      key,
      content,
      importance,
      ...(table === 'memories' ? { user_id: owner } : { agent: owner })
    };

    try {
      const res = await fetch('./api/memories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      document.getElementById('add-modal').classList.remove('show');
      // reset form
      document.getElementById('add-owner').value = '';
      document.getElementById('add-type').value = '';
      document.getElementById('add-key').value = '';
      document.getElementById('add-content').value = '';
      document.getElementById('add-importance').value = '3';
      await loadAndDraw();
    } catch (e) {
      showError('追加エラー: ' + e.message);
    }
  });

  // ---- Init ----
  loadAndDraw();
})();
</script>
</body>
</html>`;
}
