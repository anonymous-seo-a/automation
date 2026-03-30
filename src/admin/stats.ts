import { Router, Request, Response } from 'express';
import { getDB } from '../db/database';
import { config } from '../config';
import { listAgents } from '../agents/router';
import { logger } from '../utils/logger';

export interface SystemStats {
  system: {
    /** seconds since process start */
    uptimeSeconds: number;
    env: string;
    agents: string[];
  };
  tasks: {
    byStatus: Record<string, number>;
    completedLast24h: number;
    avgRetryCount: number;
  };
  apiUsage: {
    today: {
      costUsd: number;
      inputTokens: number;
      outputTokens: number;
      callCount: number;
    };
    thisMonth: {
      costUsd: number;
      inputTokens: number;
      outputTokens: number;
      callCount: number;
    };
    byModel: Array<{
      model: string;
      costUsd: number;
      inputTokens: number;
      outputTokens: number;
      callCount: number;
    }>;
  };
  memories: {
    total: number;
    byType: Record<string, number>;
  };
  agentMemories: {
    total: number;
    byAgent: Record<string, number>;
  };
  conversations: {
    activeSessions: number;
    totalSessions: number;
    devConversationsByStatus: Record<string, number>;
  };
  logs: {
    last24hByLevel: Record<string, number>;
  };
  collectedAt: string;
}

export async function getSystemStats(): Promise<SystemStats> {
  try {
    const db = getDB();

    // Tasks: status breakdown
    const taskStatusRows = db.prepare(`
      SELECT status, COUNT(*) as count FROM tasks GROUP BY status
    `).all() as Array<{ status: string; count: number }>;
    const byStatus: Record<string, number> = {};
    for (const row of taskStatusRows) {
      byStatus[row.status] = row.count;
    }

    // Tasks: completed in last 24h
    const completedLast24hRow = db.prepare(`
      SELECT COUNT(*) as count FROM tasks
      WHERE status = 'completed'
        AND completed_at >= datetime('now', '-24 hours')
    `).get() as { count: number };

    // Tasks: average retry count
    const avgRetryRow = db.prepare(`
      SELECT AVG(retry_count) as avg FROM tasks
    `).get() as { avg: number | null };

    // API usage: today
    const todayRow = db.prepare(`
      SELECT
        COALESCE(SUM(cost_usd), 0) as costUsd,
        COALESCE(SUM(input_tokens), 0) as inputTokens,
        COALESCE(SUM(output_tokens), 0) as outputTokens,
        COUNT(*) as callCount
      FROM api_usage
      WHERE date(created_at) = date('now')
    `).get() as { costUsd: number; inputTokens: number; outputTokens: number; callCount: number };

    // API usage: this month
    const monthRow = db.prepare(`
      SELECT
        COALESCE(SUM(cost_usd), 0) as costUsd,
        COALESCE(SUM(input_tokens), 0) as inputTokens,
        COALESCE(SUM(output_tokens), 0) as outputTokens,
        COUNT(*) as callCount
      FROM api_usage
      WHERE strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
    `).get() as { costUsd: number; inputTokens: number; outputTokens: number; callCount: number };

    // API usage: by model
    const byModelRows = db.prepare(`
      SELECT
        model,
        COALESCE(SUM(cost_usd), 0) as costUsd,
        COALESCE(SUM(input_tokens), 0) as inputTokens,
        COALESCE(SUM(output_tokens), 0) as outputTokens,
        COUNT(*) as callCount
      FROM api_usage
      GROUP BY model
      ORDER BY costUsd DESC
    `).all() as Array<{ model: string; costUsd: number; inputTokens: number; outputTokens: number; callCount: number }>;

    // Memories: total and by type
    const memoriesTotal = (db.prepare(`SELECT COUNT(*) as count FROM memories`).get() as { count: number }).count;
    const memoriesByTypeRows = db.prepare(`
      SELECT type, COUNT(*) as count FROM memories GROUP BY type
    `).all() as Array<{ type: string; count: number }>;
    const memoriesByType: Record<string, number> = {};
    for (const row of memoriesByTypeRows) {
      memoriesByType[row.type] = row.count;
    }

    // Agent memories: total and by agent
    const agentMemoriesTotal = (db.prepare(`SELECT COUNT(*) as count FROM agent_memories`).get() as { count: number }).count;
    const agentMemoriesByAgentRows = db.prepare(`
      SELECT agent, COUNT(*) as count FROM agent_memories GROUP BY agent
    `).all() as Array<{ agent: string; count: number }>;
    const agentMemoriesByAgent: Record<string, number> = {};
    for (const row of agentMemoriesByAgentRows) {
      agentMemoriesByAgent[row.agent] = row.count;
    }

    // Conversation sessions: active and total
    const activeSessionsRow = db.prepare(`
      SELECT COUNT(*) as count FROM conversation_sessions WHERE ended_at IS NULL
    `).get() as { count: number };
    const totalSessionsRow = db.prepare(`
      SELECT COUNT(*) as count FROM conversation_sessions
    `).get() as { count: number };

    // Dev conversations: by status
    const devConvRows = db.prepare(`
      SELECT status, COUNT(*) as count FROM dev_conversations GROUP BY status
    `).all() as Array<{ status: string; count: number }>;
    const devConvByStatus: Record<string, number> = {};
    for (const row of devConvRows) {
      devConvByStatus[row.status] = row.count;
    }

    // Logs: last 24h by level
    const logRows = db.prepare(`
      SELECT level, COUNT(*) as count FROM logs
      WHERE created_at >= datetime('now', '-24 hours')
      GROUP BY level
    `).all() as Array<{ level: string; count: number }>;
    const logsByLevel: Record<string, number> = {};
    for (const row of logRows) {
      logsByLevel[row.level] = row.count;
    }

    return {
      system: {
        uptimeSeconds: process.uptime(),
        env: config.server.env,
        agents: listAgents(),
      },
      tasks: {
        byStatus,
        completedLast24h: completedLast24hRow.count,
        avgRetryCount: avgRetryRow.avg ?? 0,
      },
      apiUsage: {
        today: todayRow,
        thisMonth: monthRow,
        byModel: byModelRows,
      },
      memories: {
        total: memoriesTotal,
        byType: memoriesByType,
      },
      agentMemories: {
        total: agentMemoriesTotal,
        byAgent: agentMemoriesByAgent,
      },
      conversations: {
        activeSessions: activeSessionsRow.count,
        totalSessions: totalSessionsRow.count,
        devConversationsByStatus: devConvByStatus,
      },
      logs: {
        last24hByLevel: logsByLevel,
      },
      collectedAt: new Date().toISOString(),
    };
  } catch (err) {
    logger.error('getSystemStats failed', { error: err });
    throw err;
  }
}

export const statsRouter = Router();

// このモジュール自身で認証を保証する（別ルーターから誤ってマウントされても安全）
statsRouter.use((req: Request, res: Response, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Mothership Admin"');
    res.status(401).json({ error: '認証が必要です' });
    return;
  }
  const decoded = Buffer.from(auth.slice(6), 'base64').toString();
  const [user, pass] = decoded.split(':');
  if (user === 'admin' && pass === config.admin.password) {
    next();
  } else {
    res.setHeader('WWW-Authenticate', 'Basic realm="Mothership Admin"');
    res.status(401).json({ error: '認証失敗' });
  }
});

statsRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const stats = await getSystemStats();
    res.json(stats);
  } catch (err) {
    logger.error('GET /admin/stats error', { error: err });
    res.status(500).json({ error: 'Failed to collect system stats' });
  }
});
