import { Router, Request, Response } from 'express';
import { logger } from '../utils/logger';

export const mindmapViewRouter = Router();

mindmapViewRouter.get('/', (_req: Request, res: Response) => {
  try {
    res.send(renderMindmapPage());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('mindmapView ページ表示エラー', { error: msg });
    res.status(500).send('<h1>エラー</h1><pre>マインドマップの表示に失敗しました</pre>');
  }
});

function renderMindmapPage(): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>記憶マインドマップ</title>
  <script
    src="https://unpkg.com/vis-network@9.1.9/standalone/umd/vis-network.min.js"
    onerror="handleVisLoadError()"
  ></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: sans-serif; background: #1a1a2e; color: #e0e0e0; height: 100vh; display: flex; flex-direction: column; }
    header { background: #16213e; padding: 12px 20px; border-bottom: 1px solid #0f3460; }
    header h1 { font-size: 1.2rem; color: #e94560; }
    header a { color: #aaa; text-decoration: none; font-size: 0.85rem; }
    header a:hover { color: #fff; }
    #tabs { display: flex; gap: 8px; padding: 10px 16px; background: #16213e; border-bottom: 1px solid #0f3460; flex-wrap: wrap; }
    .tab-btn {
      padding: 6px 16px; border: 1px solid #0f3460; border-radius: 4px;
      background: #1a1a2e; color: #aaa; cursor: pointer; font-size: 0.85rem;
      transition: background 0.2s, color 0.2s;
    }
    .tab-btn:hover { background: #0f3460; color: #fff; }
    .tab-btn.active { background: #e94560; border-color: #e94560; color: #fff; }
    #loading {
      display: none; padding: 6px 14px; font-size: 0.8rem; color: #aaa;
      align-items: center; gap: 8px;
    }
    #loading.visible { display: flex; }
    .spinner {
      width: 14px; height: 14px; border: 2px solid #555;
      border-top-color: #e94560; border-radius: 50%;
      animation: spin 0.7s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    #graph-container { flex: 1; position: relative; overflow: hidden; }
    #network { width: 100%; height: 100%; }
    #message-overlay {
      display: none; position: absolute; inset: 0;
      align-items: center; justify-content: center;
      background: rgba(26,26,46,0.85); font-size: 1rem; color: #aaa;
      text-align: center; padding: 20px;
    }
    #message-overlay.visible { display: flex; }
    #error-banner {
      display: none; padding: 10px 16px; background: #7a1a1a;
      border-left: 4px solid #e94560; font-size: 0.85rem; color: #fcc;
    }
    #error-banner.visible { display: block; }
    #vis-fallback {
      display: none; padding: 20px; text-align: center; color: #e94560; font-size: 0.9rem;
    }
  </style>
</head>
<body>
  <header>
    <h1>記憶マインドマップ &nbsp;<a href="/admin">&larr; ダッシュボードに戻る</a></h1>
  </header>

  <div id="tabs">
    <span id="loading"><span class="spinner"></span>読み込み中...</span>
  </div>

  <div id="error-banner"></div>
  <div id="vis-fallback">vis.js の読み込みに失敗しました。ネットワーク接続またはCDNを確認してください。</div>

  <div id="graph-container">
    <div id="network"></div>
    <div id="message-overlay">
      <p>エージェントを選択するとマインドマップを表示します</p>
    </div>
  </div>

  <script>
    // vis.js 読み込み失敗ハンドラ
    function handleVisLoadError() {
      console.error('[mindmap] vis.js CDN の読み込みに失敗しました');
      document.getElementById('vis-fallback').style.display = 'block';
      document.getElementById('network').style.display = 'none';
      showError('グラフ描画ライブラリ (vis.js) の読み込みに失敗しました。ページをリロードするか、ネットワーク接続を確認してください。');
    }

    let currentNetwork = null;
    let currentAgent = null;

    function showError(msg) {
      const banner = document.getElementById('error-banner');
      banner.textContent = msg;
      banner.classList.add('visible');
    }

    function hideError() {
      document.getElementById('error-banner').classList.remove('visible');
    }

    function showOverlay(msg) {
      const el = document.getElementById('message-overlay');
      el.textContent = '';
      const p = document.createElement('p');
      p.textContent = msg;
      el.appendChild(p);
      el.classList.add('visible');
    }

    function hideOverlay() {
      document.getElementById('message-overlay').classList.remove('visible');
    }

    function setLoading(visible) {
      const el = document.getElementById('loading');
      if (visible) {
        el.classList.add('visible');
      } else {
        el.classList.remove('visible');
      }
    }

    // エージェント一覧を取得してタブを構築
    async function loadAgentTabs() {
      setLoading(true);
      hideError();
      try {
        const res = await fetch('/admin/mindmap/api/agents');
        if (!res.ok) {
          const text = await res.text();
          throw new Error('HTTP ' + res.status + ': ' + text);
        }
        const data = await res.json();
        console.debug('[mindmap] /admin/mindmap/api/agents レスポンス:', data);
        console.debug('[mindmap] エージェント数:', data.agents ? data.agents.length : 0);

        const tabs = document.getElementById('tabs');

        if (!data.agents || data.agents.length === 0) {
          showOverlay('エージェントデータがまだありません');
          return;
        }

        for (const agent of data.agents) {
          const btn = document.createElement('button');
          btn.className = 'tab-btn';
          btn.textContent = agent;
          btn.dataset.agent = agent;
          btn.addEventListener('click', () => selectAgent(agent, btn));
          tabs.appendChild(btn);
        }

        // 最初のエージェントを自動選択
        const firstBtn = tabs.querySelector('.tab-btn');
        if (firstBtn) {
          const agentName = firstBtn.dataset.agent;
          if (agentName) { selectAgent(agentName, firstBtn); }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[mindmap] エージェント一覧の取得に失敗:', err);
        showError('エージェント一覧の取得に失敗しました: ' + msg);
        showOverlay('エラーが発生しました。コンソールを確認してください。');
      } finally {
        setLoading(false);
      }
    }

    async function selectAgent(agent, btnEl) {
      if (currentAgent === agent) return;
      currentAgent = agent;

      // タブのアクティブ状態を切り替え
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      if (btnEl) btnEl.classList.add('active');

      // ローディング表示
      setLoading(true);
      hideError();
      hideOverlay();
      if (currentNetwork) {
        currentNetwork.destroy();
        currentNetwork = null;
      }
      showOverlay('読み込み中...');

      try {
        const url = '/admin/mindmap/api/graph?agent=' + encodeURIComponent(agent);
        const res = await fetch(url);
        if (!res.ok) {
          const text = await res.text();
          throw new Error('HTTP ' + res.status + ': ' + text);
        }
        const data = await res.json();
        console.debug('[mindmap] /admin/mindmap/api/graph?agent=' + agent + ' レスポンス:', data);
        console.debug('[mindmap] ノード数:', data.nodes ? data.nodes.length : 0, '/ エッジ数:', data.edges ? data.edges.length : 0);

        hideOverlay();

        if (!data.nodes || data.nodes.length === 0) {
          showOverlay('このエージェントの記憶データはまだありません');
          return;
        }

        // vis.js が読み込まれているか確認
        if (typeof vis === 'undefined') {
          showError('グラフ描画ライブラリが利用できません。ページをリロードしてください。');
          return;
        }

        renderGraph(data.nodes, data.edges || []);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[mindmap] グラフデータの取得に失敗:', err);
        showError('グラフデータの取得に失敗しました: ' + msg);
        showOverlay('エラーが発生しました。コンソールを確認してください。');
      } finally {
        setLoading(false);
      }
    }

    function renderGraph(nodes, edges) {
      const GROUP_COLORS = {
        root:    { background: '#e94560', border: '#c73050', font: { color: '#fff', size: 16, bold: true } },
        type:    { background: '#0f3460', border: '#1a5276', font: { color: '#e0e0e0', size: 13 } },
        default: { background: '#16213e', border: '#0f3460', font: { color: '#ccc', size: 11 } },
      };

      const visNodes = nodes.map(n => {
        const colorSet = GROUP_COLORS[n.group] || GROUP_COLORS.default;
        return {
          id: n.id,
          label: n.label.length > 30 ? n.label.slice(0, 28) + '…' : n.label,
          title: n.data ? JSON.stringify(n.data, null, 2) : n.label,
          color: { background: colorSet.background, border: colorSet.border },
          font: colorSet.font || { color: '#ccc', size: 11 },
          shape: n.group === 'root' ? 'star' : n.group === 'type' ? 'box' : 'ellipse',
        };
      });

      const visEdges = edges.map((e, i) => ({
        id: 'e_' + i,
        from: e.source,
        to: e.target,
        label: e.label || '',
        color: { color: '#0f3460', opacity: 0.7 },
        arrows: { to: { enabled: true, scaleFactor: 0.5 } },
        smooth: { enabled: true, type: 'dynamic' },
      }));

      const container = document.getElementById('network');
      const networkData = {
        nodes: new vis.DataSet(visNodes),
        edges: new vis.DataSet(visEdges),
      };
      const options = {
        layout: { improvedLayout: true },
        physics: {
          enabled: true,
          stabilization: { iterations: 150 },
          barnesHut: { gravitationalConstant: -8000, springLength: 120, springConstant: 0.04 },
        },
        interaction: { tooltipDelay: 200, hideEdgesOnDrag: true },
        nodes: { borderWidth: 2, shadow: true },
        edges: { width: 1, shadow: false },
      };

      currentNetwork = new vis.Network(container, networkData, options);
      console.debug('[mindmap] vis.Network 描画完了: ノード数=' + visNodes.length + ', エッジ数=' + visEdges.length);
    }

    // 初期化
    document.addEventListener('DOMContentLoaded', () => {
      showOverlay('エージェントを選択するとマインドマップを表示します');
      loadAgentTabs();
    });
  </script>
</body>
</html>`;
}
