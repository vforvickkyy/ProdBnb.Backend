import type { SupabaseClient } from "@supabase/supabase-js";

declare global {
  namespace Express {
    interface Request {
      /** Present once middleware/auth.ts has run successfully. */
      user?: {
        id: string;
        email: string | null;
      };
      /** Supabase client scoped to the calling user's JWT — RLS applies. */
      supabase?: SupabaseClient;
      /**
       * Memoised admin team role (src/modules/admin/permissions.ts). `undefined` = not looked up
       * yet; `null` = looked up, caller is not an admin.
       */
      adminTeamRole?: "super_admin" | "moderator" | "support" | "finance" | null;
      /** Populated by middleware/validate.ts — parsed, schema-validated request data. */
      valid?: {
        body?: unknown;
        query?: unknown;
        params?: unknown;
      };
    }
  }
}

export {};
