export function renderMindmapPage(): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>記憶マインドマップ - 母艦管理</title>
<script src="https://d3js.org/d3.v7.min.js"></script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f1117; color: #e1e4e8; line-height: 1.6; }
  nav { background: #161b22; padding: 12px 20px; border-bottom: 1px solid #30363d; display: flex; align-items: center; flex-wrap: wrap; gap: 4px 0; }
  nav a { color: #8b949e; text-decoration: none; margin-right: 6px; font-size: 14px; padding: 4px 12px; border-radius: 6px; transition: color 0.15s, background 0.15s; }
  nav a:hover { color: #e1e4e8; background: #21262d; }
  nav a.active { color: #f0f6fc; background: #30363d; font-weight: 600; }
  nav .brand { color: #f0f6fc; font-weight: bold; font-size: 16px; margin-right: 20px; padding: 4px 0; }
  nav .brand:hover { background: none; }
  #mindmap-container { width: 100vw; height: calc(100vh - 50px); overflow: hidden; position: relative; }
  svg { width: 100%; height: 100%; }
  .node circle { cursor: pointer; stroke-width: 2px; }
  .node text { font-size: 11px; fill: #e1e4e8; pointer-events: none; text-shadow: 0 1px 2px #0f1117, 0 -1px 2px #0f1117, 1px 0 2px #0f1117, -1px 0 2px #0f1117; }
  .link { stroke: #444c56; stroke-opacity: 0.7; fill: none; }
  #empty-message { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: #8b949e; font-size: 18px; display: none; }
  /* Modal */
  #modal-overlay {
    display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%;
    background: rgba(0,0,0,0.7); z-index: 1000; align-items: center; justify-content: center;
  }
  #modal-overlay.open { display: flex; }
  #modal {
    background: #161b22; border: 1px solid #30363d; border-radius: 10px;
    padding: 24px; width: 90%; max-width: 540px; max-height: 80vh;
    overflow-y: auto; position: relative;
  }
  #modal h2 { font-size: 16px; color: #f0f6fc; margin-bottom: 12px; word-break: break-all; }
  #modal .meta { font-size: 12px; color: #8b949e; margin-bottom: 12px; }
  #modal textarea {
    width: 100%; min-height: 140px; background: #0d1117; border: 1px solid #30363d;
    border-radius: 6px; color: #e1e4e8; font-size: 13px; padding: 10px;
    resize: vertical; font-family: inherit;
  }
  #modal .btn-row { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
  #modal button {
    padding: 7px 16px; border-radius: 6px; border: none; cursor: pointer;
    font-size: 13px; font-weight: 600; transition: opacity 0.15s;
  }
  #modal button:hover { opacity: 0.85; }
  #btn-save { background: #238636; color: #fff; }
  #btn-delete { background: #da3633; color: #fff; }
  #btn-close { background: #30363d; color: #e1e4e8; margin-left: auto; }
  #modal .status-msg { font-size: 12px; margin-top: 8px; min-height: 18px; }
  #modal .status-msg.ok { color: #3fb950; }
  #modal .status-msg.err { color: #f85149; }
</style>
</head>
<body>
<nav>
  <span class="brand">🚀 母艦</span>
  <a href="/admin">ダッシュボード</a>
  <a href="/admin/dev">開発</a>
  <a href="/admin/insights">改善</a>
  <a href="/admin/live">オフィス</a>
  <a href="/admin/knowledge">ナレッジ</a>
  <a href="/admin/mindmap" class="active">🧠 記憶マインドマップ</a>
</nav>
<div id="mindmap-container">
  <div id="empty-message">記憶データがありません</div>
</div>

<div id="modal-overlay">
  <div id="modal">
    <h2 id="modal-title"></h2>
    <div class="meta" id="modal-meta"></div>
    <textarea id="modal-content"></textarea>
    <div class="btn-row">
      <button id="btn-save">保存</button>
      <button id="btn-delete">削除</button>
      <button id="btn-close">閉じる</button>
    </div>
    <div class="status-msg" id="modal-status"></div>
  </div>
</div>

<script>
(function () {
  const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#95a5a6'];
  const RADII  = [28, 20, 16, 13, 10];

  let currentNode = null;
  let simulation  = null;
  let allNodes    = [];
  let allLinks    = [];

  // ---- Modal ----
  const overlay    = document.getElementById('modal-overlay');
  const modalTitle = document.getElementById('modal-title');
  const modalMeta  = document.getElementById('modal-meta');
  const modalContent = document.getElementById('modal-content');
  const modalStatus  = document.getElementById('modal-status');

  document.getElementById('btn-close').addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });

  document.getElementById('btn-save').addEventListener('click', async () => {
    if (!currentNode || currentNode.depth < 4) return;
    const newContent = modalContent.value.trim();
    if (!newContent) { setStatus('内容を入力してください', 'err'); return; }
    try {
      const res = await fetch('/admin/mindmap/api/memories/' + currentNode.memType + '/' + currentNode.memId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: newContent })
      });
      if (!res.ok) throw new Error(await res.text());
      setStatus('保存しました', 'ok');
      currentNode.label = currentNode.key + ': ' + newContent.slice(0, 50) + (newContent.length > 50 ? '…' : '');
      currentNode.fullContent = newContent;
      setTimeout(() => { closeModal(); loadAndRender(); }, 800);
    } catch (e) {
      setStatus('エラー: ' + e.message, 'err');
    }
  });

  document.getElementById('btn-delete').addEventListener('click', async () => {
    if (!currentNode || currentNode.depth < 4) return;
    if (!confirm('この記憶を削除しますか？')) return;
    try {
      const res = await fetch('/admin/mindmap/api/memories/' + currentNode.memType + '/' + currentNode.memId, {
        method: 'DELETE'
      });
      if (!res.ok) throw new Error(await res.text());
      setStatus('削除しました', 'ok');
      setTimeout(() => { closeModal(); loadAndRender(); }, 800);
    } catch (e) {
      setStatus('エラー: ' + e.message, 'err');
    }
  });

  function openModal(node) {
    currentNode = node;
    modalTitle.textContent = node.label || node.id;
    modalMeta.textContent = node.depth < 4
      ? '種別: ' + (node.memType || '-')
      : '種別: ' + node.memType + '  ID: ' + node.memId;
    modalContent.value = node.fullContent || '';
    modalContent.disabled = node.depth < 4;
    document.getElementById('btn-save').style.display   = node.depth >= 4 ? '' : 'none';
    document.getElementById('btn-delete').style.display = node.depth >= 4 ? '' : 'none';
    modalStatus.textContent = '';
    overlay.classList.add('open');
  }

  function closeModal() {
    overlay.classList.remove('open');
    currentNode = null;
  }

  function setStatus(msg, cls) {
    modalStatus.textContent = msg;
    modalStatus.className = 'status-msg ' + cls;
  }

  // ---- D3 rendering ----
  function buildFlatNodesLinks(tree) {
    const nodes = [];
    const links = [];

    function walk(node, parent) {
      nodes.push(node);
      if (parent) links.push({ source: parent.id, target: node.id });
      if (node.children) node.children.forEach(c => walk(c, node));
    }
    walk(tree, null);
    return { nodes, links };
  }

  function render(tree) {
    const container = document.getElementById('mindmap-container');
    const W = container.clientWidth;
    const H = container.clientHeight;

    d3.select('#mindmap-container svg').remove();

    const emptyMsg = document.getElementById('empty-message');

    const { nodes, links } = buildFlatNodesLinks(tree);
    allNodes = nodes;
    allLinks = links;

    const hasLeaves = nodes.some(n => n.depth >= 4);
    if (!hasLeaves && nodes.length <= 1) {
      emptyMsg.style.display = 'block';
      return;
    }
    emptyMsg.style.display = 'none';

    const svg = d3.select('#mindmap-container')
      .append('svg')
      .attr('width', W)
      .attr('height', H);

    const g = svg.append('g');

    // Zoom
    svg.call(d3.zoom()
      .scaleExtent([0.2, 4])
      .on('zoom', (event) => g.attr('transform', event.transform))
    );

    // Build lookup
    const nodeById = new Map(nodes.map(n => [n.id, n]));
    const linkData = links.map(l => ({
      source: nodeById.get(l.source),
      target: nodeById.get(l.target)
    })).filter(l => l.source && l.target);

    // Init positions near center
    nodes.forEach(n => {
      n.x = W / 2 + (Math.random() - 0.5) * 200;
      n.y = H / 2 + (Math.random() - 0.5) * 200;
    });

    if (simulation) simulation.stop();
    simulation = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(linkData).id(d => d.id).distance(d => {
        const depth = d.target.depth || 0;
        return [0, 120, 90, 70, 55][depth] || 55;
      }).strength(0.6))
      .force('charge', d3.forceManyBody().strength(d => {
        return [-600, -200, -150, -100, -60][d.depth] || -60;
      }))
      .force('center', d3.forceCenter(W / 2, H / 2))
      .force('collision', d3.forceCollide().radius(d => RADII[d.depth] + 6));

    const link = g.append('g').attr('class', 'links')
      .selectAll('line')
      .data(linkData)
      .enter().append('line')
      .attr('class', 'link')
      .attr('stroke-width', d => Math.max(1, 4 - (d.target.depth || 0)));

    const node = g.append('g').attr('class', 'nodes')
      .selectAll('g')
      .data(nodes)
      .enter().append('g')
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
        openModal(d);
      });

    node.append('circle')
      .attr('r', d => RADII[d.depth] || 10)
      .attr('fill', d => COLORS[d.depth] || COLORS[4])
      .attr('stroke', d => d3.color(COLORS[d.depth] || COLORS[4]).brighter(0.8));

    node.append('text')
      .attr('dy', d => (RADII[d.depth] || 10) + 12)
      .attr('text-anchor', 'middle')
      .text(d => {
        const lbl = d.label || d.id || '';
        return lbl.length > 18 ? lbl.slice(0, 17) + '…' : lbl;
      });

    simulation.on('tick', () => {
      link
        .attr('x1', d => d.source.x)
        .attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x)
        .attr('y2', d => d.target.y);
      node.attr('transform', d => 'translate(' + d.x + ',' + d.y + ')');
    });
  }

  async function loadAndRender() {
    try {
      const res = await fetch('/admin/mindmap/api/memories');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const tree = await res.json();
      render(tree);
    } catch (e) {
      document.getElementById('empty-message').style.display = 'block';
      document.getElementById('empty-message').textContent = 'データ取得エラー: ' + e.message;
    }
  }

  loadAndRender();
})();
</script>
</body>
</html>`;
}
