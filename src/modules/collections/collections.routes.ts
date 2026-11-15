import { Request, Response, Router } from "express";
import { z } from "zod";
import { anonClient } from "../../lib/supabase";
import { validate } from "../../middleware/validate";
import { ok } from "../../utils/respond";
import { getPublishedCollection, listPublishedCollections } from "./collections.service";

/**
 * Public, read-only. Always the anonymous client: a collection is either public or it does not
 * exist for this endpoint -- an admin previewing an unpublished one uses /v1/admin/collections.
 */
export const collectionsRouter = Router();

export const collectionRefParamSchema = z.object({
  idOrSlug: z.string().min(1).max(80).regex(/^[a-z0-9-]+$/i, "Must be a collection id or slug."),
});

collectionsRouter.get("/collections", async (_req: Request, res: Response) => {
  ok(res, await listPublishedCollections(anonClient));
});

collectionsRouter.get("/collections/:idOrSlug", validate({ params: collectionRefParamSchema }), async (req: Request, res: Response) => {
  const { idOrSlug } = req.valid!.params as z.infer<typeof collectionRefParamSchema>;
  ok(res, await getPublishedCollection(anonClient, idOrSlug));
});
