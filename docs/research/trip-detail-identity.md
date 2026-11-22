# Fail closed when a requested trip is missing from a detail array

Base: 61395b8712573e3face4c0f96c0b1f01c607fb47.

extractTripRoot searches an array for the requested trip ID. A matching record
may carry that ID on `travelScheduleInfo.id` / `travelScheduleInfo.Id`, or, when
the nested ID is absent, on the record's own `id` / `Id`. The previous
implementation fell back to the first record even when the requested ID was
absent, so getTrip(A) could return trip B's content. Matching only the nested
ID then rejected a top-level `id` / `Id` with NOT_FOUND, which the base branch
accepted. The existing getTrip check only rejected a falsy ID, not a different
nonempty ID. Empty/idless arrays also fell through into normalization and
surfaced unrelated schema errors.

When an explicit trip ID is supplied and no array record matches either shape,
throw the existing NOT_FOUND AppError. Do not substitute another trip. Preserve
matching records for both ID shapes, direct object responses, and callers that
do not supply an ID. Direct-object identity hardening is outside this patch.

Three transport regressions (different trip, empty result, missing identity)
failed on the unchanged base. A mixed-array matching control passed. Nested
`travelScheduleInfo.id` / `Id` and top-level `id` / `Id` each select the
requested record, including when an unrelated record precedes it. A top-level
ID that is not the requested trip still throws NOT_FOUND. No-ID and
direct-object compatibility controls still pass. Provider responses are
synthetic and only GET operations are exercised; no live trip or account is
accessed or mutated.

The read-only validate workflow matches the one proposed in PR #5; it performs
typecheck, offline tests, build and CLI/symlink smoke checks, without deployment.

This is a source-only fix. Bun 1.4.4 rebuilds the checked-in MCP bundles with
large unrelated bundler differences, so those artifacts are not changed. Run
bun install --frozen-lockfile and bun run validate as required in README before
using the fix. Existing unrebuilt MCP bundles do not contain this correction.
