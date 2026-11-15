import { randomUUID } from "node:crypto";
import { env } from "../config/env";
import { ValidationError } from "../errors/AppError";
import { deleteObject, headObject, presignUpload } from "./r2";

/**
 * Admin Console 2: cover images for catalog items and collections.
 *
 * Same two-step flow as listing photos (src/modules/media): the API hands out a short-lived
 * presigned PUT URL, the browser uploads straight to R2, then the API is told the key and verifies
 * the object really exists, really is an image and is within the photo size limit before pointing
 * a row at it. Keys are namespaced per owner (`catalog/categories/<id>/...`), and `complete`
 * refuses any key outside that namespace, so a caller cannot point a cover at someone else's file.
 */
const IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export interface CoverUploadRequest {
  content_type: string;
  size_bytes: number;
}

export interface CoverUploadAuthorization {
  upload_url: string;
  storage_key: string;
  expires_at: string;
  method: "PUT";
  headers: Record<string, string>;
}

function maxBytes(): number {
  return env.MEDIA_MAX_PHOTO_SIZE_MB * 1024 * 1024;
}

export async function presignCoverUpload(prefix: string, input: CoverUploadRequest): Promise<CoverUploadAuthorization> {
  const ext = IMAGE_TYPES[input.content_type];
  if (!ext) {
    throw new ValidationError("Cover images must be JPEG, PNG or WebP.");
  }
  if (input.size_bytes > maxBytes()) {
    throw new ValidationError(`Cover images can be at most ${env.MEDIA_MAX_PHOTO_SIZE_MB}MB.`);
  }
  const key = `${prefix}/${randomUUID()}.${ext}`;
  const { url, expiresAt } = await presignUpload(key, input.content_type, input.size_bytes);
  return {
    upload_url: url,
    storage_key: key,
    expires_at: expiresAt.toISOString(),
    method: "PUT",
    headers: { "Content-Type": input.content_type },
  };
}

export async function verifyUploadedCover(prefix: string, key: string): Promise<void> {
  if (!key.startsWith(`${prefix}/`) || key.includes("..")) {
    throw new ValidationError("That upload does not belong to this item.");
  }
  const info = await headObject(key);
  if (!info) {
    throw new ValidationError("The image has not finished uploading yet. Try again in a moment.");
  }
  if (!info.contentType || !IMAGE_TYPES[info.contentType]) {
    throw new ValidationError("The uploaded file is not a JPEG, PNG or WebP image.");
  }
  if ((info.contentLength ?? 0) > maxBytes()) {
    await deleteObject(key).catch(() => undefined);
    throw new ValidationError(`Cover images can be at most ${env.MEDIA_MAX_PHOTO_SIZE_MB}MB.`);
  }
}

/** Best-effort cleanup of a replaced cover; an orphaned object is harmless, a failed request is not. */
export async function discardCover(key: string | null | undefined): Promise<void> {
  if (!key) {
    return;
  }
  try {
    await deleteObject(key);
  } catch (error) {
    console.error(`Failed to delete replaced cover ${key}:`, error);
  }
}
