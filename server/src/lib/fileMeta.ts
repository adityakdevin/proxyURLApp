import exifr from 'exifr';

export interface FileMeta {
  software?: string;
  make?: string;
  model?: string;
  createDate?: string;
  modifyDate?: string;
  hasCameraData: boolean;
  /** Human-readable reasons the file looks AI-generated / non-camera. Advisory only. */
  aiSignals: string[];
}

/** Software/tool strings that indicate AI image generation. Also used by the REDFLAG
 *  editor/AI watermark rule, which reads the same names out of a PDF's Producer/Creator. */
export const AI_RE = /gemini|dall[- ]?e|midjourney|stable ?diffusion|firefly|openai|chatgpt|ideogram/i;

const str = (v: unknown): string | undefined => {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s.length ? s : undefined;
};

/**
 * Pure AI-origin heuristic (unit-testable). Flags when a producer/software/creator tool
 * names a known AI generator, OR when a JPEG carries no camera make/model (a common
 * signature of AI output, screenshots, or scrubbed images). Advisory — the caller must
 * treat these as WARNINGs, never an automatic failure.
 */
export function detectAiSignals(input: {
  software?: string | null;
  producer?: string | null;
  creatorTool?: string | null;
  make?: string | null;
  model?: string | null;
  mimeType?: string | null;
}): string[] {
  const signals: string[] = [];
  const named: [string, string | null | undefined][] = [
    ['software', input.software],
    ['producer', input.producer],
    ['creatorTool', input.creatorTool],
  ];
  for (const [key, val] of named) {
    if (val && AI_RE.test(val)) signals.push(`${key}: ${val}`);
  }
  const mime = (input.mimeType ?? '').toLowerCase();
  const isJpeg = mime.includes('jpeg') || mime.includes('jpg');
  if (isJpeg && !input.make && !input.model) {
    signals.push('no camera make/model on a JPEG');
  }
  return signals;
}

/**
 * Read file metadata via exifr and derive AI-origin signals. Never throws — returns an
 * empty-ish FileMeta on any parse failure (e.g. formats exifr can't read).
 */
export async function readFileMeta(
  absolutePath: string,
  mimeType: string | null
): Promise<FileMeta> {
  let raw: Record<string, unknown> = {};
  try {
    // Default segments cover TIFF/IFD0 (Make/Model/Software); add XMP for CreatorTool/Producer.
    raw = ((await exifr.parse(absolutePath, { xmp: true })) ?? {}) as Record<string, unknown>;
  } catch {
    raw = {};
  }
  const software = str(raw.Software) ?? str(raw.CreatorTool) ?? str(raw.creatorTool);
  const make = str(raw.Make);
  const model = str(raw.Model);
  return {
    software,
    make,
    model,
    createDate: str(raw.CreateDate) ?? str(raw.DateTimeOriginal),
    modifyDate: str(raw.ModifyDate),
    hasCameraData: Boolean(make || model),
    aiSignals: detectAiSignals({
      software,
      producer: str(raw.Producer),
      creatorTool: str(raw.CreatorTool) ?? str(raw.creatorTool),
      make,
      model,
      mimeType,
    }),
  };
}
