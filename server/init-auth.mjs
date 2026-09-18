// Run locally once. Copy only auth.json to the server; keep the password file private.
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createCredentials } from './auth.mjs';
const [secretsPath, passwordPath] = process.argv.slice(2);
if (!secretsPath || !passwordPath) throw new Error('Usage: node server/init-auth.mjs AUTH_JSON PASSWORD_TXT (new files only)');
const password = randomBytes(24).toString('base64url');
writeFileSync(secretsPath, JSON.stringify(await createCredentials(password)) + '\n', { flag: 'wx', mode: 0o600 });
writeFileSync(passwordPath, `MetaStocker admin\nhttps://metastocker.net/admin/\n\nPassword: ${password}\n\nStore this password in your password manager. There is no username.\n`, { flag: 'wx', mode: 0o600 });
console.log('Created owner credentials. Password was written to the private file, not stdout.');
