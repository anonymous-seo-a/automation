import { config } from '../config';
import { logger } from '../utils/logger';

const API_BASE = 'https://api.github.com';
const TIMEOUT_MS = 10_000;

interface GitHubCommit {
  sha: string;
  commit: {
    message: string;
    author: { name: string; date: string };
  };
  files?: Array<{ filename: string; status: string; additions: number; deletions: number }>;
}

async function ghFetch<T>(path: string): Promise<T | null> {
  if (!config.github.token) {
    logger.warn('GITHUB_TOKEN 未設定');
    return null;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: {
        'Authorization': `Bearer ${config.github.token}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'mothership-bot',
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      logger.warn('GitHub API エラー', { status: res.status, path });
      return null;
    }

    return await res.json() as T;
  } catch (err) {
    logger.warn('GitHub API 接続失敗', { err: err instanceof Error ? err.message : String(err) });
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/** 最近のコミット一覧を取得 */
export async function getRecentCommits(count = 10): Promise<string> {
  const { owner, repo, branch } = config.github;
  const commits = await ghFetch<GitHubCommit[]>(
    `/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=${count}`
  );

  if (!commits || commits.length === 0) {
    return '（GitHub コミット情報を取得できませんでした）';
  }

  const lines = commits.map(c => {
    const date = new Date(c.commit.author.date).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
    const msg = c.commit.message.split('\n')[0]; // 1行目のみ
    const shortSha = c.sha.slice(0, 7);
    return `- \`${shortSha}\` ${date} — ${msg}`;
  });

  return lines.join('\n');
}

/** 特定コミットの変更ファイル詳細を取得 */
export async function getCommitDetail(sha: string): Promise<string> {
  const { owner, repo } = config.github;
  const commit = await ghFetch<GitHubCommit>(`/repos/${owner}/${repo}/commits/${sha}`);

  if (!commit) return '（コミット詳細を取得できませんでした）';

  const msg = commit.commit.message;
  const files = commit.files?.map(f =>
    `  ${f.status} ${f.filename} (+${f.additions} -${f.deletions})`
  ).join('\n') || '  （ファイル情報なし）';

  return `コミット: ${sha.slice(0, 7)}\nメッセージ: ${msg}\n変更ファイル:\n${files}`;
}

/** 自己状態レポートを生成（responderから呼ばれる） */
export async function buildSelfAwarenessContext(): Promise<string> {
  const commitLog = await getRecentCommits(8);

  return `## GitHub 最新状態（${config.github.owner}/${config.github.repo} @ ${config.github.branch}）\n\n### 最近のコミット\n${commitLog}`;
}
