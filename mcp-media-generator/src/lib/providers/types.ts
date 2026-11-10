/**
 * src/lib/providers/types.ts — واجهة موحَّدة للمزودين.
 *
 * أي مزود ينفّذ هذه الواجهة ويرمي ProviderError عند الفشل.
 * classifyProviderError في errors.ts يتكفّل بالتصنيف.
 */

import type { ProviderId } from "../models";

export interface GenerateImageInput {
  prompt: string;
  aspect_ratio?: string;
  resolution?: string;
  background?: string;
  output_format?: string;
}

export interface GenerateVideoInput {
  prompt: string;
  image_url?: string;
  aspect_ratio?: string;
  resolution?: string;
  enable_audio?: boolean;
  duration?: number;
}

export interface ProviderAdapter {
  /** مهمة غير متزامنة (فيديو): تعيد providerTaskId. */
  createTask(
    key: string,
    providerModel: string,
    type: "image" | "video",
    input: GenerateImageInput | GenerateVideoInput
  ): Promise<{ providerTaskId: string }>;

  /** صور متزامنة إن كان المزود يدعمها — تعيد الروابط فورًا. */
  createImageSync?(
    key: string,
    providerModel: string,
    input: GenerateImageInput
  ): Promise<{ urls: string[] }>;

  /** استعلام حالة مهمة جارية. */
  checkTask(
    key: string,
    providerTaskId: string
  ): Promise<{
    status: "processing" | "completed" | "failed";
    urls?: string[];
    error?: string;
    progress?: number;
  }>;
}

export type { ProviderId };
