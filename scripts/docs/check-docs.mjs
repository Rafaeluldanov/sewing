#!/usr/bin/env node
/**
 * docs:check — verifies that key documentation files do not drift
 * from the code/schema. Pure Node 20 ESM, no external deps.
 *
 * Source of truth:
 *   - prisma/schema.prisma                 (enums + models)
 *   - apps/api/src/modules/**\/*.controller.ts (Nest routes)
 *   - apps/api/src/modules/audit/audit.service.ts (AuditEntityType union)
 *
 * MVP checks:
 *   1. [docs:critical] — all required docs exist on disk
 *   2. [docs:erd]      — every Prisma enum + model appears in docs/erd.md
 *   3. [docs:api]      — every controller file + every route path
 *                        appears in docs/api.md
 *   4. [docs:events]   — every PassportEventType value (from schema) and
 *                        every AuditEntityType member (from audit.service.ts)
 *                        appears in docs/events.md
 *   5. [docs:links]    — for every markdown file under docs/ and the root
 *                        README.md, every relative link of the form
 *                        `[text](path.md)` / `[text](path.md#anchor)` /
 *                        `[text](#anchor)` resolves to an existing file
 *                        and (when applicable) an existing anchor.
 *                        Anchor matching supports both explicit
 *                        `<a id="…"></a>` / `<a name="…"></a>` /
 *                        `<a id="…" />` and GitHub-style heading slugs.
 *
 * Note on AuditEntityType: the user-spec calls it "an enum from
 * prisma/schema.prisma", but in this codebase AuditEntityType is a
 * TypeScript union literal in apps/api/src/modules/audit/audit.service.ts
 * (the schema model AuditLog uses a free-form `entityType String`).
 * We therefore parse the union from that file. This deviation is
 * intentional and reflects the actual source of truth.
 *
 * Exit code 0 on success, 1 on any drift.
 */

import { readFileSync, statSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCHEMA_PATH = join(ROOT, 'prisma', 'schema.prisma');
const AUDIT_SERVICE_PATH = join(
  ROOT,
  'apps',
  'api',
  'src',
  'modules',
  'audit',
  'audit.service.ts',
);
const MODULES_DIR = join(ROOT, 'apps', 'api', 'src', 'modules');

const DOC_API = join(ROOT, 'docs', 'api.md');
const DOC_ERD = join(ROOT, 'docs', 'erd.md');
const DOC_EVENTS = join(ROOT, 'docs', 'events.md');

const DOCS_DIR = join(ROOT, 'docs');
const README_PATH = join(ROOT, 'README.md');

const CRITICAL_DOCS = [
  'docs/api.md',
  'docs/erd.md',
  'docs/events.md',
  'docs/order-flow.md',
  'docs/production-flow.md',
  'docs/display-board.md',
  'docs/domain.md',
];

const API_PREFIX = '/api';

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------

function read(file) {
  return readFileSync(file, 'utf8');
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Word-boundary token search. `_` counts as a word char (matches \w). */
function tokenInDoc(token, doc) {
  return new RegExp(`\\b${escapeRegex(token)}\\b`).test(doc);
}

/**
 * Path search that refuses to match if followed by another path char.
 * Prevents `/api/orders` from being satisfied by `/api/orders/:id`.
 */
function pathInDoc(path, doc) {
  const re = new RegExp(`${escapeRegex(path)}(?![A-Za-z0-9_/:\\-])`);
  return re.test(doc);
}

function joinUrl(...parts) {
  const cleaned = parts
    .map((p) => String(p ?? '').replace(/^\/+|\/+$/g, ''))
    .filter((p) => p !== '');
  return '/' + cleaned.join('/');
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else {
      yield full;
    }
  }
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/** Returns { enums: string[], models: string[] } sorted alphabetically. */
function parsePrismaTopLevel(schemaText) {
  const enums = [];
  const models = [];
  const re = /^(enum|model)\s+(\w+)\s*\{/gm;
  let m;
  while ((m = re.exec(schemaText)) !== null) {
    if (m[1] === 'enum') enums.push(m[2]);
    else models.push(m[2]);
  }
  enums.sort();
  models.sort();
  return { enums, models };
}

/** Extracts string-literal values of a named Prisma enum (e.g. PassportEventType). */
function parsePrismaEnumValues(schemaText, enumName) {
  const re = new RegExp(
    `^enum\\s+${escapeRegex(enumName)}\\s*\\{([\\s\\S]*?)^\\}`,
    'm',
  );
  const match = schemaText.match(re);
  if (!match) return [];
  const body = match[1];
  const values = [];
  for (const rawLine of body.split('\n')) {
    // Strip /// triple-slash docs and // line comments.
    const line = rawLine.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    // Enum value identifier: starts with [A-Z_], rest [A-Z0-9_].
    const v = line.match(/^([A-Z][A-Z0-9_]*)\s*$/);
    if (v) values.push(v[1]);
  }
  return values;
}

/**
 * Strips JS block comments (`/* ... *\/`, including JSDoc) so that
 * stray `;` inside docs don't terminate union-body matching early.
 */
function stripBlockComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Extracts members of a TS union type alias like:
 *   export type AuditEntityType =
 *     | 'PASSPORT'
 *     | 'ORDER';
 */
function parseTsUnionMembers(tsText, typeName) {
  const cleaned = stripBlockComments(tsText);
  const re = new RegExp(
    `export\\s+type\\s+${escapeRegex(typeName)}\\s*=\\s*([\\s\\S]*?);`,
    'm',
  );
  const match = cleaned.match(re);
  if (!match) return [];
  const body = match[1];
  const out = [];
  const lit = /['"]([A-Z][A-Z0-9_]*)['"]/g;
  let m;
  while ((m = lit.exec(body)) !== null) out.push(m[1]);
  // Dedupe but keep deterministic order.
  return Array.from(new Set(out)).sort();
}

/**
 * Parses a single Nest controller file.
 * Returns { relPath, prefix, routes: Array<{ method, path }> }
 * or null if no @Controller(...) was found.
 */
function parseControllerFile(absPath) {
  const text = read(absPath);
  const ctrlRe = /@Controller\(\s*(?:'([^']*)'|"([^"]*)")?\s*\)/;
  const ctrlMatch = text.match(ctrlRe);
  if (!ctrlMatch) return null;
  const prefix = ctrlMatch[1] ?? ctrlMatch[2] ?? '';

  const routes = [];
  const methodRe =
    /@(Get|Post|Patch|Put|Delete)\(\s*(?:'([^']*)'|"([^"]*)")?\s*\)/g;
  let m;
  while ((m = methodRe.exec(text)) !== null) {
    const method = m[1].toUpperCase();
    const suffix = m[2] ?? m[3] ?? '';
    routes.push({
      method,
      path: joinUrl(API_PREFIX, prefix, suffix),
    });
  }
  return {
    relPath: relative(MODULES_DIR, absPath).split(sep).join('/'),
    prefix,
    routes,
  };
}

function findControllerFiles() {
  const files = [];
  for (const f of walk(MODULES_DIR)) {
    if (f.endsWith('.controller.ts')) files.push(f);
  }
  files.sort();
  return files;
}

// ---------------------------------------------------------------------------
// Markdown link / anchor parsing (for [docs:links])
// ---------------------------------------------------------------------------

/**
 * Strip fenced code blocks (``` ... ``` and ~~~ ... ~~~) and inline code
 * spans (`...`) so that link-like syntax inside code samples does not
 * trigger false positives.
 *
 * Replaces the stripped regions with same-length runs of spaces so that
 * line numbers (used in error messages) remain stable.
 */
function stripMarkdownCode(md) {
  const blank = (s) => s.replace(/[^\n]/g, ' ');

  let out = md.replace(/```[\s\S]*?```/g, blank);
  out = out.replace(/~~~[\s\S]*?~~~/g, blank);
  out = out.replace(/`+[^`\n]*`+/g, blank);
  return out;
}

/** Strip HTML comments (<!-- ... -->) the same way. */
function stripHtmlComments(md) {
  return md.replace(/<!--[\s\S]*?-->/g, (s) => s.replace(/[^\n]/g, ' '));
}

/**
 * GitHub-style heading slug, mirroring the public github-slugger algorithm:
 *   1. lowercase
 *   2. drop a fixed punctuation set (incl. general-punctuation and
 *      supplemental punctuation Unicode blocks — covers em-dash, en-dash,
 *      curly quotes, etc.)
 *   3. replace each whitespace char with `-` (no collapsing — so a run
 *      of N whitespace chars becomes N dashes; matches GitHub's behaviour
 *      where stripping `—` between two spaces leaves a `--`).
 *
 * Note: this is a single-pass slugger; if the same heading text appears
 * twice in a file, GitHub appends `-1`, `-2`, … to disambiguate. We don't
 * model that — instead we expose every disambiguation candidate
 * (`slug`, `slug-1`, `slug-2`, …) when a duplicate is detected, so a link
 * to either form passes.
 */
function slugifyHeading(text) {
  const PUNCT_RE =
    /[\u2000-\u206F\u2E00-\u2E7F\\'!"#$%&()*+,./:;<=>?@\[\]^`{|}~]/g;
  return text.toLowerCase().trim().replace(PUNCT_RE, '').replace(/\s/g, '-');
}

/**
 * Extract the inline-text part of a heading line. Strips:
 *   - leading `#` markers
 *   - trailing `{#explicit-id}` (kramdown-style — we don't honour the id,
 *     we just don't want it to leak into the slug)
 *   - inline backticks (the slugger keeps them as letters anyway, but
 *     stripping makes the result cleaner)
 *   - inline `<a id="…"></a>` markers (we register those separately)
 */
function headingText(line) {
  let t = line.replace(/^#+\s+/, '');
  t = t.replace(/\s+#+\s*$/, '');
  t = t.replace(/\{#[^}]+\}\s*$/, '');
  t = t.replace(/<a\s+(?:id|name)=["'][^"']*["'][^>]*>\s*<\/a>/gi, '');
  t = t.replace(/<a\s+(?:id|name)=["'][^"']*["'][^>]*\/>/gi, '');
  t = t.replace(/`/g, '');
  return t.trim();
}

/**
 * Build the set of available anchors for a single markdown file.
 * Returns a Set<string>.
 *
 * Sources of anchors:
 *   - explicit HTML: <a id="x"></a>, <a id="x" />, <a name="x"></a>
 *   - heading slugs (ATX `#…` headings only — the codebase doesn't
 *     use Setext `===`/`---` underlines for headings)
 */
function collectAnchors(absPath) {
  const raw = read(absPath);
  const text = stripHtmlComments(stripMarkdownCode(raw));
  const anchors = new Set();

  const htmlAnchorRe =
    /<a\s+(?:id|name)\s*=\s*["']([^"']+)["'][^>]*(?:\/>|>\s*<\/a>)/gi;
  let m;
  while ((m = htmlAnchorRe.exec(text)) !== null) {
    anchors.add(m[1]);
  }

  const slugCounts = new Map();
  for (const rawLine of text.split('\n')) {
    const hMatch = rawLine.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (!hMatch) continue;
    const slug = slugifyHeading(headingText(hMatch[2]));
    if (!slug) continue;
    const seen = slugCounts.get(slug) ?? 0;
    if (seen === 0) {
      anchors.add(slug);
    } else {
      anchors.add(`${slug}-${seen}`);
    }
    slugCounts.set(slug, seen + 1);
  }

  return anchors;
}

/**
 * Returns a list of `{ target, line }` objects for every markdown link
 * `[text](target)` in `mdText`, excluding image syntax `![…](…)`.
 *
 * `mdText` MUST already be passed through stripMarkdownCode() — otherwise
 * link-like sequences inside fenced code blocks are reported.
 */
function extractMarkdownLinks(mdText) {
  const out = [];
  const lines = mdText.split('\n');
  const linkRe = /(!?)\[(?:[^\]\\]|\\.)*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    let m;
    linkRe.lastIndex = 0;
    while ((m = linkRe.exec(line)) !== null) {
      if (m[1] === '!') continue;
      out.push({ target: m[2], line: i + 1 });
    }
  }
  return out;
}

/** Files we feed to the link checker. */
function findMarkdownFilesForLinks() {
  const files = [];
  if (existsSync(README_PATH)) files.push(README_PATH);
  if (existsSync(DOCS_DIR)) {
    for (const f of walk(DOCS_DIR)) {
      if (f.endsWith('.md')) files.push(f);
    }
  }
  files.sort();
  return files;
}

/**
 * Decide whether a link target should be checked at all.
 * We deliberately ignore:
 *   - external schemes (http(s), mailto:, tel:, ftp:, javascript:)
 *   - protocol-relative URLs (//host/...)
 *   - links to non-.md files (source code, schema, images linked as files)
 *   - links to directories (./docs/pilot, ./docs/adr)
 *
 * What we DO check:
 *   - `#anchor`            (in-file anchor)
 *   - `path.md`            (file existence only)
 *   - `path.md#anchor`     (file + anchor)
 */
function classifyLinkTarget(target) {
  if (!target) return { kind: 'skip' };
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) return { kind: 'skip' };

  const [pathPart, anchorPart] = (() => {
    const i = target.indexOf('#');
    if (i < 0) return [target, null];
    return [target.slice(0, i), target.slice(i + 1)];
  })();

  if (pathPart === '' && anchorPart) {
    return { kind: 'local-anchor', anchor: anchorPart };
  }
  if (pathPart.endsWith('.md')) {
    return { kind: 'md', path: pathPart, anchor: anchorPart || null };
  }
  return { kind: 'skip' };
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function checkCritical() {
  const errors = [];
  for (const rel of CRITICAL_DOCS) {
    const abs = join(ROOT, rel);
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      errors.push(`[docs:critical] Missing required doc: ${rel}`);
    }
  }
  return { errors, total: CRITICAL_DOCS.length };
}

function checkErd(schemaText, erdText) {
  const errors = [];
  const { enums, models } = parsePrismaTopLevel(schemaText);
  for (const e of enums) {
    if (!tokenInDoc(e, erdText)) {
      errors.push(`[docs:erd]    Missing enum in docs/erd.md:  ${e}`);
    }
  }
  for (const mdl of models) {
    if (!tokenInDoc(mdl, erdText)) {
      errors.push(`[docs:erd]    Missing model in docs/erd.md: ${mdl}`);
    }
  }
  return { errors, totalEnums: enums.length, totalModels: models.length };
}

function checkApi(apiText) {
  const errors = [];
  const files = findControllerFiles();
  let totalRoutes = 0;
  const seenPaths = new Set();

  for (const f of files) {
    const parsed = parseControllerFile(f);
    if (!parsed) {
      errors.push(
        `[docs:api]    No @Controller(...) found in: ${relative(ROOT, f)}`,
      );
      continue;
    }
    if (!apiText.includes(parsed.relPath)) {
      errors.push(
        `[docs:api]    Missing controller in docs/api.md: ${parsed.relPath}`,
      );
    }
    for (const r of parsed.routes) {
      totalRoutes += 1;
      const key = `${r.method} ${r.path}`;
      if (seenPaths.has(key)) continue;
      seenPaths.add(key);
      if (!pathInDoc(r.path, apiText)) {
        errors.push(
          `[docs:api]    Missing endpoint in docs/api.md:   ${r.method} ${r.path}`,
        );
      }
    }
  }
  return { errors, totalControllers: files.length, totalRoutes };
}

function checkEvents(schemaText, auditText, eventsText) {
  const errors = [];
  const passportValues = parsePrismaEnumValues(schemaText, 'PassportEventType');
  if (passportValues.length === 0) {
    errors.push(
      '[docs:events] Could not parse PassportEventType from prisma/schema.prisma',
    );
  }
  const sortedPassport = [...passportValues].sort();
  for (const v of sortedPassport) {
    if (!tokenInDoc(v, eventsText)) {
      errors.push(
        `[docs:events] Missing PassportEventType in docs/events.md: ${v}`,
      );
    }
  }

  const auditMembers = parseTsUnionMembers(auditText, 'AuditEntityType');
  if (auditMembers.length === 0) {
    errors.push(
      `[docs:events] Could not parse AuditEntityType from ${relative(
        ROOT,
        AUDIT_SERVICE_PATH,
      )}`,
    );
  }
  for (const v of auditMembers) {
    if (!tokenInDoc(v, eventsText)) {
      errors.push(
        `[docs:events] Missing AuditEntityType in docs/events.md:    ${v}`,
      );
    }
  }
  return {
    errors,
    totalPassport: passportValues.length,
    totalAudit: auditMembers.length,
  };
}

function checkLinks() {
  const errors = [];
  const files = findMarkdownFilesForLinks();
  const anchorCache = new Map();
  let totalLinks = 0;

  function getAnchors(absPath) {
    let s = anchorCache.get(absPath);
    if (!s) {
      s = collectAnchors(absPath);
      anchorCache.set(absPath, s);
    }
    return s;
  }

  for (const absSrc of files) {
    const relSrc = relative(ROOT, absSrc).split(sep).join('/');
    const srcDir = dirname(absSrc);
    const raw = read(absSrc);
    const stripped = stripHtmlComments(stripMarkdownCode(raw));
    const links = extractMarkdownLinks(stripped);

    for (const { target } of links) {
      const cls = classifyLinkTarget(target);
      if (cls.kind === 'skip') continue;
      totalLinks += 1;

      if (cls.kind === 'local-anchor') {
        const anchors = getAnchors(absSrc);
        if (!anchors.has(cls.anchor)) {
          errors.push(
            `[docs:links] Missing local anchor: ${relSrc}#${cls.anchor}`,
          );
        }
        continue;
      }

      const absTarget = resolve(srcDir, cls.path);
      const relTarget = relative(ROOT, absTarget).split(sep).join('/');
      if (!existsSync(absTarget) || !statSync(absTarget).isFile()) {
        errors.push(`[docs:links] Missing file: ${relSrc} -> ${relTarget}`);
        continue;
      }
      if (cls.anchor) {
        const anchors = getAnchors(absTarget);
        if (!anchors.has(cls.anchor)) {
          errors.push(
            `[docs:links] Missing anchor: ${relSrc} -> ${relTarget}#${cls.anchor}`,
          );
        }
      }
    }
  }

  return { errors, totalFiles: files.length, totalLinks };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const allErrors = [];

  // 1. Critical docs existence (must come first — other checks read these).
  const critical = checkCritical();
  allErrors.push(...critical.errors);

  // If api.md / erd.md / events.md are missing, we cannot run their checks.
  const haveApi = existsSync(DOC_API);
  const haveErd = existsSync(DOC_ERD);
  const haveEvents = existsSync(DOC_EVENTS);

  const schemaText = existsSync(SCHEMA_PATH) ? read(SCHEMA_PATH) : '';
  if (!schemaText) {
    allErrors.push('[docs:check]  prisma/schema.prisma not found — aborting.');
  }
  const auditText = existsSync(AUDIT_SERVICE_PATH)
    ? read(AUDIT_SERVICE_PATH)
    : '';
  if (!auditText) {
    allErrors.push(
      `[docs:check]  ${relative(
        ROOT,
        AUDIT_SERVICE_PATH,
      )} not found — AuditEntityType check skipped.`,
    );
  }

  let erdStats = null;
  let apiStats = null;
  let eventsStats = null;
  let linksStats = null;

  if (haveErd && schemaText) {
    erdStats = checkErd(schemaText, read(DOC_ERD));
    allErrors.push(...erdStats.errors);
  }
  if (haveApi) {
    apiStats = checkApi(read(DOC_API));
    allErrors.push(...apiStats.errors);
  }
  if (haveEvents && schemaText) {
    eventsStats = checkEvents(
      schemaText,
      auditText,
      read(DOC_EVENTS),
    );
    allErrors.push(...eventsStats.errors);
  }

  linksStats = checkLinks();
  allErrors.push(...linksStats.errors);

  // -- Output --------------------------------------------------------------
  if (allErrors.length === 0) {
    const parts = [
      `${critical.total} critical docs`,
      erdStats
        ? `${erdStats.totalEnums + erdStats.totalModels} prisma symbols ` +
          `(${erdStats.totalEnums} enums + ${erdStats.totalModels} models)`
        : null,
      apiStats
        ? `${apiStats.totalControllers} controllers, ${apiStats.totalRoutes} endpoints`
        : null,
      eventsStats
        ? `${eventsStats.totalPassport} PassportEventType, ` +
          `${eventsStats.totalAudit} AuditEntityType`
        : null,
      linksStats
        ? `${linksStats.totalLinks} md links across ${linksStats.totalFiles} files`
        : null,
    ].filter(Boolean);
    console.log(`[docs:check]  OK: ${parts.join('; ')} — all referenced.`);
    process.exit(0);
  }

  for (const e of allErrors) console.log(e);
  console.log('');
  console.log(`[docs:check]  FAIL: ${allErrors.length} drift issue(s) found.`);
  process.exit(1);
}

main();
