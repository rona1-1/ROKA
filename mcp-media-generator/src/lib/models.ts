/**
 * src/lib/models.ts — سجل الموديلات الموحَّد.
 *
 * الموديلان المدمجان (مثبتان كما هما):
 *  - gpt-image-2-6/flare-text-to-image  (image)  — kie + cometapi
 *  - grok-imagine-video-1-5-preview     (video)  — kie + cometapi
 *
 * نقبل الصيغ البديلة بالنقاط (gpt-image-2.6/...) ونوحّدها.
 * الأسماء قابلة للتجاوز بمتغيرات البيئة:
 *   KIE_IMAGE_MODEL, KIE_VIDEO_MODEL,
 *   COMETAPI_IMAGE_MODEL, COMETAPI_VIDEO_MODEL.
 */

export type ProviderId = "kie" | "cometapi";
export type TaskProvider = ProviderId | "merger";
export type MediaType = "image" | "video" | "merge";

export interface ModelDef {
  canonical: string;
  aliases: string[];
  type: MediaType;
  providers: ProviderId[];
  providerModel: Record<ProviderId, string>;
}

/** الموديلات المثبتة. */
export const MODELS: ModelDef[] = [
  {
    canonical: "gpt-image-2-6/flare-text-to-image",
    aliases: [
      "gpt-image-2-6/flare-text-to-image",
      "gpt-image-2.6/flare-text-to-image",
    ],
    type: "image",
    providers: ["kie", "cometapi"],
    providerModel: {
      kie: process.env.KIE_IMAGE_MODEL || "gpt-image-2-6/flare-text-to-image",
      cometapi:
        process.env.COMETAPI_IMAGE_MODEL ||
        "gpt-image-2.6-flare-text-to-image",
    },
  },
  {
    canonical: "grok-imagine-video-1-5-preview",
    aliases: [
      "grok-imagine-video-1-5-preview",
      "grok-imagine-video-1.5-preview",
    ],
    type: "video",
    providers: ["kie", "cometapi"],
    providerModel: {
      kie:
        process.env.KIE_VIDEO_MODEL ||
        "grok-imagine-video-1-5-preview",
      cometapi:
        process.env.COMETAPI_VIDEO_MODEL ||
        "grok-imagine-video-1-5-preview",
    },
  },
];

/** يوحّد اسم الموديل — يقبل الأسماء البديلة ويعيد الـ canonical. */
export function resolveModel(input: string): ModelDef | null {
  const norm = input.toLowerCase().trim();
  for (const m of MODELS) {
    if (m.aliases.some((a) => a.toLowerCase() === norm)) return m;
  }
  return null;
}

/** يجلب موديلًا بالنوع. */
export function modelByType(type: MediaType): ModelDef | null {
  return MODELS.find((m) => m.type === type) ?? null;
}
