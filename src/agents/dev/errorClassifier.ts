/**
 * エラーメッセージをパターンマッチで分類し、適切な対処法を提案する。
 * API呼び出し不要のローカル分類器。
 */

export type ErrorCategory = 'code' | 'environment' | 'transient' | 'unknown';

export interface ClassifiedError {
  category: ErrorCategory;
  subcategory: string;
  message: string;
  suggestedAction: string;
  autoFixable: boolean;
  /** 一時的エラーの場合、推奨待機時間(ms) */
  waitMs?: number;
}

interface ErrorPattern {
  pattern: RegExp;
  category: ErrorCategory;
  subcategory: string;
  suggestedAction: string;
  autoFixable: boolean;
  waitMs?: number;
}

const ERROR_PATTERNS: ErrorPattern[] = [
  // ── 環境エラー ──
  {
    pattern: /Author identity unknown|unable to auto-detect email/i,
    category: 'environment',
    subcategory: 'git_config',
    suggestedAction: 'git config user.name / user.email を設定',
    autoFixable: true,
  },
  {
    pattern: /EADDRINUSE|address already in use/i,
    category: 'environment',
    subcategory: 'port_conflict',
    suggestedAction: '該当ポートのプロセスを停止',
    autoFixable: true,
  },
  {
    pattern: /disk I\/O error|ENOSPC|No space left on device/i,
    category: 'environment',
    subcategory: 'disk',
    suggestedAction: 'ディスク容量を確保',
    autoFixable: false,
  },
  {
    pattern: /ENOMEM|Cannot allocate memory|JavaScript heap out of memory/i,
    category: 'environment',
    subcategory: 'memory',
    suggestedAction: 'メモリ不足。不要プロセスを停止',
    autoFixable: false,
  },
  {
    pattern: /Cannot find module|MODULE_NOT_FOUND/i,
    category: 'environment',
    subcategory: 'missing_module',
    suggestedAction: 'npm install を実行',
    autoFixable: true,
  },
  {
    pattern: /EACCES|permission denied/i,
    category: 'environment',
    subcategory: 'permission',
    suggestedAction: 'ファイル権限を確認',
    autoFixable: false,
  },

  // ── 一時的エラー ──
  {
    pattern: /rate_limit_error|429|Too Many Requests/i,
    category: 'transient',
    subcategory: 'rate_limit',
    suggestedAction: 'レートリミット。時間をおいてリトライ',
    autoFixable: true,
    waitMs: 60_000,
  },
  {
    pattern: /ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up/i,
    category: 'transient',
    subcategory: 'network',
    suggestedAction: 'ネットワークエラー。リトライ',
    autoFixable: true,
    waitMs: 5_000,
  },
  {
    pattern: /overloaded_error|529|Service Unavailable/i,
    category: 'transient',
    subcategory: 'server_overload',
    suggestedAction: 'サーバー過負荷。時間をおいてリトライ',
    autoFixable: true,
    waitMs: 30_000,
  },
  {
    pattern: /5\d{2}.*(?:Internal Server Error|Bad Gateway)/i,
    category: 'transient',
    subcategory: 'server_error',
    suggestedAction: 'サーバーエラー。リトライ',
    autoFixable: true,
    waitMs: 10_000,
  },
  {
    pattern: /API タイムアウト|AbortError|timeout/i,
    category: 'transient',
    subcategory: 'timeout',
    suggestedAction: 'タイムアウト。リトライ',
    autoFixable: true,
    waitMs: 5_000,
  },

  // ── コードエラー ──
  {
    pattern: /error TS\d+/i,
    category: 'code',
    subcategory: 'typescript',
    suggestedAction: 'TypeScriptコンパイルエラー。コードを修正',
    autoFixable: true,
  },
  {
    pattern: /SyntaxError|Unexpected token/i,
    category: 'code',
    subcategory: 'syntax',
    suggestedAction: '構文エラー。コードを修正',
    autoFixable: true,
  },
  {
    pattern: /ReferenceError.*is not defined/i,
    category: 'code',
    subcategory: 'reference',
    suggestedAction: '未定義参照。import/変数宣言を確認',
    autoFixable: true,
  },
  {
    pattern: /TypeError/i,
    category: 'code',
    subcategory: 'type',
    suggestedAction: '型エラー。引数・戻り値の型を確認',
    autoFixable: true,
  },
];

/**
 * エラーメッセージを分類する。API呼び出し不要。
 */
export function classifyError(errorMessage: string): ClassifiedError {
  for (const p of ERROR_PATTERNS) {
    if (p.pattern.test(errorMessage)) {
      return {
        category: p.category,
        subcategory: p.subcategory,
        message: errorMessage.slice(0, 500),
        suggestedAction: p.suggestedAction,
        autoFixable: p.autoFixable,
        waitMs: p.waitMs,
      };
    }
  }

  // ビルド出力に TS エラーコードが含まれる場合はコードエラー
  if (/\berror\b.*\b(TS|ts)\d+\b/.test(errorMessage)) {
    return {
      category: 'code',
      subcategory: 'typescript',
      message: errorMessage.slice(0, 500),
      suggestedAction: 'TypeScriptコンパイルエラー。コードを修正',
      autoFixable: true,
    };
  }

  return {
    category: 'unknown',
    subcategory: 'unknown',
    message: errorMessage.slice(0, 500),
    suggestedAction: 'エラー原因を調査',
    autoFixable: false,
  };
}

/**
 * エラーカテゴリの日本語名を返す
 */
export function categoryLabel(cat: ErrorCategory): string {
  switch (cat) {
    case 'code': return 'コードエラー';
    case 'environment': return '環境エラー';
    case 'transient': return '一時的エラー';
    case 'unknown': return '不明なエラー';
  }
}
