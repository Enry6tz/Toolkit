import { describe, expect, it, vi } from "vitest";
import { createActivityRecorder } from "../../src/browser/activity";
import type { ActivityConfig, ActivityFetchEntry } from "../../src/core/activity";
import { flightErrorDiagnostic, routineFrameworkQuery } from "../../src/review/recording-view";
import { recordingJson, recordingMarkdown } from "../../src/review/recording";
import { context, event } from "./recording-network-policy-fixtures";

/** Controlled fetch/DOM boundary in Node, never uploaded or presented as executed browser evidence. */
function harness(config: Partial<ActivityConfig> = {}) {
  const responses: Response[] = [];
  const original: typeof fetch = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("Missing controlled response");
    return next;
  });
  const view = {
    fetch: original, document: new EventTarget(), performance, URL, Request,
    location: new URL("https://fixture.invalid/test"),
  } as unknown as Window;
  const recorder = createActivityRecorder({ window: view, config: { resources: [{ path: "/test", name: "Controlled service" }], ...config } });
  function entries() { return recorder.getEntries().filter((item): item is ActivityFetchEntry => item.kind === "fetch"); }
  async function request(text: string, type = "text/x-component", status = 200) {
    const response = new Response(text, { status, headers: { "content-type": type } });
    responses.push(response);
    const seen = entries().length;
    const returned = await view.fetch("https://fixture.invalid/test");
    expect(returned).toBe(response);
    await vi.waitFor(() => expect(entries()[seen]?.responseBody).toBeDefined());
    return entries()[seen]!;
  }
  return { view, responses, recorder, entries, request };
}

describe("26 controlled recorder budget policy", () => {
  it("caps successful RSC at 1024 and 25% while preserving a later API response and every event", async () => {
    const h = harness({ maxBodyChars: 8000, maxNetworkChars: 8000 });
    h.recorder.start();
    try {
      const rsc = [];
      for (let i = 0; i < 5; i++) rsc.push(await h.request("x".repeat(3000)));
      expect(rsc[0]?.responseBody).toMatchObject({ status: "truncated", charLimit: 1024, reason: "framework_limit" });
      expect(rsc[1]?.responseBody).toMatchObject({ status: "truncated", charLimit: 976, reason: "framework_limit" });
      expect(rsc.slice(2).every(item => item.responseBody?.status === "omitted" && item.responseBody.reason === "framework_limit")).toBe(true);
      const api = await h.request(JSON.stringify({ content: "a".repeat(3990) }), "application/json");
      expect(api.responseBody?.status).toBe("captured");
      expect(api.responseBody?.text?.length).toBeGreaterThan(3990);
      expect(h.entries()).toHaveLength(6);
      expect(rsc.reduce((sum, item) => sum + (item.responseBody?.text?.length ?? 0), 0)).toBe(2000);
      expect(h.recorder.getSummary().bodyChars).toBeLessThanOrEqual(8000);
    } finally { h.recorder.dispose(); }
  });

  it("enforces the shared cap when RSC clones finish concurrently and leaves application responses readable", async () => {
    const h = harness({ maxNetworkChars: 8000 });
    h.recorder.start();
    try {
      for (let i = 0; i < 8; i++) h.responses.push(new Response("x".repeat(3000), { headers: { "content-type": "text/x-component" } }));
      const returned = await Promise.all(Array.from({ length: 8 }, () => h.view.fetch("https://fixture.invalid/test")));
      await vi.waitFor(() => expect(h.entries().filter(item => item.responseBody)).toHaveLength(8));
      expect(h.entries().reduce((sum, item) => sum + (item.responseBody?.text?.length ?? 0), 0)).toBe(2000);
      expect(await returned[0]!.text()).toHaveLength(3000);
    } finally { h.recorder.dispose(); }
  });

  it("keeps HTTP500 RSC under the normal body policy and retains its HTTP result", async () => {
    const h = harness({ maxBodyChars: 5000, maxNetworkChars: 8000 });
    h.recorder.start();
    try {
      await h.request("x".repeat(3000));
      await h.request("x".repeat(3000));
      const failed = await h.request("failure ".repeat(350), "text/x-component", 500);
      expect(failed).toMatchObject({ status: 500, outcome: "http_error", resource: "Controlled service" });
      expect(failed.responseBody).toMatchObject({ status: "captured", charLimit: 5000 });
      expect(failed.responseBody?.text).toHaveLength(2800);
    } finally { h.recorder.dispose(); }
  });

  it("honors smaller body and global limits, including a zero-character RSC share", async () => {
    const h = harness({ maxBodyChars: 100, maxNetworkChars: 3 });
    h.recorder.start();
    try {
      expect((await h.request("large")).responseBody).toMatchObject({ status: "omitted", reason: "framework_limit" });
      expect((await h.request("abcdef", "text/plain")).responseBody).toMatchObject({ status: "truncated", charLimit: 3, reason: "network_limit", text: "abc" });
      expect(h.recorder.getSummary().bodyChars).toBe(3);
    } finally { h.recorder.dispose(); }
  });

  it("does not refund the RSC allowance on stop/start or restoration of persisted usage", async () => {
    const h = harness({ maxNetworkChars: 4000 });
    h.recorder.start();
    try {
      await h.request("x".repeat(2000));
      h.recorder.stop(); h.recorder.start();
      expect((await h.request("second")).responseBody?.reason).toBe("framework_limit");
      h.recorder.stop();
      h.recorder.seedBodyBudget(0, 0); h.recorder.start();
      expect((await h.request("no refund")).responseBody?.reason).toBe("framework_limit");
      expect(h.recorder.getSummary().bodyChars).toBe(1000);
      h.recorder.stop();
      h.recorder.seedBodyBudget(1500, 1000);
      h.recorder.start();
      expect((await h.request("restored")).responseBody?.reason).toBe("framework_limit");
      expect((await h.request("API still available", "text/plain")).responseBody?.status).toBe("captured");
      h.recorder.clear();
      expect((await h.request("new recording")).responseBody?.status).toBe("captured");
    } finally { h.recorder.dispose(); }
  });

  it("seeds API-only usage without spending the RSC share and keeps credential redaction", async () => {
    const h = harness({ maxNetworkChars: 4000 });
    h.recorder.seedBodyBudget(1000, 0); h.recorder.start();
    try {
      const raw = '0:{"serverKey":"private-fixture","publicKey":"public-fixture"}\n';
      const body = (await h.request(raw)).responseBody;
      expect(body?.status).toBe("captured");
      expect(body?.text?.includes("private-fixture")).toBe(false);
      expect(body?.text).toContain("public-fixture");
    } finally { h.recorder.dispose(); }
  });
});

describe("26 Flight diagnostic and recording exports", () => {
  function flight(text: string) { return { ...event({ status: "captured", charLimit: 8000, contentType: "text/x-component", text }), status: 200, outcome: "success" as const, simulated: false }; }

  it("recognizes an actual complete E row without inventing an HTTP error or compacting it", () => {
    // React's production Flight emitter writes hexID:E + JSON({digest}) + newline.
    const diagnostic = flight('0:["$","div",null,{}]\na:E{"digest":"controlled-diagnostic"}\n');
    expect(flightErrorDiagnostic(diagnostic)).toBe(true);
    expect(routineFrameworkQuery(diagnostic)).toBe(false);
    const input = context([diagnostic]);
    const markdown = recordingMarkdown(input, { compact: true, locale: "es" });
    expect(markdown).toContain("diagnóstico de error Flight en la vista previa");
    expect(markdown).toContain("HTTP 200");
    expect(markdown).not.toContain("HTTP 500");
    expect(JSON.parse(recordingJson(input)).events[0]).toMatchObject({ status: 200, outcome: "success" });
  });

  it("ignores quoted payloads, incomplete diagnostics and raw text chunks containing similar lines", () => {
    const raw = 'Texto legítimo é\na:E{"digest":"only-user-text"}\n';
    const textFrame = `0:T${new TextEncoder().encode(raw).length.toString(16)},${raw}1:["normal"]\n`;
    for (const text of [textFrame, '0:{"message":"a:E{\\\"digest\\\":\\\"user text\\\"}"}\n', 'a:E{"message":"ordinary data"}\n', 'a:E{"digest":"unfinished"']) {
      expect(flightErrorDiagnostic(flight(text))).toBe(false);
    }
    expect(flightErrorDiagnostic(flight(textFrame + '2:E{"digest":"actual-after-text"}\n'))).toBe(true);
  });

  for (const locale of ["es", "en"] as const) it(`${locale} reports the same body counts and reasons as JSON with source context intact`, () => {
    const input = context([
      event({ status: "truncated", text: "short", charLimit: 5, contentType: "text/x-component", reason: "framework_limit" }),
      event({ status: "omitted", charLimit: 1024, contentType: "text/x-component", reason: "framework_limit" }),
      event({ status: "captured", text: '{"ok":true}', charLimit: 8000, contentType: "application/json" }),
    ]);
    input.review.events.forEach((value, index) => { value.id = `event-${index}`; });
    const before = structuredClone(input);
    for (const compact of [false, true]) {
      const markdown = recordingMarkdown(input, { locale, compact });
      expect(markdown).toContain(locale === "es" ? "1 capturados, 1 recortados y 1 omitidos" : "1 captured, 1 truncated and 1 omitted");
      expect(markdown).toContain(locale === "es" ? "no garantizan cuerpos completos" : "do not guarantee complete bodies");
      if (!compact) expect(markdown).toContain(locale === "es" ? "límite de vistas previas RSC alcanzado" : "RSC preview limit reached");
    }
    const json = JSON.parse(recordingJson(input));
    expect(json.events.map((value: { responseBody: { status: string } }) => value.responseBody.status)).toEqual(["truncated", "omitted", "captured"]);
    expect(json.events[0].responseBody.reason).toBe("framework_limit");
    expect(json.steps[0].pathname).toBe("/test");
    expect(input).toEqual(before);
  });
});
