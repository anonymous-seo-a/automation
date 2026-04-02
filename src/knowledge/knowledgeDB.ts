import { getDB } from '../db/database';

export async function searchKnowledge(query: string): Promise<string[]> {
  const db = getDB();
  const terms = query.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  const where = terms.map(() => `content LIKE ?`).join(' AND ');
  const params = terms.map(t => `%${t}%`);

  const rows = await db.prepare(`
    SELECT content FROM knowledge
    WHERE ${where}
    ORDER BY updated_at DESC
    LIMIT 5
  `).all(...params) as Array<{ content: string }>;

  return rows.map(r => r.content);
}

export async function getKnowledgeByFile(fileName: string): Promise<string> {
  const db = getDB();
  const rows = await db.prepare(`
    SELECT content FROM knowledge
    WHERE file_name = ?
    ORDER BY id ASC
  `).all(fileName) as Array<{ content: string }>;

  return rows.map(r => r.content).join('\n\n');
}

export async function updateKnowledge(
  id: string,
  newContent: string,
  changedBy: string = 'line'
): Promise<void> {
  const db = getDB();
  const current = await db.prepare(
    `SELECT content FROM knowledge WHERE id = ?`
  ).get(id) as { content: string } | undefined;

  if (current) {
    await db.prepare(`
      INSERT INTO knowledge_history
        (knowledge_id, content_before, content_after, changed_by)
      VALUES (?, ?, ?, ?)
    `).run(id, current.content, newContent, changedBy);
  }

  await db.prepare(`
    UPDATE knowledge
    SET content = ?, version = knowledge.version + 1, updated_at = NOW()
    WHERE id = ?
  `).run(newContent, id);
}
