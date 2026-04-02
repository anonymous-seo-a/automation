import { Router, Request, Response } from 'express';
import Database from 'better-sqlite3';
import { getDB } from '../db/database';
import { logger } from '../utils/logger';

export const memoryMapRouter = Router();

interface TreeNode {
  name: string;
  children?: TreeNode[];
  content?: string;
  updated_at?: string;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildTree(
  memories: Array<{ user_id: string; type: string; key: string; content: string; updated_at: string }>,
  agentMemories: Array<{ agent: string; type: string; key: string; content: string; updated_at: string }>
): TreeNode {
  const root: TreeNode = { name: 'Memory', children: [] };

  // Users branch
  if (memories.length > 0) {
    const usersNode: TreeNode = { name: 'Users', children: [] };
    const userMap = new Map<string, Map<string, TreeNode[]>>();

    for (const m of memories) {
      if (!userMap.has(m.user_id)) userMap.set(m.user_id, new Map());
      const typeMap = userMap.get(m.user_id)!;
      if (!typeMap.has(m.type)) typeMap.set(m.type, []);
      typeMap.get(m.type)!.push({ name: m.key, content: m.content, updated_at: m.updated_at });
    }

    for (const [userId, typeMap] of userMap) {
      const userNode: TreeNode = { name: userId, children: [] };
      for (const [type, keys] of typeMap) {
        const typeNode: TreeNode = { name: type, children: keys };
        userNode.children!.push(typeNode);
      }
      usersNode.children!.push(userNode);
    }
    root.children!.push(usersNode);
  }

  // Agents branch
  if (agentMemories.length > 0) {
    const agentsNode: TreeNode = { name: 'Agents', children: [] };
    const agentMap = new Map<string, Map<string, TreeNode[]>>();

    for (const m of agentMemories) {
      if (!agentMap.has(m.agent)) agentMap.set(m.agent, new Map());
      const typeMap = agentMap.get(m.agent)!;
      if (!typeMap.has(m.type)) typeMap.set(m.type, []);
      typeMap.get(m.type)!.push({ name: m.key, content: m.content, updated_at: m.updated_at });
    }

    for (const [agent, typeMap] of agentMap) {
      const agentNode: TreeNode = { name: agent, children: [] };
      for (const [type, keys] of typeMap) {
        const typeNode: TreeNode = { name: type, children: keys };
        agentNode.children!.push(typeNode);
      }
      agentsNode.children!.push(agentNode);
    }
    root.children!.push(agentsNode);
  }

  return root;
}

function fetchTreeData(db: Database.Database): {
  memories: Array<{ user_id: string; type: string; key: string; content: string; updated_at: string }>;
  agentMemories: Array<{ agent: string; type: string; key: string; content: string; updated_at: string }>;
  tree: TreeNode;
} {
  const memories = db.prepare(
    'SELECT user_id, type, key, content, updated_at FROM memories ORDER BY user_id, type, key'
  ).all() as Array<{ user_id: string; type: string; key: string; content: string; updated_at: string }>;

  const agentMemories = db.prepare(
    'SELECT agent, type, key, content, updated_at FROM agent_memories ORDER BY agent, type, key'
  ).all() as Array<{ agent: string; type: string; key: string; content: string; updated_at: string }>;

  return { memories, agentMemories, tree: buildTree(memories, agentMemories) };
}

memoryMapRouter.get('/api/data', (_req: Request, res: Response) => {
  try {
    const db = getDB();
    const { tree } = fetchTreeData(db);
    res.json(tree);
  } catch (err) {
    logger.error('memoryMap API error', { err });
    res.status(500).json({ error: 'データ取得エラー' });
  }
});

memoryMapRouter.get('/', (_req: Request, res: Response) => {
  try {
    const db = getDB();
    const { memories, agentMemories, tree } = fetchTreeData(db);

    const hasData = memories.length > 0 || agentMemories.length > 0;
    const treeJson = JSON.stringify(tree)
      .replace(/<\/script>/gi, '<\\/script>')
      .replace(/<!--/g, '<\\!--');

    const html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>記憶マインドマップ</title>
  <script src="https://d3js.org/d3.v7.min.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; height: 100vh; display: flex; flex-direction: column; }
    header { background: #1e293b; padding: 12px 20px; border-bottom: 1px solid #334155; display: flex; align-items: center; gap: 16px; }
    header h1 { font-size: 1.2rem; color: #7dd3fc; }
    header a { color: #94a3b8; text-decoration: none; font-size: 0.85rem; }
    header a:hover { color: #e2e8f0; }
    #main { display: flex; flex: 1; overflow: hidden; }
    #canvas { flex: 1; overflow: hidden; }
    svg { width: 100%; height: 100%; }
    #panel { width: 320px; background: #1e293b; border-left: 1px solid #334155; padding: 16px; overflow-y: auto; display: none; }
    #panel h3 { font-size: 0.9rem; color: #7dd3fc; margin-bottom: 8px; word-break: break-all; }
    #panel .meta { font-size: 0.75rem; color: #64748b; margin-bottom: 12px; }
    #panel .content-box { background: #0f172a; border: 1px solid #334155; border-radius: 6px; padding: 12px; font-size: 0.8rem; line-height: 1.6; white-space: pre-wrap; word-break: break-all; }
    #panel .close-btn { float: right; background: none; border: none; color: #64748b; cursor: pointer; font-size: 1rem; }
    #panel .close-btn:hover { color: #e2e8f0; }
    .empty-msg { display: flex; align-items: center; justify-content: center; flex: 1; font-size: 1.2rem; color: #475569; }
    .node circle { stroke-width: 2; cursor: pointer; }
    .node text { font-size: 12px; fill: #e2e8f0; cursor: pointer; }
    .link { fill: none; stroke: #334155; stroke-width: 1.5; }
    .node--root circle { fill: #7dd3fc; stroke: #38bdf8; }
    .node--branch circle { fill: #334155; stroke: #475569; }
    .node--branch.collapsed circle { fill: #1e3a5f; stroke: #3b82f6; }
    .node--leaf circle { fill: #0f172a; stroke: #64748b; }
    .node--leaf:hover circle { stroke: #7dd3fc; }
    #tooltip { position: fixed; background: #1e293b; border: 1px solid #334155; border-radius: 6px; padding: 8px 12px; font-size: 0.75rem; pointer-events: none; opacity: 0; transition: opacity 0.2s; max-width: 300px; word-break: break-all; z-index: 100; }
    #tooltip strong { display: block; margin-bottom: 4px; color: #7dd3fc; }
    .stats { font-size: 0.78rem; color: #64748b; margin-left: auto; }
  </style>
</head>
<body>
  <header>
    <a href="/admin">← ダッシュボード</a>
    <h1>記憶マインドマップ</h1>
    <span class="stats">ユーザー記憶: ${memories.length}件 / エージェント記憶: ${agentMemories.length}件</span>
  </header>
  <div id="main">
    ${!hasData ? '<div class="empty-msg">記憶データがありません</div>' : `
    <div id="canvas"><svg id="tree-svg"></svg></div>
    <div id="panel">
      <button class="close-btn" onclick="closePanel()">✕</button>
      <h3 id="panel-key"></h3>
      <div class="meta" id="panel-meta"></div>
      <div class="content-box" id="panel-content"></div>
    </div>
    `}
  </div>
  <div id="tooltip"><strong id="tooltip-name"></strong><span id="tooltip-preview"></span></div>

  ${hasData ? `<script>
  const rawData = ${treeJson};

  function closePanel() {
    document.getElementById('panel').style.display = 'none';
  }

  function showPanel(d) {
    const panel = document.getElementById('panel');
    document.getElementById('panel-key').textContent = d.data.name;
    document.getElementById('panel-meta').textContent = d.data.updated_at ? '更新: ' + d.data.updated_at : '';
    document.getElementById('panel-content').textContent = d.data.content || '(コンテンツなし)';
    panel.style.display = 'block';
  }

  (function() {
    const svg = d3.select('#tree-svg');
    const container = document.getElementById('canvas');

    const margin = { top: 20, right: 200, bottom: 20, left: 120 };

    function getSize() {
      return { width: container.clientWidth, height: container.clientHeight };
    }

    let { width, height } = getSize();
    const innerH = () => height - margin.top - margin.bottom;

    const g = svg.append('g').attr('transform', \`translate(\${margin.left},\${margin.top})\`);

    // Keep zoom instance to reuse for programmatic transforms
    const zoom = d3.zoom().scaleExtent([0.1, 3]).on('zoom', (event) => {
      g.attr('transform', event.transform);
    });
    svg.call(zoom);

    const treeFn = d3.tree().nodeSize([28, 200]);

    // Build hierarchy with collapse support
    const root = d3.hierarchy(rawData);
    root.x0 = innerH() / 2;
    root.y0 = 0;

    // Collapse nodes beyond depth 2 by default
    root.descendants().forEach(d => {
      if (d.depth >= 2 && d.children) {
        d._children = d.children;
        d.children = null;
      }
    });

    function diagonal(d) {
      return \`M\${d.source.y},\${d.source.x}C\${(d.source.y + d.target.y) / 2},\${d.source.x} \${(d.source.y + d.target.y) / 2},\${d.target.x} \${d.target.y},\${d.target.x}\`;
    }

    let i = 0;
    const duration = 300;
    const tooltip = document.getElementById('tooltip');
    const tooltipName = document.getElementById('tooltip-name');
    const tooltipPreview = document.getElementById('tooltip-preview');

    function update(source) {
      treeFn(root);
      const nodes = root.descendants();
      const links = root.links();

      nodes.forEach(d => { d.y = d.depth * 200; });

      // Nodes
      const node = g.selectAll('g.node').data(nodes, d => d.id || (d.id = ++i));

      const nodeEnter = node.enter().append('g')
        .attr('class', d => {
          if (d.depth === 0) return 'node node--root';
          const isLeaf = !d.children && !d._children;
          if (isLeaf) return 'node node--leaf';
          return d._children ? 'node node--branch collapsed' : 'node node--branch';
        })
        .attr('transform', () => \`translate(\${source.y0},\${source.x0})\`)
        .on('click', (event, d) => {
          if (!d.children && !d._children) {
            showPanel(d);
            return;
          }
          if (d.children) { d._children = d.children; d.children = null; }
          else { d.children = d._children; d._children = null; }
          update(d);
        })
        .on('mouseover', (event, d) => {
          if (!d.children && !d._children && d.data.content) {
            const content = d.data.content;
            const preview = content.slice(0, 120) + (content.length > 120 ? '...' : '');
            tooltipName.textContent = d.data.name;
            tooltipPreview.textContent = preview;
            tooltip.style.opacity = '1';
          }
        })
        .on('mousemove', (event) => {
          tooltip.style.left = (event.clientX + 12) + 'px';
          tooltip.style.top = (event.clientY - 8) + 'px';
        })
        .on('mouseout', () => { tooltip.style.opacity = '0'; });

      nodeEnter.append('circle').attr('r', d => d.depth === 0 ? 10 : d.depth === 1 ? 7 : 4);

      nodeEnter.append('text')
        .attr('dy', '0.31em')
        .attr('x', d => (d.children || d._children) ? -12 : 8)
        .attr('text-anchor', d => (d.children || d._children) ? 'end' : 'start')
        .text(d => d.data.name.length > 24 ? d.data.name.slice(0, 22) + '\u2026' : d.data.name);

      const nodeUpdate = nodeEnter.merge(node);
      nodeUpdate.transition().duration(duration)
        .attr('transform', d => \`translate(\${d.y},\${d.x})\`)
        .attr('class', d => {
          if (d.depth === 0) return 'node node--root';
          const isLeaf = !d.children && !d._children;
          if (isLeaf) return 'node node--leaf';
          return d._children ? 'node node--branch collapsed' : 'node node--branch';
        });

      node.exit().transition().duration(duration)
        .attr('transform', d => \`translate(\${source.y},\${source.x})\`)
        .remove();

      // Links
      const link = g.selectAll('path.link').data(links, d => d.target.id);

      link.enter().insert('path', 'g')
        .attr('class', 'link')
        .attr('d', () => {
          const o = { x: source.x0, y: source.y0 };
          return diagonal({ source: o, target: o });
        })
        .merge(link)
        .transition().duration(duration)
        .attr('d', diagonal);

      link.exit().transition().duration(duration)
        .attr('d', () => {
          const o = { x: source.x, y: source.y };
          return diagonal({ source: o, target: o });
        })
        .remove();

      nodes.forEach(d => { d.x0 = d.x; d.y0 = d.y; });
    }

    function resize() {
      const s = getSize();
      width = s.width; height = s.height;
      root.x0 = innerH() / 2;
    }
    window.addEventListener('resize', () => { resize(); update(root); });

    update(root);
    // Center on root using the same zoom instance
    zoom.transform(svg, d3.zoomIdentity.translate(margin.left + 20, height / 2));
  })();
  </script>` : ''}
</body>
</html>`;

    res.type('html').send(html);
  } catch (err) {
    logger.error('memoryMap render error', { err });
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).type('html').send('<h1>エラー</h1><pre>' + escapeHtml(msg) + '</pre>');
  }
});
