import { promises as fs } from 'fs';
import path from 'path';
import { getDB } from '../db/database';
import { logger } from '../utils/logger';

export async function loadKnowledgeFiles(dir: string): Promise<void> {
  const db = getDB();

  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    logger.warn(`ナレッジディレクトリが見つかりません: ${dir}`);
    return;
  }

  const mdFiles = files.filter(f => f.endsWith('.md'));

  const upsert = db.prepare(`
    INSERT INTO knowledge (id, file_name, section, content, version)
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(id) DO UPDATE SET
      content = excluded.content,
      version = knowledge.version + 1,
      updated_at = NOW()
  `);

  for (const file of mdFiles) {
    const content = await fs.readFile(path.join(dir, file), 'utf-8');
    const sections = parseSections(content);

    for (const section of sections) {
      const id = `${file}::${section.heading || 'root'}`;
      await upsert.run(id, file, section.heading, section.content);
    }
    logger.info(`ナレッジロード完了: ${file} (${sections.length}セクション)`);
  }
}

interface Section {
  heading: string | null;
  content: string;
}

function parseSections(markdown: string): Section[] {
  const lines = markdown.split('\n');
  const sections: Section[] = [];
  let currentHeading: string | null = null;
  let currentContent: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+)/);
    if (headingMatch) {
      if (currentContent.length > 0) {
        sections.push({
          heading: currentHeading,
          content: currentContent.join('\n').trim(),
        });
      }
      currentHeading = headingMatch[1];
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }

  if (currentContent.length > 0) {
    sections.push({
      heading: currentHeading,
      content: currentContent.join('\n').trim(),
    });
  }

  return sections;
}
