import { z } from "zod/v4";

export const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a date in YYYY-MM-DD format.")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
  }, "Expected a real calendar date.");

export const IsoDateTimeSchema = z.iso.datetime({ offset: true });

export const TripRevisionSchema = z.object({
  providerVersion: z.string().optional(),
  contentHash: z.string().min(16),
  readAt: IsoDateTimeSchema,
});

export const DestinationSchema = z.object({
  providerLocationKey: z.string().min(1),
  name: z.string().min(1).max(120),
});

export const PlaceRefSchema = z.object({
  providerPlaceId: z.string().min(1),
  name: z.string().min(1).max(200),
  latitude: z.number().finite().optional(),
  longitude: z.number().finite().optional(),
  coverMediaId: z.string().min(1).optional(),
});

export const TripItemSchema = z.object({
  id: z.string().optional(),
  place: PlaceRefSchema,
  startsAt: IsoDateTimeSchema.optional(),
  durationMinutes: z.number().int().min(0).max(1_440).optional(),
  note: z.string().max(2_000).optional(),
  categoryId: z.string().min(1).optional(),
});

export const TripDaySchema = z.object({
  date: IsoDateSchema,
  items: z.array(TripItemSchema).max(80),
});

export const TrafficTypeSchema = z.enum([
  "Walking",
  "Driving",
  "Transit",
  "TwoWheeler",
  "Custom",
]);

export const TripDraftSchema = z
  .object({
    title: z.string().trim().min(1).max(100),
    startDate: IsoDateSchema,
    endDate: IsoDateSchema,
    timezone: z.string().default("Asia/Taipei"),
    destinations: z.array(DestinationSchema).min(1).max(20),
    trafficType: TrafficTypeSchema.default("Custom"),
    days: z.array(TripDaySchema).min(1).max(60),
  })
  .superRefine((draft, context) => {
    const start = Date.parse(`${draft.startDate}T00:00:00Z`);
    const end = Date.parse(`${draft.endDate}T00:00:00Z`);
    if (end < start) {
      context.addIssue({
        code: "custom",
        path: ["endDate"],
        message: "endDate must not be earlier than startDate.",
      });
    }
    const expectedDays = Math.floor((end - start) / 86_400_000) + 1;
    if (expectedDays > 60) {
      context.addIssue({
        code: "custom",
        path: ["endDate"],
        message: "chicTrip itineraries are limited to 60 days.",
      });
    }
    const uniqueDates = new Set(draft.days.map((day) => day.date));
    if (uniqueDates.size !== draft.days.length) {
      context.addIssue({
        code: "custom",
        path: ["days"],
        message: "Each itinerary day must have a unique date.",
      });
    }
    if (Number.isFinite(expectedDays) && expectedDays > 0) {
      if (draft.days.length !== expectedDays) {
        context.addIssue({
          code: "custom",
          path: ["days"],
          message: `days must contain exactly one entry for each trip date (${expectedDays} total).`,
        });
      }
      for (let offset = 0; offset < expectedDays; offset += 1) {
        const date = new Date(start + offset * 86_400_000).toISOString().slice(0, 10);
        if (!uniqueDates.has(date)) {
          context.addIssue({
            code: "custom",
            path: ["days"],
            message: `Missing itinerary day: ${date}`,
          });
        }
        if (draft.days[offset]?.date !== date) {
          context.addIssue({
            code: "custom",
            path: ["days", offset, "date"],
            message: `Itinerary days must be ordered chronologically; expected ${date}.`,
          });
        }
      }
    }
    for (const [index, day] of draft.days.entries()) {
      if (day.date < draft.startDate || day.date > draft.endDate) {
        context.addIssue({
          code: "custom",
          path: ["days", index, "date"],
          message: "Itinerary day is outside the trip date range.",
        });
      }
    }
  });

export const TripSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  startDate: IsoDateSchema,
  endDate: IsoDateSchema,
  ownership: z.enum(["owned", "collaborating"]),
  permission: z.enum(["owner", "editor", "viewer", "unknown"]),
  destinationNames: z.array(z.string()),
  providerVersion: z.string().optional(),
});

export const TripRecordSchema = TripDraftSchema.extend({
  id: z.string(),
  ownership: z.enum(["owned", "collaborating"]),
  permission: z.enum(["owner", "editor", "viewer", "unknown"]),
  revision: TripRevisionSchema,
});

const SetTripFieldsOperationSchema = z.object({
  op: z.literal("set_trip_fields"),
  fields: z
    .object({
      title: z.string().trim().min(1).max(100).optional(),
      startDate: IsoDateSchema.optional(),
      endDate: IsoDateSchema.optional(),
      destinations: z.array(DestinationSchema).min(1).max(20).optional(),
      trafficType: TrafficTypeSchema.optional(),
    })
    .refine((fields) => Object.keys(fields).length > 0, "At least one field is required."),
});

const AddItemOperationSchema = z.object({
  op: z.literal("add_item"),
  date: IsoDateSchema,
  item: TripItemSchema.omit({ id: true }),
  afterItemId: z.string().optional(),
});

const UpdateItemOperationSchema = z.object({
  op: z.literal("update_item"),
  itemId: z.string().min(1),
  fields: z
    .object({
      name: z.string().min(1).max(200).optional(),
      startsAt: IsoDateTimeSchema.nullable().optional(),
      durationMinutes: z.number().int().min(0).max(1_440).optional(),
      note: z.string().max(2_000).nullable().optional(),
      categoryId: z.string().min(1).nullable().optional(),
    })
    .refine((fields) => Object.keys(fields).length > 0, "At least one field is required."),
});

const MoveItemOperationSchema = z.object({
  op: z.literal("move_item"),
  itemId: z.string().min(1),
  toDate: IsoDateSchema,
  afterItemId: z.string().optional(),
});

const RemoveItemOperationSchema = z.object({
  op: z.literal("remove_item"),
  itemId: z.string().min(1),
});

export const TripPatchOperationSchema = z.discriminatedUnion("op", [
  SetTripFieldsOperationSchema,
  AddItemOperationSchema,
  UpdateItemOperationSchema,
  MoveItemOperationSchema,
  RemoveItemOperationSchema,
]);

export const CreateTripChangeIntentSchema = z.object({
  kind: z.literal("create"),
  desired: TripDraftSchema,
});

export const UpdateTripChangeIntentSchema = z.object({
  kind: z.literal("update"),
  tripId: z.string().min(1),
  baseRevision: TripRevisionSchema,
  operations: z.array(TripPatchOperationSchema).min(1).max(200),
});

export const TripChangeIntentSchema = z.discriminatedUnion("kind", [
  CreateTripChangeIntentSchema,
  UpdateTripChangeIntentSchema,
]);

export const ApplyTripChangeInputSchema = z.object({
  previewId: z.uuid(),
  intentHash: z.string().min(16),
  idempotencyKey: z.uuid(),
});

export const ListTripsInputSchema = z.object({
  scope: z.enum(["all", "owned", "collaborating"]).default("all"),
  limit: z.number().int().min(1).max(100).default(50),
});

export const SearchPlacesInputSchema = z.object({
  query: z.string().trim().min(1).max(200),
  centerLatitude: z.number().finite().min(-90).max(90).optional(),
  centerLongitude: z.number().finite().min(-180).max(180).optional(),
  limit: z.number().int().min(1).max(30).default(10),
});

export const SearchDestinationsInputSchema = z.object({
  query: z.string().trim().min(1).max(100),
  limit: z.number().int().min(1).max(30).default(10),
});

export type TripRevision = z.infer<typeof TripRevisionSchema>;
export type Destination = z.infer<typeof DestinationSchema>;
export type PlaceRef = z.infer<typeof PlaceRefSchema>;
export type TripItem = z.infer<typeof TripItemSchema>;
export type TripDay = z.infer<typeof TripDaySchema>;
export type TripDraft = z.infer<typeof TripDraftSchema>;
export type TripSummary = z.infer<typeof TripSummarySchema>;
export type TripRecord = z.infer<typeof TripRecordSchema>;
export type TripPatchOperation = z.infer<typeof TripPatchOperationSchema>;
export type TripChangeIntent = z.infer<typeof TripChangeIntentSchema>;
export type ApplyTripChangeInput = z.infer<typeof ApplyTripChangeInputSchema>;
export type ListTripsInput = z.infer<typeof ListTripsInputSchema>;
export type SearchPlacesInput = z.infer<typeof SearchPlacesInputSchema>;
export type SearchDestinationsInput = z.infer<typeof SearchDestinationsInputSchema>;
