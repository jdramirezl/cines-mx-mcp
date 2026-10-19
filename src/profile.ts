/**
 * User profile: home cinemas with distances and viewing preferences. Not
 * secret; distances are the user's own. Overridable with CINES_PROFILE=<path>.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";

export const ProfileSchema = z.object({
  chain: z.literal("cinepolis").default("cinepolis"),
  timezone: z.string().default("America/Mexico_City"),
  cinemas: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        distanceKm: z.number().nonnegative(),
        vip: z.boolean().default(false),
      }),
    )
    .min(1),
  preferences: z
    .object({
      /** Most preferred first. */
      languages: z.array(z.enum(["SUB", "ESP", "ORIGINAL", "OTHER"])).default(["SUB", "ORIGINAL", "ESP"]),
      defaultTickets: z.number().int().min(1).max(10).default(1),
      defaultTicketType: z.string().default("Admision General"),
      /** Formats the user picks by default; others still allowed but ranked lower. */
      preferRegularOrVip: z.boolean().default(true),
    })
    .default({ languages: ["SUB", "ORIGINAL", "ESP"], defaultTickets: 1, defaultTicketType: "Admision General", preferRegularOrVip: true }),
});

export type Profile = z.infer<typeof ProfileSchema>;

export const DEFAULT_PROFILE: Profile = ProfileSchema.parse({
  cinemas: [
    { id: "cinepolis-parque-toreo-cdmx", label: "Parque Toreo", distanceKm: 0.17 },
    { id: "cinepolis-vip-parque-toreo-cdmx", label: "Parque Toreo VIP", distanceKm: 0.17, vip: true },
    { id: "cinepolis-plaza-carso-cdmx", label: "Plaza Carso", distanceKm: 2.17 },
    { id: "cinepolis-vip-plaza-carso-cdmx", label: "Plaza Carso VIP", distanceKm: 2.17, vip: true },
    { id: "cinepolis-vip-miyana-polanco-cdmx", label: "Miyana Polanco VIP", distanceKm: 2.51, vip: true },
    { id: "cinepolis-satelite-cdmx", label: "Satélite", distanceKm: 6.45 },
    { id: "cinepolis-vip-plaza-satelite-cdmx", label: "Plaza Satélite VIP", distanceKm: 6.47, vip: true },
  ],
});

export function loadProfile(path: string | undefined = process.env.CINES_PROFILE): Profile {
  if (!path) return DEFAULT_PROFILE;
  return ProfileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}
