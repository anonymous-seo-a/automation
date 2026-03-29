import dotenv from 'dotenv';
dotenv.config();

function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env: ${key}`);
  return v;
}

export const config = {
  line: {
    channelSecret: required('LINE_CHANNEL_SECRET'),
    channelAccessToken: required('LINE_CHANNEL_ACCESS_TOKEN'),
    allowedUserId: required('ALLOWED_LINE_USER_ID'),
  },
  claude: {
    apiKey: required('CLAUDE_API_KEY'),
    defaultModel: process.env.CLAUDE_MODEL_DEFAULT || 'claude-sonnet-4-6-20260312',
    opusModel: process.env.CLAUDE_MODEL_OPUS || 'claude-opus-4-6-20260312',
    dailyBudgetUsd: parseFloat(process.env.CLAUDE_DAILY_BUDGET_USD || '1.50'),
    monthlyBudgetUsd: parseFloat(process.env.CLAUDE_MONTHLY_BUDGET_USD || '30.00'),
  },
  server: {
    port: parseInt(process.env.PORT || '3000', 10),
    env: process.env.NODE_ENV || 'development',
  },
  db: {
    path: process.env.DB_PATH || './data/mothership.db',
  },
  log: {
    dir: process.env.LOG_DIR || './logs',
  },
  sandbox: {
    dir: process.env.SANDBOX_DIR || '/tmp/mothership/sandbox',
    timeoutMs: 30000,
  },
} as const;
