import { getDB } from '../db/database';

export function searchKnowledge(query: string): string[] {
  const db = getDB();
  const terms = query.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  const where = terms.map(() => `content LIKE ?`).join(' AND ');
  const params = terms.map(t => `%${t}%`);

  const rows = db.prepare(`
    SELECT content FROM knowledge
    WHERE ${where}
    ORDER BY updated_at DESC
    LIMIT 5
  `).all(...params) as Array<{ content: string }>;

  return rows.map(r => r.content);
}

export function getKnowledgeByFile(fileName: string): string {
  const db = getDB();
  const rows = db.prepare(`
    SELECT content FROM knowledge
    WHERE file_name = ?
    ORDER BY rowid ASC
  `).all(fileName) as Array<{ content: string }>;

  return rows.map(r => r.content).join('\n\n');
}

export function updateKnowledge(
  id: string,
  newContent: string,
  changedBy: string = 'line'
): void {
  const db = getDB();
  const current = db.prepare(
    `SELECT content FROM knowledge WHERE id = ?`
  ).get(id) as { content: string } | undefined;

  if (current) {
    db.prepare(`
      INSERT INTO knowledge_history
        (knowledge_id, content_before, content_after, changed_by)
      VALUES (?, ?, ?, ?)
    `).run(id, current.content, newContent, changedBy);
  }

  db.prepare(`
    UPDATE knowledge
    SET content = ?, version = version + 1, updated_at = datetime('now')
    WHERE id = ?
  `).run(newContent, id);
}
