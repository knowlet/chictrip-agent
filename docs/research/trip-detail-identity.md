# Fail closed when a requested trip is missing from a detail array

Base: 61395b8712573e3face4c0f96c0b1f01c607fb47.

extractTripRoot searches an array for the requested travelScheduleInfo ID, but
previously fell back to the first record even when the requested ID was absent.
Consequently getTrip(A) could return trip B's content. The existing getTrip check
only rejected a falsy ID, not a different nonempty ID. Empty/idless arrays also
fell through into normalization and surfaced unrelated schema errors.

When an explicit trip ID is supplied and no array record matches, throw the
existing NOT_FOUND AppError. Do not substitute another trip. Preserve the
existing behavior for a matching record, direct object responses, and callers
that do not supply an ID. Direct-object identity hardening is outside this patch.

Three transport regressions (different trip, empty result, missing identity)
failed on the unchanged base. A mixed-array matching control passed. After the
fix all pass, along with no-ID and direct-object compatibility controls. Provider
responses are synthetic and only GET operations are exercised; no live trip or
account is accessed or mutated.

The read-only validate workflow matches the one proposed in PR #5; it performs
typecheck, offline tests, build and CLI/symlink smoke checks, without deployment.

This is a source-only fix. Bun 1.4.4 rebuilds the checked-in MCP bundles with
large unrelated bundler differences, so those artifacts are not changed. Run
bun install --frozen-lockfile and bun run validate as required in README before
using the fix. Existing unrebuilt MCP bundles do not contain this correction.
