import { Request, Response, Router } from "express";
import { z } from "zod";
import { validate } from "../../middleware/validate";
import { ok } from "../../utils/respond";
import { autocompletePlaces, getPlaceDetails } from "./places.service";

/** A per-search session token the app makes up (a UUID); Google bills one search per token. */
const session = z.string().trim().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/).optional();

const autocompleteQuery = z.object({ q: z.string().trim().min(2).max(120), session });
const detailsParams = z.object({ placeId: z.string().trim().min(5).max(300).regex(/^[A-Za-z0-9_-]+$/) });
const detailsQuery = z.object({ session });

/**
 * Public place search for the apps (GET /v1/places/autocomplete, GET /v1/places/:placeId).
 * No sign-in needed: guests search too. 503 with `reason: places_not_configured` until the team
 * adds a Maps server key, so an app can say so instead of failing silently.
 */
export const placesRouter = Router();

placesRouter.get("/places/autocomplete", validate({ query: autocompleteQuery }), async (req: Request, res: Response) => {
  const { q, session: token } = req.valid!.query as z.infer<typeof autocompleteQuery>;
  res.setHeader("Cache-Control", "private, max-age=300");
  ok(res, await autocompletePlaces(q, token));
});

placesRouter.get("/places/:placeId", validate({ params: detailsParams, query: detailsQuery }), async (req: Request, res: Response) => {
  const { placeId } = req.valid!.params as z.infer<typeof detailsParams>;
  const { session: token } = req.valid!.query as z.infer<typeof detailsQuery>;
  res.setHeader("Cache-Control", "private, max-age=3600");
  ok(res, await getPlaceDetails(placeId, token));
});
