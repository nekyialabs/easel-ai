import OpenAI from 'openai';

const apiKey = process.env.OPENAI_API_KEY?.trim() ?? '';
if (!apiKey) {
  console.warn(
    '[easel] No OPENAI_API_KEY found in env — /api/generate and /api/workshop/* will fail. Copy .env.example to .env and fill it in.',
  );
} else {
  console.log('[easel] OpenAI key loaded.');
}

export const openai = new OpenAI({ apiKey });

// Default to gpt-image-1.5 (works without OpenAI org verification).
// Upgrade to gpt-image-2 by setting EASEL_IMAGE_MODEL=gpt-image-2 — that model
// requires a verified organisation on platform.openai.com.
export const IMAGE_MODEL = process.env.EASEL_IMAGE_MODEL ?? 'gpt-image-2.6-sunburst';

// Text + vision model used by the Workshop (prompt brainstorm, image-to-prompt).
// Must support image inputs (vision) for /api/workshop/from-image.
export const TEXT_MODEL = process.env.EASEL_TEXT_MODEL ?? 'gpt-5.4';

// Sizes accepted by the gpt-image-* family. The API only takes specific sizes,
// so we map aspect ratios to the nearest supported size.
export const ASPECT_TO_SIZE: Record<string, string> = {
  '1:1': '1024x1024',
  '3:2': '1536x1024',
  '2:3': '1024x1536',
  '16:9': '1536x864',
  '9:16': '864x1536',
};

export const QUALITY_OPTIONS = ['low', 'medium', 'high'] as const;
export type Quality = (typeof QUALITY_OPTIONS)[number];

export type GenerateInput = {
  prompt: string;
  aspect: keyof typeof ASPECT_TO_SIZE;
  n: number;
  quality: Quality;
  /** Reference image path on disk (for edit/remix). Optional. */
  referenceImagePath?: string | null;
};

export type GenerateOutput = {
  images: Buffer[]; // one per variant
};
