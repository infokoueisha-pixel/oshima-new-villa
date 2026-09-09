import { promises as fs } from 'node:fs';
import path from 'node:path';

const sha = process.env.CF_PAGES_COMMIT_SHA || process.env.GITHUB_SHA || 'local';
await fs.writeFile(path.join(process.cwd(), 'public', 'deploy-version.txt'), `${sha}\n`, 'utf8');
console.log(`Wrote deploy-version.txt: ${sha}`);
