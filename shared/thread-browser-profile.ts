import { z } from "zod";

const fields = {
  active: z.object({ profileId: z.string().nullable() }).nullable(),
  activeProfileId: z.string().nullable(),
  viewerProfileId: z.string().nullable(),
  requestedProfileId: z.string().nullable(),
  profiles: z.array(z.object({ id: z.string().nullable(), name: z.string() })),
};

export const threadBrowserProfileSchema = z.discriminatedUnion("status", [
  z.object({ ...fields, status: z.literal("ready") }),
  z.object({ ...fields, status: z.enum(["pending", "reconnect"]) }),
  z.object({ ...fields, status: z.literal("error"), error: z.string() }),
]);

export type ThreadBrowserProfile = z.infer<typeof threadBrowserProfileSchema>;
