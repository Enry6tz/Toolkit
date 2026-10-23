import type { AgentContextV2 } from "../../src/review/controller";
import type { ReviewEvent } from "../../src/review/types";

/** Explicit transformation fixture. This is never posted as a recording or claimed as UI evidence. */
export function context(events: ReviewEvent[]): AgentContextV2 {
  const at = "2026-10-20T17:00:00.000Z";
  const capability = {
    status: "unavailable" as const,
    provider: "atomic-fixture",
  };
  return {
    schemaVersion: "2.0",
    status: "ok",
    revision: 1,
    preparedAt: at,
    context: {
      schemaVersion: "1.0",
      capturedAt: at,
      page: {
        url: "https://fixture.invalid/test",
        pathname: "/test",
        title: "Atomic transform fixture",
        viewport: { width: 1000, height: 700 },
      },
      build: { environment: "development", buildId: "atomic-only" },
      target: null,
      rules: [],
      privacy: { redactions: [] },
      annotations: [],
    },
    capabilities: {
      contextRead: capability,
      siteTools: capability,
      sessionSignals: capability,
      interactionRecording: capability,
      captureViewport: capability,
      captureFullPage: capability,
      captureRegion: capability,
      artifactRead: capability,
      bundleExport: capability,
      domainContext: capability,
      designContext: capability,
    },
    review: {
      schemaVersion: "2.0",
      revision: 1,
      session: {
        id: "atomic-fixture",
        objective: "Atomic transformation fixture; no browser execution",
        scope: { origin: "https://fixture.invalid", pathname: "/test" },
        actor: "unknown",
        attribution: "declared",
        status: "ended",
        recording: "stopped",
        networkRecording: true,
        startedAt: at,
        lastActivityAt: at,
        endedAt: at,
        revision: 1,
      },
      steps: [
        {
          id: "step-fixture",
          sessionId: "atomic-fixture",
          label: "Atomic fixture request",
          at,
          pathname: "/test",
          actor: "unknown",
          attribution: "declared",
          simulated: true,
          artifactIds: [],
          notes: "Not a locally executed UI test",
        },
      ],
      events,
      findings: [],
      artifacts: [],
      privacy: { reviewedRevision: null },
      partial: { isPartial: false, reasons: [], droppedEvents: 0 },
      limits: { maxEvents: 50, maxImages: 0, maxBytes: 128000 },
      bytesStored: 0,
    },
    domain: null,
    design: { declared: null, observed: null },
    instructions: "Atomic transformation only",
  };
}
export function event(
  responseBody: ReviewEvent["responseBody"],
  requestBody?: ReviewEvent["requestBody"],
): ReviewEvent {
  return {
    id: "event-fixture",
    sessionId: "atomic-fixture",
    stepId: "step-fixture",
    at: "2026-10-20T17:00:00.000Z",
    kind: "fetch",
    actor: "unknown",
    attribution: "declared",
    simulated: true,
    resource: "Controlled service fixture",
    method: "POST",
    status: 503,
    outcome: "http_error",
    durationMs: 1,
    requestBody,
    responseBody,
  };
}


