import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const SITE = 'https://oshima-new-villa.com';
const HOST = 'oshima-new-villa.com';
const KEY = 'e19de1bb704a7f39912a21b0e4829979';
const KEY_LOCATION = `${SITE}/${KEY}.txt`;
const SITEMAP = path.join(process.cwd(), 'public', 'sitemap.xml');
const before = process.env.INDEXNOW_BEFORE;
const after = process.env.INDEXNOW_AFTER || process.env.GITHUB_SHA || 'HEAD';

const sitemapXml = await fs.readFile(SITEMAP, 'utf8');
const currentUrls = new Set([...sitemapXml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]));

function routeFromPageFile(file) {
  if (!file.startsWith('src/pages/') || !file.endsWith('.astro') || file.includes('[')) return null;
  let rel = file.slice('src/pages/'.length, -'.astro'.length);
  if (rel === 'index') return '/';
  if (rel.endsWith('/index')) rel = rel.slice(0, -'/index'.length);
  return `/${rel}/`;
}

function changedFiles() {
  if (!before || /^0+$/.test(before)) return null;
  try {
    return execFileSync('git', ['diff', '--name-only', before, after], { encoding: 'utf8' })
      .split(/\r?\n/).filter(Boolean);
  } catch {
    return null;
  }
}

const files = changedFiles();
let urls;
if (!files) {
  urls = [...currentUrls];
} else {
  const globalChange = files.some((file) =>
    file.startsWith('src/layouts/') ||
    file.startsWith('src/components/') ||
    file === 'src/data/site.ts' ||
    file === 'astro.config.mjs'
  );
  if (globalChange) {
    urls = [...currentUrls];
  } else {
    urls = files.map(routeFromPageFile).filter(Boolean).map((route) => `${SITE}${route}`);
    urls = urls.filter((url) => currentUrls.has(url) || !url.includes('/guest-guide/') && !url.endsWith('/privacy/'));
  }
}
urls = [...new Set(urls)].slice(0, 10000);

if (urls.length === 0) {
  console.log('IndexNow: no public content URLs changed.');
  process.exit(0);
}

if (process.env.INDEXNOW_DRY_RUN === 'true') {
  console.log('IndexNow dry run URLs:');
  console.log(urls.join('\n'));
  process.exit(0);
}

async function waitForDeploy() {
  const expected = process.env.GITHUB_SHA;
  if (!expected || process.env.INDEXNOW_WAIT_FOR_DEPLOY !== 'true') return;
  const marker = `${SITE}/deploy-version.txt`;
  for (let i = 0; i < 36; i++) {
    try {
      const response = await fetch(marker, { cache: 'no-store' });
      if (response.ok && (await response.text()).trim() === expected) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }
  throw new Error('IndexNow: production deploy marker did not reach the current commit.');
}

await waitForDeploy();

const response = await fetch('https://api.indexnow.org/indexnow', {
  method: 'POST',
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ host: HOST, key: KEY, keyLocation: KEY_LOCATION, urlList: urls }),
});

if (!response.ok && response.status !== 202) {
  throw new Error(`IndexNow submission failed: ${response.status} ${await response.text()}`);
}
console.log(`IndexNow submitted ${urls.length} URL(s). HTTP ${response.status}.`);
