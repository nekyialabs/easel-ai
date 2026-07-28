// Must be the FIRST import: ESM evaluates imports in source order, and
// ./openai.js reads process.env.OPENAI_API_KEY at module-load time. Loading
// dotenv any later leaves that read seeing an empty env, which surfaces as a
// 401 from the OpenAI API that misleadingly blames the user's own key.
import 'dotenv/config';

import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toFile } from 'openai';

import { db, newId, type Folder, type Preset, type PresetType, type Task, type Variant } from './db.js';
import { ASPECT_TO_SIZE, IMAGE_MODEL, openai, QUALITY_OPTIONS, TEXT_MODEL, type Quality } from './openai.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const IMAGES_DIR = join(ROOT, 'data', 'images');
const REFS_DIR = join(ROOT, 'data', 'refs');
const PUBLIC_DIR = join(ROOT, 'public');

mkdirSync(IMAGES_DIR, { recursive: true });
mkdirSync(REFS_DIR, { recursive: true });

// Generation runs synchronously inside the request handler, so any task still
// 'pending' at boot was interrupted by a crash/restart and will never finish.
const sweptPending = db
  .prepare(`UPDATE tasks SET status = 'failed', error = 'interrupted by server restart' WHERE status = 'pending'`)
  .run();
if (sweptPending.changes > 0) {
  console.log(`[easel] marked ${sweptPending.changes} interrupted pending task(s) as failed`);
}

const ALLOWED_UPLOAD_EXT = new Set(['.png', '.webp', '.jpg', '.jpeg']);
const MAX_UPLOAD_BYTES = 24 * 1024 * 1024; // 24MB, slightly under OpenAI's 25MB limit

const app = new Hono();

// ---- Uploads (reference images) ----

app.post('/api/upload', async (c) => {
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: 'multipart body required' }, 400);
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') return c.json({ error: 'no file field' }, 400);

  const raw = file as File;
  const name = raw.name || 'upload.png';
  const ext = extname(name).toLowerCase() || '.png';
  if (!ALLOWED_UPLOAD_EXT.has(ext)) {
    return c.json({ error: `unsupported file type: ${ext}` }, 400);
  }
  if (raw.size > MAX_UPLOAD_BYTES) {
    return c.json({ error: `file too large (max ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB)` }, 400);
  }

  const buf = Buffer.from(await raw.arrayBuffer());
  const id = newId('ref');
  const rel = `${id}${ext}`;
  writeFileSync(join(REFS_DIR, rel), buf);
  return c.json({ path: rel, size: buf.length });
});

// ---- Presets ----

app.get('/api/presets', (c) => {
  const rows = db
    .prepare('SELECT * FROM presets WHERE archived = 0 ORDER BY updated_at DESC')
    .all() as Preset[];
  return c.json(rows);
});

app.get('/api/presets/:id', (c) => {
  const id = c.req.param('id');
  const row = db.prepare('SELECT * FROM presets WHERE id = ?').get(id) as Preset | undefined;
  if (!row) return c.json({ error: 'not found' }, 404);
  return c.json(row);
});

// Create a brand-new preset (v1) or fork an existing one (v+1)
app.post('/api/presets', async (c) => {
  const body = (await c.req.json()) as {
    name: string;
    body: string;
    type?: PresetType;
    reference_image_path?: string | null;
    fork_from?: string | null;
  };
  if (!body.name?.trim() || !body.body?.trim()) {
    return c.json({ error: 'name and body required' }, 400);
  }
  const type: PresetType = body.type === 'style' ? 'style' : 'character';

  const now = Date.now();
  let version = 1;
  let parent_id: string | null = null;

  if (body.fork_from) {
    const parent = db.prepare('SELECT * FROM presets WHERE id = ?').get(body.fork_from) as
      | Preset
      | undefined;
    if (!parent) return c.json({ error: 'fork_from preset not found' }, 400);
    const maxRow = db
      .prepare('SELECT MAX(version) AS v FROM presets WHERE name = ?')
      .get(parent.name) as { v: number | null };
    version = (maxRow.v ?? parent.version) + 1;
    parent_id = parent.id;
  } else {
    const existing = db
      .prepare('SELECT MAX(version) AS v FROM presets WHERE name = ?')
      .get(body.name) as { v: number | null };
    if (existing.v) version = existing.v + 1;
  }

  const id = newId('pre');
  db.prepare(
    `INSERT INTO presets (id, name, version, parent_id, type, body, reference_image_path, use_count, created_at, updated_at, archived)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0)`,
  ).run(id, body.name, version, parent_id, type, body.body, body.reference_image_path ?? null, now, now);

  const row = db.prepare('SELECT * FROM presets WHERE id = ?').get(id) as Preset;
  return c.json(row);
});

app.patch('/api/presets/:id', async (c) => {
  const id = c.req.param('id');
  const body = (await c.req.json()) as {
    name?: string;
    body?: string;
    type?: PresetType;
    reference_image_path?: string | null;
    archived?: boolean;
  };
  const existing = db.prepare('SELECT * FROM presets WHERE id = ?').get(id) as Preset | undefined;
  if (!existing) return c.json({ error: 'not found' }, 404);

  db.prepare(
    `UPDATE presets SET
       name = COALESCE(?, name),
       body = COALESCE(?, body),
       type = COALESCE(?, type),
       reference_image_path = CASE WHEN ? = 1 THEN ? ELSE reference_image_path END,
       archived = COALESCE(?, archived),
       updated_at = ?
     WHERE id = ?`,
  ).run(
    body.name ?? null,
    body.body ?? null,
    body.type ?? null,
    body.reference_image_path !== undefined ? 1 : 0,
    body.reference_image_path ?? null,
    typeof body.archived === 'boolean' ? (body.archived ? 1 : 0) : null,
    Date.now(),
    id,
  );

  const row = db.prepare('SELECT * FROM presets WHERE id = ?').get(id) as Preset;
  return c.json(row);
});

// ---- Folders ----

app.get('/api/folders', (c) => {
  const rows = db.prepare('SELECT * FROM folders ORDER BY name ASC').all() as Folder[];
  return c.json(rows);
});

app.post('/api/folders', async (c) => {
  const body = (await c.req.json()) as { name: string };
  if (!body.name?.trim()) return c.json({ error: 'name required' }, 400);
  const id = newId('fld');
  const now = Date.now();
  db.prepare('INSERT INTO folders (id, name, created_at) VALUES (?, ?, ?)').run(id, body.name, now);
  const row = db.prepare('SELECT * FROM folders WHERE id = ?').get(id) as Folder;
  return c.json(row);
});

// ---- Tasks (and variants) ----

type PresetStackEntry = {
  id: string;
  name: string;
  version: number;
  type: PresetType;
  reference_image_path: string | null;
  position: number;
};

type TaskWithVariants = Task & {
  variants: Variant[];
  presets: PresetStackEntry[];
};

type ZipEntry = {
  name: string;
  data: Buffer;
};

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer) {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipStore(entries: ZipEntry[]) {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/\\/g, '/'));
    const data = entry.data;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // store, no compression
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, end]);
}

function presetsForTask(taskId: string): PresetStackEntry[] {
  return db
    .prepare(
      `SELECT p.id, p.name, p.version, p.type, p.reference_image_path, r.position
       FROM task_preset_refs r
       JOIN presets p ON p.id = r.preset_id
       WHERE r.task_id = ?
       ORDER BY r.position ASC`,
    )
    .all(taskId) as PresetStackEntry[];
}

function taskWithVariants(taskId: string): TaskWithVariants | null {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Task | undefined;
  if (!task) return null;
  const variants = db
    .prepare('SELECT * FROM variants WHERE task_id = ? ORDER BY idx ASC')
    .all(taskId) as Variant[];
  return { ...task, variants, presets: presetsForTask(taskId) };
}

app.post('/api/export', async (c) => {
  const body = (await c.req.json()) as { task_ids?: string[] };
  const taskIds = [...new Set(body.task_ids ?? [])].filter(Boolean).slice(0, 100);
  if (taskIds.length === 0) return c.json({ error: 'task_ids required' }, 400);

  const tasks = taskIds.map((id) => taskWithVariants(id)).filter((task): task is TaskWithVariants => !!task);
  if (tasks.length === 0) return c.json({ error: 'no matching tasks' }, 404);

  const metadata = tasks.map((task) => ({
    id: task.id,
    kind: task.kind,
    prompt: task.prompt,
    composed_prompt: task.composed_prompt ?? null,
    created_at: new Date(task.created_at).toISOString(),
    aspect_ratio: task.aspect_ratio,
    variant_count: task.variant_count,
    quality: task.quality,
    favorite: !!task.favorite,
    folder_id: task.folder_id,
    reference_image_path: task.reference_image_path,
    presets: task.presets,
    variants: task.variants.map((variant) => ({
      id: variant.id,
      idx: variant.idx,
      image_path: variant.image_path,
      archive_path: `images/${task.id}/${variant.idx}${extname(variant.image_path) || '.png'}`,
      width: variant.width,
      height: variant.height,
    })),
  }));

  const entries: ZipEntry[] = [
    {
      name: 'metadata.json',
      data: Buffer.from(
        JSON.stringify({ exported_at: new Date().toISOString(), app: 'easel-ai', tasks: metadata }, null, 2),
      ),
    },
  ];

  for (const task of tasks) {
    for (const variant of task.variants) {
      const imagePath = join(IMAGES_DIR, variant.image_path);
      if (!existsSync(imagePath)) continue;
      entries.push({
        name: `images/${task.id}/${variant.idx}${extname(variant.image_path) || '.png'}`,
        data: readFileSync(imagePath),
      });
    }
  }

  const zip = zipStore(entries);
  const filename = `easel-ai-export-${new Date().toISOString().slice(0, 10)}.zip`;
  return new Response(zip, {
    status: 200,
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${filename}"`,
    },
  });
});

app.get('/api/tasks', (c) => {
  const view = c.req.query('view') ?? 'media'; // media | favorites | trash | folder | all
  const folderId = c.req.query('folder_id') ?? null;

  let where = '';
  const args: unknown[] = [];
  if (view === 'all') where = '';
  else if (view === 'favorites') where = 'WHERE favorite = 1 AND trashed = 0';
  else if (view === 'trash') where = 'WHERE trashed = 1';
  else if (view === 'folder' && folderId) {
    where = 'WHERE folder_id = ? AND trashed = 0';
    args.push(folderId);
  } else where = 'WHERE trashed = 0';

  const tasks = db
    .prepare(`SELECT * FROM tasks ${where} ORDER BY created_at DESC LIMIT 500`)
    .all(...args) as Task[];

  if (tasks.length === 0) return c.json([]);
  const ids = tasks.map((t) => t.id);
  const placeholders = ids.map(() => '?').join(',');

  const variants = db
    .prepare(`SELECT * FROM variants WHERE task_id IN (${placeholders}) ORDER BY idx ASC`)
    .all(...ids) as Variant[];

  const presetRows = db
    .prepare(
      `SELECT r.task_id, p.id, p.name, p.version, p.type, p.reference_image_path, r.position
       FROM task_preset_refs r
       JOIN presets p ON p.id = r.preset_id
       WHERE r.task_id IN (${placeholders})
       ORDER BY r.position ASC`,
    )
    .all(...ids) as Array<PresetStackEntry & { task_id: string }>;

  const variantsByTask = new Map<string, Variant[]>();
  for (const v of variants) {
    const list = variantsByTask.get(v.task_id) ?? [];
    list.push(v);
    variantsByTask.set(v.task_id, list);
  }

  const presetsByTask = new Map<string, PresetStackEntry[]>();
  for (const r of presetRows) {
    const { task_id, ...entry } = r;
    const list = presetsByTask.get(task_id) ?? [];
    list.push(entry);
    presetsByTask.set(task_id, list);
  }

  const out: TaskWithVariants[] = tasks.map((t) => ({
    ...t,
    variants: variantsByTask.get(t.id) ?? [],
    presets: presetsByTask.get(t.id) ?? [],
  }));
  return c.json(out);
});

app.get('/api/tasks/:id', (c) => {
  const task = taskWithVariants(c.req.param('id'));
  if (!task) return c.json({ error: 'not found' }, 404);
  return c.json(task);
});

app.patch('/api/tasks/:id', async (c) => {
  const id = c.req.param('id');
  const body = (await c.req.json()) as {
    favorite?: boolean;
    trashed?: boolean;
    folder_id?: string | null;
  };
  const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined;
  if (!existing) return c.json({ error: 'not found' }, 404);

  db.prepare(
    `UPDATE tasks SET
       favorite = COALESCE(?, favorite),
       trashed  = COALESCE(?, trashed),
       folder_id = CASE WHEN ? = 1 THEN ? ELSE folder_id END
     WHERE id = ?`,
  ).run(
    typeof body.favorite === 'boolean' ? (body.favorite ? 1 : 0) : null,
    typeof body.trashed === 'boolean' ? (body.trashed ? 1 : 0) : null,
    body.folder_id !== undefined ? 1 : 0,
    body.folder_id ?? null,
    id,
  );

  const row = taskWithVariants(id);
  return c.json(row);
});

// ---- Generate ----

app.post('/api/generate', async (c) => {
  const body = (await c.req.json()) as {
    prompt: string;
    character_preset_ids?: string[];
    style_preset_id?: string | null;
    reference_image_path?: string | null;
    aspect: string;
    n: number;
    quality: Quality;
    folder_id?: string | null;
  };

  if (!body.prompt?.trim()) return c.json({ error: 'prompt required' }, 400);
  const size = ASPECT_TO_SIZE[body.aspect];
  if (!size) return c.json({ error: `unsupported aspect: ${body.aspect}` }, 400);
  if (!QUALITY_OPTIONS.includes(body.quality)) return c.json({ error: 'bad quality' }, 400);
  const n = Math.min(Math.max(1, body.n | 0), 4);

  // Resolve character presets (ordered by their position in the incoming array)
  const charIds = (body.character_preset_ids ?? []).filter(Boolean);
  const characterPresets: Preset[] = [];
  for (const id of charIds) {
    const p = db.prepare('SELECT * FROM presets WHERE id = ?').get(id) as Preset | undefined;
    if (!p) return c.json({ error: `character preset not found: ${id}` }, 400);
    if (p.type !== 'character') return c.json({ error: `preset ${id} is not a character` }, 400);
    characterPresets.push(p);
  }

  let stylePreset: Preset | null = null;
  if (body.style_preset_id) {
    stylePreset = db.prepare('SELECT * FROM presets WHERE id = ?').get(body.style_preset_id) as
      | Preset
      | null;
    if (!stylePreset) return c.json({ error: 'style preset not found' }, 400);
    if (stylePreset.type !== 'style') return c.json({ error: 'selected preset is not a style' }, 400);
  }

  // Compose prompt: char bodies → style body → user prompt (character first, user prompt last)
  const segments: string[] = [
    ...characterPresets.map((p) => p.body.trim()),
    ...(stylePreset ? [stylePreset.body.trim()] : []),
    body.prompt.trim(),
  ].filter(Boolean);
  const composedPrompt = segments.join('\n\n');

  // Gather reference images from character presets + direct attach (style presets don't carry refs)
  const referencePaths: string[] = [];
  for (const p of characterPresets) {
    if (p.reference_image_path) referencePaths.push(p.reference_image_path);
  }
  if (body.reference_image_path) referencePaths.push(body.reference_image_path);

  const taskId = newId('gen');
  const now = Date.now();

  db.prepare(
    `INSERT INTO tasks (id, kind, prompt, composed_prompt, preset_id, aspect_ratio, variant_count, quality, reference_image_path, folder_id, status, created_at)
     VALUES (?, 'image_generation', ?, ?, NULL, ?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(
    taskId,
    body.prompt.trim(),
    composedPrompt,
    body.aspect,
    n,
    body.quality,
    body.reference_image_path ?? null,
    body.folder_id ?? null,
    now,
  );

  // Write preset join rows (characters first, then style)
  const insertRef = db.prepare(
    `INSERT INTO task_preset_refs (task_id, preset_id, position) VALUES (?, ?, ?)`,
  );
  let pos = 0;
  for (const p of characterPresets) insertRef.run(taskId, p.id, pos++);
  if (stylePreset) insertRef.run(taskId, stylePreset.id, pos++);

  const t0 = Date.now();
  console.log(
    `[generate] ${taskId} start model=${IMAGE_MODEL} size=${size} n=${n} q=${body.quality} refs=${referencePaths.length} promptLen=${composedPrompt.length}`,
  );

  try {
    let result: any;
    let rawResponse: Response | null = null;
    if (referencePaths.length > 0) {
      const uploads = await Promise.all(
        referencePaths.map(async (rel) =>
          toFile(createReadStream(join(REFS_DIR, rel)), rel.split(/[/\\]/).pop() ?? 'ref.png'),
        ),
      );
      const wrapped = await openai.images
        .edit({
          model: IMAGE_MODEL,
          image: uploads.length === 1 ? uploads[0] : (uploads as any),
          prompt: composedPrompt,
          size: size as any,
          n,
          quality: body.quality as any,
        })
        .withResponse();
      result = wrapped.data;
      rawResponse = wrapped.response;
    } else {
      const wrapped = await openai.images
        .generate({
          model: IMAGE_MODEL,
          prompt: composedPrompt,
          size: size as any,
          n,
          quality: body.quality as any,
        })
        .withResponse();
      result = wrapped.data;
      rawResponse = wrapped.response;
    }

    if (rawResponse) {
      const h = rawResponse.headers;
      const pick = (k: string) => h.get(k);
      console.log(
        `[generate] ${taskId} openai headers processing_ms=${pick('openai-processing-ms')} request_id=${pick('x-request-id')} rate_remaining_req=${pick('x-ratelimit-remaining-requests')} rate_remaining_tok=${pick('x-ratelimit-remaining-tokens')}`,
      );
    }

    const images = result.data ?? [];
    if (images.length === 0) throw new Error('No images returned');

    const taskDir = join(IMAGES_DIR, taskId);
    mkdirSync(taskDir, { recursive: true });

    const [w, h] = size.split('x').map((x) => Number(x));
    const insertVariant = db.prepare(
      `INSERT INTO variants (id, task_id, idx, image_path, width, height, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      let bytes: Buffer;
      if (img.b64_json) {
        bytes = Buffer.from(img.b64_json, 'base64');
      } else if (img.url) {
        const resp = await fetch(img.url);
        bytes = Buffer.from(await resp.arrayBuffer());
      } else {
        throw new Error('Image response had no b64 or url');
      }
      const rel = `${taskId}/${i}.png`;
      writeFileSync(join(IMAGES_DIR, rel), bytes);
      insertVariant.run(newId('var'), taskId, i, rel, w, h, Date.now());
    }

    db.prepare(`UPDATE tasks SET status = 'succeeded' WHERE id = ?`).run(taskId);
    for (const p of characterPresets) {
      db.prepare('UPDATE presets SET use_count = use_count + 1 WHERE id = ?').run(p.id);
    }
    if (stylePreset) {
      db.prepare('UPDATE presets SET use_count = use_count + 1 WHERE id = ?').run(stylePreset.id);
    }
    const elapsed = Date.now() - t0;
    console.log(`[generate] ${taskId} done in ${elapsed}ms`);
    return c.json(taskWithVariants(taskId));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.prepare(`UPDATE tasks SET status = 'failed', error = ? WHERE id = ?`).run(message, taskId);
    const elapsed = Date.now() - t0;
    console.error(`[generate] ${taskId} FAILED after ${elapsed}ms:`, message);
    return c.json({ error: message, task_id: taskId }, 500);
  }
});

// ---- Workshop (prompt ideation) ----

const FROM_IMAGE_SYSTEM = `You are a precise visual describer for an image-generation pipeline.
Given an image, return ONE prompt (200-400 words) that would reproduce this image's essence if fed to an image generator like gpt-image-2.

Include:
- Subject (what/who, posture, expression, clothing)
- Composition (shot angle, framing, focal point)
- Lighting (source, direction, color temperature, mood)
- Color palette (dominant hues, warmth, saturation)
- Style/medium (photorealistic, painterly, illustration, film reference)
- Atmosphere (time of day, weather, emotion)
- Notable details that make it specific

Don't include: image quality jargon ("4k", "hd", "trending on artstation"), author signatures, brand names, watermarks.
Return just the prompt text. No preamble, no markdown headers.`;

const BRAINSTORM_SYSTEM = `You are a creative prompt architect for an image-generation pipeline (gpt-image-2).
The user has a vague idea or brain dump. Expand it into THREE specific, generator-ready prompts — each taking a distinct interpretive angle on their thought. Not variations: three genuinely different reads.

Each prompt should be 120-220 words and cover: subject, composition, lighting, palette, style, mood. Ground it in concrete visual detail, not abstraction.

Return a JSON object of this exact shape (no markdown, no preamble):
{
  "options": [
    { "title": "short evocative title", "prompt": "full prompt text" },
    { "title": "...", "prompt": "..." },
    { "title": "...", "prompt": "..." }
  ]
}`;

app.post('/api/workshop/from-image', async (c) => {
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: 'multipart body required' }, 400);
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') return c.json({ error: 'no file field' }, 400);

  const raw = file as File;
  const buf = Buffer.from(await raw.arrayBuffer());
  if (buf.length > MAX_UPLOAD_BYTES) return c.json({ error: 'file too large' }, 400);
  const mime = raw.type || 'image/png';
  const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;

  try {
    const resp = await openai.chat.completions.create({
      model: TEXT_MODEL,
      messages: [
        { role: 'system', content: FROM_IMAGE_SYSTEM },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this image as a generation-ready prompt.' },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
    });
    const text = resp.choices?.[0]?.message?.content ?? '';
    return c.json({ prompt: text.trim() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[workshop/from-image]', err);
    return c.json({ error: message }, 500);
  }
});

app.post('/api/workshop/brainstorm', async (c) => {
  const body = (await c.req.json()) as { dump: string };
  if (!body.dump?.trim()) return c.json({ error: 'dump required' }, 400);

  try {
    const resp = await openai.chat.completions.create({
      model: TEXT_MODEL,
      messages: [
        { role: 'system', content: BRAINSTORM_SYSTEM },
        { role: 'user', content: body.dump.trim() },
      ],
      response_format: { type: 'json_object' },
    });
    const text = resp.choices?.[0]?.message?.content ?? '{}';
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = {};
    }
    const options = Array.isArray(parsed)
      ? parsed
      : parsed.options || parsed.prompts || parsed.results || [];
    return c.json({ options });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[workshop/brainstorm]', err);
    return c.json({ error: message }, 500);
  }
});

// ---- Static: images + frontend ----

app.use('/images/*', serveStatic({ root: './data' })); // maps /images/foo to ./data/images/foo
app.use('/refs/*', serveStatic({ root: './data' })); // maps /refs/foo to ./data/refs/foo
app.use('/*', serveStatic({ root: './public' }));
app.get('/', serveStatic({ path: './public/index.html' }));

const port = Number(process.env.PORT ?? 5178);
// Bind to loopback by default: there is no auth on any endpoint, so exposing
// the gallery (and the BYOK generate endpoint) to the LAN must be opt-in via
// EASEL_HOST=0.0.0.0.
const hostname = process.env.EASEL_HOST ?? '127.0.0.1';
serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`\n  easel ready`);
  console.log(`  → http://localhost:${info.port}\n`);
});
