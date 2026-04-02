import { Router, Request, Response } from 'express';

export const mindmapViewRouter = Router();

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const AGENTS: Array<{ key: string; label: string }> = [
  { key: 'soico', label: '分身' },
  { key: 'dev', label: 'エンジニア' },
  { key: 'pm', label: 'PM' },
  { key: 'reviewer', label: 'レビュワー' },
  { key: 'deployer', label: 'デプロイヤー' },
];

function renderMindmapPage(): string {
  const agentTabsHtml = AGENTS.map(a =>
    `<button class="agent-tab" data-agent="${escapeHtml(a.key)}">${escapeHtml(a.label)}</button>`
  ).join('\n          ');

  const agentLabelsJson = JSON.stringify(
    Object.fromEntries(AGENTS.map(a => [a.key, a.label]))
  );

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>記憶マップ - 母艦管理</title>
<script src="https://d3js.org/d3.v7.min.js"></script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f1117; color: #e1e4e8; line-height: 1.6; overflow: hidden; }
  nav { background: #161b22; padding: 12px 20px; border-bottom: 1px solid #30363d; display: flex; align-items: center; flex-wrap: wrap; gap: 4px 0; }
  nav a { color: #8b949e; text-decoration: none; margin-right: 6px; font-size: 14px; padding: 4px 12px; border-radius: 6px; transition: color 0.15s, background 0.15s; }
  nav a:hover { color: #e1e4e8; background: #21262d; }
  nav a.active { color: #f0f6fc; background: #30363d; font-weight: 600; }
  nav .brand { color: #f0f6fc; font-weight: bold; font-size: 16px; margin-right: 20px; padding: 4px 0; }
  nav .brand:hover { background: none; }

  .tabs { background: #161b22; padding: 8px 20px; border-bottom: 1px solid #30363d; display: flex; gap: 8px; }
  .agent-tab { background: #21262d; color: #8b949e; border: 1px solid #30363d; padding: 6px 16px; border-radius: 6px; cursor: pointer; font-size: 14px; transition: all 0.15s; }
  .agent-tab:hover { color: #e1e4e8; background: #30363d; }
  .agent-tab.active { background: #1f6feb; color: #fff; border-color: #1f6feb; font-weight: 600; }

  .main-area { display: flex; height: calc(100vh - 100px); }
  .svg-container { flex: 1; position: relative; }
  .svg-container svg { width: 100%; height: 100%; }

  .detail-panel { width: 340px; background: #161b22; border-left: 1px solid #30363d; padding: 20px; overflow-y: auto; transition: transform 0.2s; }
  .detail-panel.hidden { transform: translateX(100%); width: 0; padding: 0; overflow: hidden; }
  .detail-panel h3 { color: #f0f6fc; font-size: 16px; margin-bottom: 12px; border-bottom: 1px solid #30363d; padding-bottom: 8px; }
  .detail-field { margin-bottom: 12px; }
  .detail-field .label { color: #8b949e; font-size: 12px; text-transform: uppercase; margin-bottom: 2px; }
  .detail-field .value { color: #e1e4e8; font-size: 14px; word-break: break-word; white-space: pre-wrap; }
  .detail-field .value.content { max-height: 300px; overflow-y: auto; background: #0d1117; padding: 8px; border-radius: 4px; border: 1px solid #30363d; }

  .empty-msg { color: #8b949e; text-align: center; margin-top: 40%; font-size: 16px; }

  .tooltip { position: absolute; background: #1c2128; color: #e1e4e8; padding: 6px 10px; border-radius: 4px; font-size: 12px; pointer-events: none; border: 1px solid #30363d; max-width: 250px; word-break: break-word; z-index: 10; }
</style>
</head>
<body>
  <nav>
    <a class="brand" href="/admin">母艦管理</a>
    <a href="/admin">ダッシュボード</a>
    <a href="/admin/dev">開発</a>
    <a href="/admin/insights">改善</a>
    <a href="/admin/live">オフィス</a>
    <a href="/admin/knowledge">ナレッジ</a>
    <a href="/admin/mindmap" class="active">記憶マップ</a>
  </nav>
  <div class="tabs">
    ${agentTabsHtml}
  </div>
  <div class="main-area">
    <div class="svg-container">
      <svg id="mindmap-svg"></svg>
      <div id="tooltip" class="tooltip" style="display:none;"></div>
    </div>
    <div id="detail-panel" class="detail-panel hidden">
      <h3>ノード詳細</h3>
      <div id="detail-content"></div>
    </div>
  </div>

<script>
(function() {
  const AGENT_LABELS = ${agentLabelsJson};
  const API_BASE = './api/memories';

  let currentAgent = 'soico';
  let simulation = null;

  // --- Tab handling ---
  const tabs = document.querySelectorAll('.agent-tab');
  tabs[0].classList.add('active');

  tabs.forEach(function(tab) {
    tab.addEventListener('click', function() {
      tabs.forEach(function(t) { t.classList.remove('active'); });
      tab.classList.add('active');
      currentAgent = tab.getAttribute('data-agent');
      loadAndRender(currentAgent);
    });
  });

  // --- Escape HTML for detail panel ---
  function esc(str) {
    if (str == null) return '';
    var d = document.createElement('div');
    d.textContent = String(str);
    return d.innerHTML;
  }

  // --- Load data and render ---
  function loadAndRender(agent) {
    fetch(API_BASE + '?agent=' + encodeURIComponent(agent))
      .then(function(r) {
        if (!r.ok) throw new Error('API error: ' + r.status);
        return r.json();
      })
      .then(function(data) { render(data, agent); })
      .catch(function(err) {
        console.error('Failed to load memories:', err);
        var svg = d3.select('#mindmap-svg');
        svg.selectAll('*').remove();
        svg.append('text')
          .attr('x', '50%').attr('y', '50%')
          .attr('text-anchor', 'middle').attr('fill', '#8b949e').attr('font-size', '16px')
          .text('データの読み込みに失敗しました');
      });
  }

  function render(data, agent) {
    var svg = d3.select('#mindmap-svg');
    svg.selectAll('*').remove();

    var panel = document.getElementById('detail-panel');
    panel.classList.add('hidden');

    var width = svg.node().clientWidth;
    var height = svg.node().clientHeight;

    var centerX = width / 2;
    var centerY = height / 2;

    // Build nodes: center agent node + memory nodes
    var agentLabel = AGENT_LABELS[agent] || agent;
    var centerNode = { id: 'center', label: agentLabel, isCenter: true, fx: centerX, fy: centerY };

    var memoryNodes = data.nodes.map(function(n) {
      return {
        id: n.id,
        label: n.key,
        content: n.content,
        type: n.type,
        source: n.source,
        importance: n.importance != null ? n.importance : 3,
        hasEmbedding: n.hasEmbedding,
        created_at: n.created_at,
        updated_at: n.updated_at,
        isCenter: false
      };
    });

    var nodes = [centerNode].concat(memoryNodes);

    // Build links: center-to-memory + similarity links
    var links = [];

    // Connect center to all memory nodes
    memoryNodes.forEach(function(mn) {
      links.push({ source: 'center', target: mn.id, isSimilarity: false, similarity: 0 });
    });

    // Similarity links between memory nodes
    data.links.forEach(function(l) {
      links.push({ source: l.source, target: l.target, isSimilarity: true, similarity: l.similarity });
    });

    if (memoryNodes.length === 0) {
      svg.append('text')
        .attr('x', centerX).attr('y', centerY + 60)
        .attr('text-anchor', 'middle').attr('fill', '#8b949e').attr('font-size', '14px')
        .text('記憶がありません');
    }

    // --- D3 Force Simulation ---
    if (simulation) simulation.stop();

    simulation = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(links).id(function(d) { return d.id; }).distance(120))
      .force('charge', d3.forceManyBody().strength(-200))
      .force('center', d3.forceCenter(centerX, centerY))
      .force('collision', d3.forceCollide().radius(function(d) {
        return d.isCenter ? 40 : (d.importance || 3) * 8 + 12 + 4;
      }));

    var g = svg.append('g');

    // Zoom
    var zoom = d3.zoom()
      .scaleExtent([0.3, 4])
      .on('zoom', function(event) { g.attr('transform', event.transform); });
    svg.call(zoom);

    // Links
    var linkSel = g.append('g')
      .selectAll('line')
      .data(links)
      .join('line')
      .attr('stroke', function(d) { return d.isSimilarity ? '#58a6ff' : '#30363d'; })
      .attr('stroke-width', function(d) {
        if (!d.isSimilarity) return 1;
        return 1 + (d.similarity - 0.75) / 0.25 * 3;
      })
      .attr('stroke-opacity', function(d) {
        if (!d.isSimilarity) return 0.3;
        return 0.3 + (d.similarity - 0.75) / 0.25 * 0.5;
      });

    // Nodes
    var nodeSel = g.append('g')
      .selectAll('g')
      .data(nodes)
      .join('g')
      .attr('cursor', 'pointer')
      .call(d3.drag()
        .on('start', function(event, d) {
          if (!event.active) simulation.alphaTarget(0.3).restart();
          d.fx = d.x; d.fy = d.y;
        })
        .on('drag', function(event, d) {
          d.fx = event.x; d.fy = event.y;
        })
        .on('end', function(event, d) {
          if (!event.active) simulation.alphaTarget(0);
          if (!d.isCenter) { d.fx = null; d.fy = null; }
        })
      );

    // Node circles
    nodeSel.append('circle')
      .attr('r', function(d) {
        if (d.isCenter) return 36;
        return (d.importance || 3) * 8 + 12;
      })
      .attr('fill', function(d) {
        if (d.isCenter) return '#238636';
        return d.hasEmbedding ? '#4A90D9' : '#999999';
      })
      .attr('stroke', function(d) { return d.isCenter ? '#3fb950' : '#30363d'; })
      .attr('stroke-width', function(d) { return d.isCenter ? 3 : 1.5; });

    // Node labels
    nodeSel.append('text')
      .text(function(d) {
        var lbl = d.label || '';
        return lbl.length > 16 ? lbl.slice(0, 15) + '...' : lbl;
      })
      .attr('text-anchor', 'middle')
      .attr('dy', function(d) {
        if (d.isCenter) return 5;
        var r = (d.importance || 3) * 8 + 12;
        return r + 16;
      })
      .attr('fill', function(d) { return d.isCenter ? '#fff' : '#c9d1d9'; })
      .attr('font-size', function(d) { return d.isCenter ? '14px' : '11px'; })
      .attr('font-weight', function(d) { return d.isCenter ? 'bold' : 'normal'; });

    // Tooltip on hover
    var tooltip = document.getElementById('tooltip');
    nodeSel.on('mouseover', function(event, d) {
      if (d.isCenter) return;
      tooltip.style.display = 'block';
      tooltip.innerHTML = '<strong>' + esc(d.label) + '</strong><br>' + esc((d.content || '').slice(0, 100));
    }).on('mousemove', function(event) {
      tooltip.style.left = (event.pageX + 12) + 'px';
      tooltip.style.top = (event.pageY - 10) + 'px';
    }).on('mouseout', function() {
      tooltip.style.display = 'none';
    });

    // Click for detail
    nodeSel.on('click', function(event, d) {
      if (d.isCenter) return;
      showDetail(d);
    });

    // Tick
    simulation.on('tick', function() {
      linkSel
        .attr('x1', function(d) { return d.source.x; })
        .attr('y1', function(d) { return d.source.y; })
        .attr('x2', function(d) { return d.target.x; })
        .attr('y2', function(d) { return d.target.y; });

      nodeSel.attr('transform', function(d) { return 'translate(' + d.x + ',' + d.y + ')'; });
    });
  }

  function showDetail(d) {
    var panel = document.getElementById('detail-panel');
    panel.classList.remove('hidden');
    var content = document.getElementById('detail-content');
    content.innerHTML =
      '<div class="detail-field"><div class="label">KEY</div><div class="value">' + esc(d.label) + '</div></div>' +
      '<div class="detail-field"><div class="label">CONTENT</div><div class="value content">' + esc(d.content) + '</div></div>' +
      '<div class="detail-field"><div class="label">TYPE</div><div class="value">' + esc(d.type) + '</div></div>' +
      '<div class="detail-field"><div class="label">SOURCE</div><div class="value">' + esc(d.source) + '</div></div>' +
      '<div class="detail-field"><div class="label">CREATED</div><div class="value">' + esc(d.created_at) + '</div></div>' +
      '<div class="detail-field"><div class="label">UPDATED</div><div class="value">' + esc(d.updated_at) + '</div></div>';
  }

  // Initial load
  loadAndRender(currentAgent);
})();
</script>
</body>
</html>`;
}

// GET / → マインドマップHTML返却
mindmapViewRouter.get('/', (_req: Request, res: Response) => {
  try {
    res.send(renderMindmapPage());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).send(`<h1>エラー</h1><pre>${msg}</pre>`);
  }
});
