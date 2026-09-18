import { DatabaseSync, backup } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
export async function backupDatabase(source, destination) {
  const db = new DatabaseSync(source, { readOnly: true });
  try { await backup(db, destination); } finally { db.close(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [source, destination] = process.argv.slice(2);
  if (!source || !destination) throw new Error('Usage: node backup.mjs DATABASE DESTINATION');
  await backupDatabase(source, destination);
}
