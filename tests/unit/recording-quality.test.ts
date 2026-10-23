import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { recordingQuality, recordingQualityText } from "../../src/review/recording-quality";
import { recordingResource, routineFrameworkQuery } from "../../src/review/recording-view";
import { recordingJson, recordingMarkdown } from "../../src/review/recording";
import { RecordingQualityNotice } from "../../src/react/recording-quality";
import { createTranslator } from "../../src/core/locale";
import { context, event } from "./recording-network-policy-fixtures";

const empty = { status: "omitted" as const, reason: "empty" as const, charLimit: 8000 };
const captured = { status: "captured" as const, text: "{}", contentType: "application/json", charLimit: 8000 };
const truncated = { status: "truncated" as const, text: "{", contentType: "application/json", charLimit: 1, reason: "network_limit" as const };

describe("72 derived recording coverage (atomic fixtures, no UI run)", () => {
  it("counts HTTP once while classifying each request and response body separately", () => {
    const source = context([event(truncated, truncated), event(captured, empty)]).review;
    const quality = recordingQuality(source)!;
    expect(quality).toMatchObject({ requests: 2, affectedRequests: 1, networkCoverage: "limited", eventCoverage: "no-reported-loss", reasons: { network_limit: 2 } });
    expect(quality.requestBodies).toEqual({ captured: 0, truncated: 1, omitted: 0, empty: 1, unclassified: 0 });
    expect(quality.responseBodies).toEqual({ captured: 1, truncated: 1, omitted: 0, empty: 0, unclassified: 0 });
    expect(source.partial.isPartial).toBe(false);
  });
  it("does not label an empty request as lost network detail or saturate a normal review", () => {
    const source = context([event(captured, empty)]).review;
    const quality = recordingQuality(source)!;
    expect(quality).toMatchObject({ affectedRequests: 0, networkCoverage: "recorded" });
    expect(recordingQualityText(quality).limited).toBe(false);
    expect(renderToStaticMarkup(createElement(RecordingQualityNotice, { source, locale: "en" }))).toBe("");
  });
  it("treats old missing body classifications and missing partial metadata as unknown", () => {
    const quality = recordingQuality({ events: [{ kind: "fetch", method: "GET", status: 200 }] })!;
    expect(quality).toMatchObject({ requests: 1, affectedRequests: 0, networkCoverage: "unclassified", eventCoverage: "unknown" });
    expect(quality.requestBodies.unclassified).toBe(1);
    expect(quality.responseBodies.unclassified).toBe(1);
    expect(recordingQualityText(quality).label).toContain("not verifiable");
  });
  it("reports known omission reasons without inventing the cause of an unidentified read error", () => {
    const reasons = ["disabled", "binary", "stream", "unavailable", "read_error", "recording_stopped", "network_limit", "framework_limit"] as const;
    const source = { events: reasons.map(reason => ({ kind: "fetch", responseBody: { status: "omitted", reason } })), partial: { isPartial: false, droppedEvents: 0 } };
    const quality = recordingQuality(source)!;
    expect(quality.requests).toBe(8);
    expect(quality.affectedRequests).toBe(8);
    expect(quality.reasons).toEqual(Object.fromEntries(reasons.map(reason => [reason, 1])));
    expect(recordingQualityText(quality).detail).not.toMatch(/https?:|endpoint|business|caused|private/);
  });
  it("keeps partial event coverage separate and never changes the stored historical flag", () => {
    for (const partial of [{ isPartial: true, droppedEvents: 0 }, { isPartial: false, droppedEvents: 2 }]) {
      const source = { events: [], partial };
      const before = structuredClone(source);
      expect(recordingQuality(source)?.eventCoverage).toBe("partial");
      if (partial.droppedEvents) expect(recordingQualityText(recordingQuality(source)!).detail).toContain("Dropped events: 2");
      expect(source).toEqual(before);
    }
    expect(recordingQuality({ events: [] })?.eventCoverage).toBe("unknown");
    expect(recordingQuality({ events: "malformed" })).toBeNull();
  });
  it.each(["es", "en"] as const)("UI and Markdown in %s use the same derived counters, leaving original JSON intact", locale => {
    const source = context([event(truncated, empty), event({ status: "omitted", reason: "read_error", charLimit: 8000 }, empty)]);
    const before = structuredClone(source);
    const jsonBefore = recordingJson(source);
    const quality = recordingQuality(source.review)!;
    const text = recordingQualityText(quality, locale);
    const html = renderToStaticMarkup(createElement(RecordingQualityNotice, { source: source.review, locale }));
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(text.label);
    for (const compact of [false, true]) {
      const markdown = recordingMarkdown(source, { locale, compact });
      expect(markdown).toContain(text.label);
      expect(markdown).toContain(text.detail);
      expect(markdown).toContain(locale === "es" ? "2 solicitudes; 2 con detalles" : "2 requests; 2 with truncated");
    }
    expect(recordingJson(source)).toBe(jsonBefore);
    expect(source).toEqual(before);
    expect(JSON.parse(jsonBefore).schemaVersion).toBe("1.1");
    expect(JSON.parse(jsonBefore).partial.isPartial).toBe(false);
    expect(JSON.parse(jsonBefore)).not.toHaveProperty("quality");
  });
  it("uses MIME evidence for the framework label, retaining concrete resource aliases and HTTP errors", () => {
    const framework = { ...event({ ...captured, contentType: "text/x-component" }), resource: "Recurso no identificado" };
    expect(recordingResource(framework, createTranslator("en"))).toBe("Framework navigation");
    expect(recordingResource({ ...framework, resource: "Performance content" }, createTranslator("en"))).toBe("Performance content");
    expect(recordingResource({ resource: "Recurso no identificado" }, createTranslator("en"))).toBe("Unknown resource");
    expect(routineFrameworkQuery(framework)).toBe(false); // HTTP503 is never folded.
    expect(recordingQuality(context([framework]).review)?.frameworkRequests).toBe(1);
    expect(recordingMarkdown(context([framework]), { compact: true, locale: "en" })).toContain("Framework navigation → HTTP 503");
  });
  it("never renders untrusted body text, resource names or arbitrary omission reasons in the coverage notice", () => {
    const source = { events: [{ kind: "fetch", resource: "private-fixture-name", responseBody: { status: "omitted", text: "asp_session_fixture_secret", reason: "private-fixture-reason" } }], partial: { isPartial: false, droppedEvents: 0 } };
    const quality = recordingQuality(source)!;
    const notice = renderToStaticMarkup(createElement(RecordingQualityNotice, { source, locale: "en" }));
    expect(quality.reasons).toEqual({});
    expect(notice).not.toMatch(/private-fixture|asp_session_/);
  });
});
