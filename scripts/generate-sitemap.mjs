import { promises as fs } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const PAGES_DIR = path.join(ROOT, 'src', 'pages');
const OUTPUT = path.join(ROOT, 'public', 'sitemap.xml');
const SITE = 'https://oshima-new-villa.com';

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else files.push(full);
  }
  return files;
}

function routeFromFile(file) {
  let rel = path.relative(PAGES_DIR, file).split(path.sep).join('/');
  if (!rel.endsWith('.astro') || rel.includes('[')) return null;
  rel = rel.slice(0, -'.astro'.length);
  if (rel === 'index') return '/';
  if (rel.endsWith('/index')) rel = rel.slice(0, -'/index'.length);
  return `/${rel}/`.replace(/\/+/g, '/');
}

function isNoIndex(source, route) {
  if (route.includes('/guest-guide/')) return true;
  return /\bnoindex\s*=\s*\{?\s*true\s*\}?/.test(source);
}

function findLastmod(source) {
  const patterns = [
    /const\s+dateModified\s*=\s*['\"](\d{4}-\d{2}-\d{2})['\"]/,
    /dateModified\s*:\s*['\"](\d{4}-\d{2}-\d{2})['\"]/,
    /dateModified\s*=\s*['\"](\d{4}-\d{2}-\d{2})['\"]/,
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function escapeXml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

const files = await walk(PAGES_DIR);
const items = [];
for (const file of files) {
  const route = routeFromFile(file);
  if (!route) continue;
  const source = await fs.readFile(file, 'utf8');
  if (isNoIndex(source, route)) continue;
  items.push({ route, lastmod: findLastmod(source) });
}

items.sort((a, b) => a.route.localeCompare(b.route, 'en'));
const xml = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...items.flatMap(({ route, lastmod }) => [
    '  <url>',
    `    <loc>${escapeXml(`${SITE}${route}`)}</loc>`,
    ...(lastmod ? [`    <lastmod>${lastmod}</lastmod>`] : []),
    '  </url>',
  ]),
  '</urlset>',
  '',
].join('\n');

await fs.writeFile(OUTPUT, xml, 'utf8');
console.log(`Generated sitemap.xml with ${items.length} indexable URLs.`);
