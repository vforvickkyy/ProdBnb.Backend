import { Request, Response } from "express";
import { created, ok } from "../../utils/respond";
import {
  addCollectionListings,
  createCollection,
  deleteCollection,
  getCollectionForAdmin,
  listCollectionsForAdmin,
  removeCollectionListing,
  reorderCollectionListings,
  requestCollectionCoverUpload,
  setCollectionCover,
  updateCollection,
} from "../collections/collections.service";
import {
  AdminCreateLocationInput,
  CatalogItemParam,
  CatalogListingParam,
  CatalogListingsQuery,
  CollectionCreateInput,
  CollectionIdParam,
  CollectionListingParam,
  CollectionUpdateInput,
  CoverCompleteInput,
  CoverUploadRequestInput,
  HostSearchQuery,
  LocationIdsInput,
  OrderedLocationIdsInput,
} from "./admin.schema";
import {
  addCatalogListings,
  listCatalogListings,
  removeCatalogCover,
  removeCatalogListing,
  requestCatalogCoverUpload,
  setCatalogCover,
} from "./catalog.service";
import { createLocationForHost, searchHostCandidates } from "./listings.service";

// -- Listings created for a host -------------------------------------------------------------------

export async function postAdminCreateLocationHandler(req: Request, res: Response): Promise<void> {
  created(res, await createLocationForHost(req.user!.id, req.valid!.body as AdminCreateLocationInput));
}

export async function getHostCandidatesHandler(req: Request, res: Response): Promise<void> {
  ok(res, await searchHostCandidates(req.valid!.query as HostSearchQuery));
}

// -- Catalog covers + listings ----------------------------------------------------------------------

export async function postCatalogCoverUploadHandler(req: Request, res: Response): Promise<void> {
  const { kind, itemId } = req.valid!.params as CatalogItemParam;
  created(res, await requestCatalogCoverUpload(kind, itemId, req.valid!.body as CoverUploadRequestInput));
}

export async function putCatalogCoverHandler(req: Request, res: Response): Promise<void> {
  const { kind, itemId } = req.valid!.params as CatalogItemParam;
  const { storage_key } = req.valid!.body as CoverCompleteInput;
  ok(res, await setCatalogCover(req.user!.id, kind, itemId, storage_key));
}

export async function deleteCatalogCoverHandler(req: Request, res: Response): Promise<void> {
  const { kind, itemId } = req.valid!.params as CatalogItemParam;
  ok(res, await removeCatalogCover(req.user!.id, kind, itemId));
}

export async function getCatalogListingsHandler(req: Request, res: Response): Promise<void> {
  const { kind, itemId } = req.valid!.params as CatalogItemParam;
  const { page, pageSize } = req.valid!.query as CatalogListingsQuery;
  const { data, total } = await listCatalogListings(kind, itemId, page, pageSize);
  ok(res, data, 200, { page, pageSize, total });
}

export async function postCatalogListingsHandler(req: Request, res: Response): Promise<void> {
  const { kind, itemId } = req.valid!.params as CatalogItemParam;
  const { location_ids } = req.valid!.body as LocationIdsInput;
  ok(res, await addCatalogListings(req.user!.id, kind, itemId, location_ids));
}

export async function deleteCatalogListingHandler(req: Request, res: Response): Promise<void> {
  const { kind, itemId, locationId } = req.valid!.params as CatalogListingParam;
  await removeCatalogListing(req.user!.id, kind, itemId, locationId);
  ok(res, { removed: true });
}

// -- Collections -----------------------------------------------------------------------------------

export async function getCollectionsHandler(_req: Request, res: Response): Promise<void> {
  ok(res, await listCollectionsForAdmin());
}

export async function getCollectionHandler(req: Request, res: Response): Promise<void> {
  const { collectionId } = req.valid!.params as CollectionIdParam;
  ok(res, await getCollectionForAdmin(collectionId));
}

export async function postCollectionHandler(req: Request, res: Response): Promise<void> {
  created(res, await createCollection(req.user!.id, req.valid!.body as CollectionCreateInput));
}

export async function patchCollectionHandler(req: Request, res: Response): Promise<void> {
  const { collectionId } = req.valid!.params as CollectionIdParam;
  ok(res, await updateCollection(req.user!.id, collectionId, req.valid!.body as CollectionUpdateInput));
}

export async function deleteCollectionHandler(req: Request, res: Response): Promise<void> {
  const { collectionId } = req.valid!.params as CollectionIdParam;
  await deleteCollection(req.user!.id, collectionId);
  ok(res, { deleted: true });
}

export async function postCollectionCoverUploadHandler(req: Request, res: Response): Promise<void> {
  const { collectionId } = req.valid!.params as CollectionIdParam;
  created(res, await requestCollectionCoverUpload(collectionId, req.valid!.body as CoverUploadRequestInput));
}

export async function putCollectionCoverHandler(req: Request, res: Response): Promise<void> {
  const { collectionId } = req.valid!.params as CollectionIdParam;
  const { storage_key } = req.valid!.body as CoverCompleteInput;
  ok(res, await setCollectionCover(req.user!.id, collectionId, storage_key));
}

export async function deleteCollectionCoverHandler(req: Request, res: Response): Promise<void> {
  const { collectionId } = req.valid!.params as CollectionIdParam;
  ok(res, await setCollectionCover(req.user!.id, collectionId, null));
}

export async function postCollectionListingsHandler(req: Request, res: Response): Promise<void> {
  const { collectionId } = req.valid!.params as CollectionIdParam;
  const { location_ids } = req.valid!.body as LocationIdsInput;
  ok(res, await addCollectionListings(req.user!.id, collectionId, location_ids));
}

export async function putCollectionOrderHandler(req: Request, res: Response): Promise<void> {
  const { collectionId } = req.valid!.params as CollectionIdParam;
  const { ordered_ids } = req.valid!.body as OrderedLocationIdsInput;
  ok(res, await reorderCollectionListings(req.user!.id, collectionId, ordered_ids));
}

export async function deleteCollectionListingHandler(req: Request, res: Response): Promise<void> {
  const { collectionId, locationId } = req.valid!.params as CollectionListingParam;
  ok(res, await removeCollectionListing(req.user!.id, collectionId, locationId));
}
