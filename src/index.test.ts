import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  buildOtlpPayload,
  buildTracePayload,
  jobBounds,
  buildJobDurationPayload,
  JOB_DURATION_METRIC,
  ciResourceAttributes,
  spanStatus,
  allSteps,
  selectJob,
  postOtlp,
  OTLP_METRICS,
  parseDefaultRouteIface,
  parseNetBytes,
  parseDiskSectors,
} from "./index.js";

type GhStep = {
  name: string;
  number?: number;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
};
type GhJob = {
  id?: number;
  name?: string;
  conclusion?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  steps?: GhStep[];
  runner_name?: string;
  run_attempt?: number | string | null;
  status?: string;
};
type IdGen = (bytes: number) => string;

// [elapsed_s, mem, cpu, iowait, disk, rx, tx]
const ROWS = [
  [0, 1024, 12.5, 1.0, 5.0, 2.0, 0.5],
  [1, 1100, 80.0, 3.0, 50.0, 10.0, 4.0],
];
const ORIGIN_MS = 1_700_000_000_000;
const ENV = {
  GITHUB_REPOSITORY: "octocat/hello-world",
  GITHUB_WORKFLOW: "validate",
  GITHUB_JOB: "test",
  GITHUB_RUN_ID: "42",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_RUN_NUMBER: "317",
  GITHUB_REF_NAME: "main",
  GITHUB_EVENT_NAME: "push",
  GITHUB_SHA: "abc123def456",
  GITHUB_ACTOR: "octocat",
  GITHUB_TRIGGERING_ACTOR: "octocat",
  RUNNER_OS: "Linux",
  RUNNER_NAME: "gh-runner-7",
};

test("payload has one resource with one scope", () => {
  const p = buildOtlpPayload(ROWS, ORIGIN_MS, ENV);
  assert.equal(p.resourceMetrics.length, 1);
  assert.equal(p.resourceMetrics[0].scopeMetrics.length, 1);
  assert.equal(p.resourceMetrics[0].scopeMetrics[0].scope.name, "resource-sampler");
});

test("one gauge metric per column, with correct names and units", () => {
  const metrics = buildOtlpPayload(ROWS, ORIGIN_MS, ENV).resourceMetrics[0].scopeMetrics[0].metrics;
  assert.equal(metrics.length, OTLP_METRICS.length);
  assert.deepEqual(
    metrics.map((m) => m.name),
    [
      "ci.runner.mem.used",
      "ci.runner.cpu.utilization",
      "ci.runner.iowait",
      "ci.runner.disk.throughput",
      "ci.runner.net.rx",
      "ci.runner.net.tx",
    ],
  );
  assert.deepEqual(
    metrics.map((m) => m.unit),
    ["By", "%", "%", "By/s", "By/s", "By/s"],
  );
  for (const m of metrics) assert.ok(m.gauge, `${m.name} should be a gauge`);
});

test("each metric has one data point per row, in order", () => {
  const metrics = buildOtlpPayload(ROWS, ORIGIN_MS, ENV).resourceMetrics[0].scopeMetrics[0].metrics;
  for (const m of metrics) assert.equal(m.gauge.dataPoints.length, ROWS.length);
});

test("data point values map to the right column", () => {
  const metrics = buildOtlpPayload(ROWS, ORIGIN_MS, ENV).resourceMetrics[0].scopeMetrics[0].metrics;
  const cpu = metrics[1];
  assert.equal(cpu.name, "ci.runner.cpu.utilization");
  assert.deepEqual(
    cpu.gauge.dataPoints.map((d) => d.asDouble),
    [12.5, 80.0],
  );
  const MIB = 1024 * 1024;
  const tx = metrics[5];
  assert.equal(tx.name, "ci.runner.net.tx");
  assert.equal(tx.unit, "By/s");
  assert.deepEqual(
    tx.gauge.dataPoints.map((d) => d.asDouble),
    [0.5 * MIB, 4.0 * MIB],
  );
});

test("timestamps are absolute epoch-nanoseconds from origin + elapsed", () => {
  const metrics = buildOtlpPayload(ROWS, ORIGIN_MS, ENV).resourceMetrics[0].scopeMetrics[0].metrics;
  const pts = metrics[0].gauge.dataPoints;
  assert.equal(pts[0].timeUnixNano, String(ORIGIN_MS * 1e6));
  assert.equal(pts[1].timeUnixNano, String((ORIGIN_MS + 1000) * 1e6));
  assert.equal(typeof pts[0].timeUnixNano, "string");
  assert.equal(pts[0].startTimeUnixNano, pts[0].timeUnixNano);
});

test("resource attributes carry the CI dimensions as stringValues", () => {
  const attrs = ciResourceAttributes(ENV);
  const map = Object.fromEntries(attrs.map((a) => [a.key, a.value.stringValue]));
  assert.equal(map["service.name"], "github-ci-runner");
  assert.equal(map["ci.repo"], "octocat/hello-world");
  assert.equal(map["ci.workflow"], "validate");
  assert.equal(map["ci.job"], "test");
  assert.equal(map["ci.run_id"], "42");
  assert.equal(map["ci.run_attempt"], "1");
  assert.equal(map["ci.branch"], "main");
  assert.equal(map["ci.runner_os"], "Linux");
  assert.equal(map["ci.runner_name"], "gh-runner-7");
  assert.equal(map["ci.run_number"], "317");
  assert.equal(map["ci.event"], "push");
  assert.equal(map["vcs.revision"], "abc123def456");
  assert.equal(map["ci.actor"], "octocat");
  assert.equal(map["ci.triggering_actor"], "octocat");
});

test("ci.pr_number is derived from the merge ref on PR events, omitted otherwise", () => {
  const pr = ciResourceAttributes({
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_REF_NAME: "790/merge",
    GITHUB_HEAD_REF: "feature/x",
  });
  const prMap = Object.fromEntries(pr.map((a) => [a.key, a.value.stringValue]));
  assert.equal(prMap["ci.pr_number"], "790");

  const push = ciResourceAttributes({ GITHUB_EVENT_NAME: "push", GITHUB_REF_NAME: "main" });
  const pushKeys = push.map((a) => a.key);
  assert.ok(!pushKeys.includes("ci.pr_number"), "no PR number on push events");
});

test("CI dimensions ride on each data point, not only the resource", () => {
  const metrics = buildOtlpPayload(ROWS, ORIGIN_MS, ENV).resourceMetrics[0].scopeMetrics[0].metrics;
  for (const m of metrics) {
    for (const pt of m.gauge.dataPoints) {
      assert.ok(Array.isArray(pt.attributes), `${m.name} point has attributes`);
      const map = Object.fromEntries(pt.attributes.map((a) => [a.key, a.value.stringValue]));
      assert.equal(map["ci.workflow"], "validate");
      assert.equal(map["ci.job"], "test");
      assert.equal(map["ci.branch"], "main");
      assert.equal(map["ci.run_id"], "42");
      assert.equal(map["ci.event"], "push");
      assert.equal(map["ci.actor"], "octocat");
    }
  }
});

test("high-cardinality attrs stay off metric datapoints (cardinality guard)", () => {
  const metrics = buildOtlpPayload(ROWS, ORIGIN_MS, ENV).resourceMetrics[0].scopeMetrics[0].metrics;
  for (const m of metrics) {
    for (const pt of m.gauge.dataPoints) {
      const keys = pt.attributes.map((a) => a.key);
      for (const banned of ["vcs.revision", "ci.run_number", "ci.pr_number", "ci.runner_name"]) {
        assert.ok(!keys.includes(banned), `${banned} must not be a metric label`);
      }
      assert.ok(keys.includes("ci.run_id"), "ci.run_id is kept on metrics for the dashboard");
    }
  }
});

test("ci.runner_name is dropped from metrics but kept on the trace resource", () => {
  const traceAttrs = buildTracePayload(JOB, JOB.steps!, ENV, fakeIdGen())!.resourceSpans[0].resource
    .attributes;
  const traceKeys = traceAttrs.map((a) => a.key);
  assert.ok(traceKeys.includes("ci.runner_name"), "runner_name still identifies a trace");
});

test("ci.branch prefers GITHUB_HEAD_REF on PR events (not the merge ref)", () => {
  const pr = ciResourceAttributes({
    GITHUB_REF_NAME: "790/merge",
    GITHUB_HEAD_REF: "feature/my-branch",
  });
  const prMap = Object.fromEntries(pr.map((a) => [a.key, a.value.stringValue]));
  assert.equal(prMap["ci.branch"], "feature/my-branch");

  const push = ciResourceAttributes({ GITHUB_REF_NAME: "main", GITHUB_HEAD_REF: "" });
  const pushMap = Object.fromEntries(push.map((a) => [a.key, a.value.stringValue]));
  assert.equal(pushMap["ci.branch"], "main");
});

test("missing env vars are omitted, not emitted as empty", () => {
  const attrs = ciResourceAttributes({ GITHUB_REPOSITORY: "a/b", GITHUB_JOB: "" });
  const keys = attrs.map((a) => a.key);
  assert.ok(keys.includes("service.name"));
  assert.ok(keys.includes("ci.repo"));
  assert.ok(!keys.includes("ci.job"), "empty-string env var must be omitted");
  assert.ok(!keys.includes("ci.workflow"), "undefined env var must be omitted");
});

test("mem is scaled from MiB to bytes (By)", () => {
  const MIB = 1024 * 1024;
  const metrics = buildOtlpPayload(ROWS, ORIGIN_MS, ENV).resourceMetrics[0].scopeMetrics[0].metrics;
  const mem = metrics[0];
  assert.equal(mem.unit, "By");
  assert.deepEqual(
    mem.gauge.dataPoints.map((d) => d.asDouble),
    [1024 * MIB, 1100 * MIB],
  );
});

test("percentages are NOT scaled (cpu/iowait pass through)", () => {
  const metrics = buildOtlpPayload(ROWS, ORIGIN_MS, ENV).resourceMetrics[0].scopeMetrics[0].metrics;
  assert.deepEqual(
    metrics[1].gauge.dataPoints.map((d) => d.asDouble),
    [12.5, 80.0],
  );
  assert.deepEqual(
    metrics[2].gauge.dataPoints.map((d) => d.asDouble),
    [1.0, 3.0],
  );
});

type CapturedRequest = {
  method?: string;
  path?: string;
  auth?: string;
  ctype?: string;
  body?: string;
};

function startServer(
  onRequest: (
    req: InstanceType<typeof http.IncomingMessage>,
    res: InstanceType<typeof http.ServerResponse>,
  ) => void,
) {
  return http.createServer(onRequest);
}

test("postOtlp POSTs JSON to /v1/metrics with auth header", async () => {
  const captured: CapturedRequest = {};
  const server = startServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      captured.method = req.method;
      captured.path = req.url;
      captured.auth = req.headers["authorization"];
      captured.ctype = req.headers["content-type"];
      captured.body = body;
      res.writeHead(200).end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as import("node:net").AddressInfo;

  let status;
  try {
    const payload = buildOtlpPayload(ROWS, ORIGIN_MS, ENV);
    status = await postOtlp(
      `http://127.0.0.1:${port}`,
      "Basic dGVzdDp0b2tlbg==",
      "metrics",
      payload,
    );
  } finally {
    server.close();
  }

  assert.equal(status, 200);
  assert.equal(captured.method, "POST");
  assert.equal(captured.path, "/v1/metrics");
  assert.equal(captured.auth, "Basic dGVzdDp0b2tlbg==");
  assert.equal(captured.ctype, "application/json");
  assert.deepEqual(JSON.parse(captured.body!), buildOtlpPayload(ROWS, ORIGIN_MS, ENV));
});

test("postOtlp resolves null on a bad endpoint, never throws", async () => {
  const status = await postOtlp("not a url", "Basic x", "metrics", { resourceMetrics: [] });
  assert.equal(status, null);
});

test("postOtlp preserves a base path on the endpoint (/otlp -> /otlp/v1/metrics)", async () => {
  let seenPath: string | undefined;
  const server = startServer((req, res) => {
    seenPath = req.url;
    req.resume();
    res.writeHead(200).end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as import("node:net").AddressInfo;
  try {
    await postOtlp(`http://127.0.0.1:${port}/otlp`, "Basic x", "metrics", { resourceMetrics: [] });
  } finally {
    server.close();
  }
  assert.equal(seenPath, "/otlp/v1/metrics");
});

test("postOtlp routes the traces signal to /v1/traces", async () => {
  let seenPath: string | undefined;
  const server = startServer((req, res) => {
    seenPath = req.url;
    req.resume();
    res.writeHead(200).end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as import("node:net").AddressInfo;
  try {
    await postOtlp(`http://127.0.0.1:${port}/otlp`, "Basic x", "traces", { resourceSpans: [] });
  } finally {
    server.close();
  }
  assert.equal(seenPath, "/otlp/v1/traces");
});

// conclusion: null + status: in_progress mirrors the real Actions API shape
// while the job is still running at post time.
const JOB: GhJob = {
  id: 999,
  name: "test",
  status: "in_progress",
  conclusion: null,
  started_at: "2025-01-01T00:00:00Z",
  completed_at: null,
  steps: [
    {
      name: "Set up job",
      number: 1,
      conclusion: "success",
      started_at: "2025-01-01T00:00:00Z",
      completed_at: "2025-01-01T00:00:02Z",
    },
    {
      name: "Sample resource usage",
      number: 2,
      conclusion: "success",
      started_at: "2025-01-01T00:00:02Z",
      completed_at: "2025-01-01T00:00:03Z",
    },
    {
      name: "go test",
      number: 3,
      conclusion: "failure",
      started_at: "2025-01-01T00:00:03Z",
      completed_at: "2025-01-01T00:00:30Z",
    },
    {
      name: "Skipped step",
      number: 4,
      conclusion: "skipped",
      started_at: null,
      completed_at: null,
    },
    {
      name: "Post Sample resource usage",
      number: 5,
      conclusion: "success",
      started_at: "2025-01-01T00:00:30Z",
      completed_at: "2025-01-01T00:00:31Z",
    },
  ],
};
function fakeIdGen(): IdGen {
  let n = 0;
  return (bytes: number) => String(n++).padStart(bytes * 2, "0");
}

test("trace has one resourceSpans/scopeSpans with a root + child spans", () => {
  const p = buildTracePayload(JOB, JOB.steps!, ENV, fakeIdGen())!;
  assert.equal(p.resourceSpans.length, 1);
  const spans = p.resourceSpans[0].scopeSpans[0].spans;
  assert.equal(spans.length, 5);
});

test("all steps are included — setup and Post-* are NOT filtered out", () => {
  const spans = buildTracePayload(JOB, JOB.steps!, ENV, fakeIdGen())!.resourceSpans[0].scopeSpans[0]
    .spans;
  const names = spans.map((s) => s.name);
  assert.ok(names.includes("Set up job"), "setup step must be present");
  assert.ok(names.includes("Post Sample resource usage"), "Post-* step must be present");
  assert.ok(!names.includes("Skipped step"), "no-timestamp step must be dropped");
});

test("child spans share the trace id and parent to the root span", () => {
  const spans = buildTracePayload(JOB, JOB.steps!, ENV, fakeIdGen())!.resourceSpans[0].scopeSpans[0]
    .spans;
  const root = spans[0];
  assert.equal(root.parentSpanId, undefined, "root has no parent");
  for (const child of spans.slice(1)) {
    assert.equal(child.traceId, root.traceId, "child shares trace id");
    assert.equal(child.parentSpanId, root.spanId, "child parents to root");
  }
});

test("span ids are correct hex widths (16B trace, 8B span)", () => {
  const spans = buildTracePayload(JOB, JOB.steps!, ENV)!.resourceSpans[0].scopeSpans[0].spans;
  for (const s of spans) {
    assert.match(s.traceId, /^[0-9a-f]{32}$/, "16-byte trace id");
    assert.match(s.spanId, /^[0-9a-f]{16}$/, "8-byte span id");
  }
});

test("span times are epoch-nanoseconds derived from the ISO timestamps", () => {
  const spans = buildTracePayload(JOB, JOB.steps!, ENV, fakeIdGen())!.resourceSpans[0].scopeSpans[0]
    .spans;
  const goTest = spans.find((s) => s.name === "go test")!;
  assert.equal(goTest.startTimeUnixNano, String(Date.parse("2025-01-01T00:00:03Z") * 1e6));
  assert.equal(goTest.endTimeUnixNano, String(Date.parse("2025-01-01T00:00:30Z") * 1e6));
});

test("root span end falls back to latest step end while job is in_progress", () => {
  const root = buildTracePayload(JOB, JOB.steps!, ENV, fakeIdGen())!.resourceSpans[0].scopeSpans[0]
    .spans[0];
  assert.equal(root.endTimeUnixNano, String(Date.parse("2025-01-01T00:00:31Z") * 1e6));
});

test("conclusion maps to OTLP span status (success=Ok, failure=Error, null=Unset)", () => {
  assert.deepEqual(spanStatus("success"), { code: 1 });
  assert.deepEqual(spanStatus("failure"), { code: 2 });
  assert.deepEqual(spanStatus("timed_out"), { code: 2 });
  assert.deepEqual(spanStatus("cancelled"), { code: 2 });
  assert.deepEqual(spanStatus(null), { code: 0 });
  assert.deepEqual(spanStatus("skipped"), { code: 0 });
  const spans = buildTracePayload(JOB, JOB.steps!, ENV, fakeIdGen())!.resourceSpans[0].scopeSpans[0]
    .spans;
  assert.deepEqual(spans.find((s) => s.name === "go test")!.status, { code: 2 });
});

test("trace carries the same CI resource attributes as metrics", () => {
  const attrs = buildTracePayload(JOB, JOB.steps!, ENV, fakeIdGen())!.resourceSpans[0].resource
    .attributes;
  const map = Object.fromEntries(attrs.map((a) => [a.key, a.value.stringValue]));
  assert.equal(map["service.name"], "github-ci-runner");
  assert.equal(map["ci.repo"], "octocat/hello-world");
});

test("allSteps keeps every timestamped step, drops untimed ones", () => {
  const rows = allSteps(JOB.steps!);
  assert.equal(rows.length, 4);
  assert.deepEqual(
    rows.map((r) => r.name),
    ["Set up job", "Sample resource usage", "go test", "Post Sample resource usage"],
  );
});

test("selectJob matches on runner_name regardless of status (completed too)", () => {
  const jobs: GhJob[] = [
    { id: 1, runner_name: "other", status: "completed", run_attempt: 1 },
    { id: 2, runner_name: "mine", status: "completed", run_attempt: 1 },
  ];
  assert.equal(selectJob(jobs, "mine", "1")!.id, 2);
});

test("selectJob matches an in_progress job too", () => {
  const jobs: GhJob[] = [{ id: 7, runner_name: "mine", status: "in_progress", run_attempt: 1 }];
  assert.equal(selectJob(jobs, "mine", "1")!.id, 7);
});

test("selectJob disambiguates re-runs by run_attempt", () => {
  const jobs: GhJob[] = [
    { id: 1, runner_name: "mine", status: "completed", run_attempt: 1 },
    { id: 2, runner_name: "mine", status: "in_progress", run_attempt: 2 },
  ];
  assert.equal(selectJob(jobs, "mine", "2")!.id, 2);
});

test("selectJob ignores run_attempt when either side lacks it", () => {
  assert.equal(selectJob([{ id: 5, runner_name: "mine" }], "mine", "3")!.id, 5);
  assert.equal(
    selectJob([{ id: 6, runner_name: "mine", run_attempt: 3 }], "mine", undefined)!.id,
    6,
  );
});

test("selectJob returns undefined when no runner matches or the list is empty", () => {
  assert.equal(selectJob([{ id: 1, runner_name: "other" }], "mine", "1"), undefined);
  assert.equal(selectJob([], "mine", "1"), undefined);
  assert.equal(selectJob(null, "mine", "1"), undefined);
});

test("selectJob skips a match that has no id (job not yet materialized)", () => {
  assert.equal(selectJob([{ runner_name: "mine", run_attempt: 1 }], "mine", "1"), undefined);
});

test("buildTracePayload returns null when the job start is unparseable", () => {
  const bad = { ...JOB, started_at: "not-a-date" };
  assert.equal(buildTracePayload(bad, bad.steps!, ENV, fakeIdGen()), null);
  const missing = { ...JOB, started_at: null };
  assert.equal(buildTracePayload(missing, missing.steps!, ENV, fakeIdGen()), null);
});

test("steps with malformed timestamps are dropped — no NaN nanos emitted", () => {
  const steps: GhStep[] = [
    {
      name: "good",
      number: 1,
      conclusion: "success",
      started_at: "2025-01-01T00:00:00Z",
      completed_at: "2025-01-01T00:00:05Z",
    },
    {
      name: "garbage",
      number: 2,
      conclusion: "success",
      started_at: "whenever",
      completed_at: "whenever",
    },
  ];
  const payload = buildTracePayload(JOB, steps, ENV, fakeIdGen())!;
  const spans = payload.resourceSpans[0].scopeSpans[0].spans;
  const names = spans.map((s) => s.name);
  assert.ok(names.includes("good"));
  assert.ok(!names.includes("garbage"), "unparseable step must be dropped");
  for (const s of spans) {
    assert.match(s.startTimeUnixNano, /^\d+$/, `${s.name} start is numeric`);
    assert.match(s.endTimeUnixNano, /^\d+$/, `${s.name} end is numeric`);
  }
});

test("jobBounds returns start and end in epoch ms", () => {
  const b = jobBounds(JOB, JOB.steps)!;
  assert.equal(b.start, Date.parse("2025-01-01T00:00:00Z"));
  assert.equal(b.end, Date.parse("2025-01-01T00:00:31Z"));
});

test("jobBounds prefers job.completed_at over the latest step end", () => {
  const finished = { ...JOB, completed_at: "2025-01-01T00:00:45Z" };
  assert.equal(jobBounds(finished, finished.steps)!.end, Date.parse("2025-01-01T00:00:45Z"));
});

test("jobBounds falls back to start when no step has a parseable end", () => {
  const noEnds: GhJob = {
    ...JOB,
    completed_at: null,
    steps: [
      { name: "x", conclusion: null, started_at: "2025-01-01T00:00:00Z", completed_at: null },
    ],
  };
  const b = jobBounds(noEnds, noEnds.steps)!;
  assert.equal(b.start, b.end, "zero-width window when no end is known");
});

test("jobBounds returns null when the job start is unparseable", () => {
  assert.equal(jobBounds({ ...JOB, started_at: "nope" }, JOB.steps), null);
  assert.equal(jobBounds({ ...JOB, started_at: null }, JOB.steps), null);
});

test("buildJobDurationPayload emits one gauge with the duration in seconds", () => {
  const p = buildJobDurationPayload(JOB, JOB.steps, ENV)!;
  const metrics = p.resourceMetrics[0].scopeMetrics[0].metrics;
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].name, JOB_DURATION_METRIC);
  assert.equal(metrics[0].unit, "s");
  const pts = metrics[0].gauge.dataPoints;
  assert.equal(pts.length, 1, "one point per job");
  assert.equal(pts[0].asDouble, 31);
});

test("job-duration point is stamped at the job-end instant", () => {
  const pt = buildJobDurationPayload(JOB, JOB.steps, ENV)!.resourceMetrics[0].scopeMetrics[0]
    .metrics[0].gauge.dataPoints[0];
  const endNano = String(Date.parse("2025-01-01T00:00:31Z") * 1e6);
  assert.equal(pt.timeUnixNano, endNano);
  assert.equal(pt.startTimeUnixNano, endNano);
});

test("job-duration point carries ci_run_id but not high-cardinality labels", () => {
  const pt = buildJobDurationPayload(JOB, JOB.steps, ENV)!.resourceMetrics[0].scopeMetrics[0]
    .metrics[0].gauge.dataPoints[0];
  const keys = pt.attributes.map((a) => a.key);
  assert.ok(keys.includes("ci.run_id"), "run_id present for per-run grouping");
  assert.ok(keys.includes("ci.workflow") && keys.includes("ci.job"), "workflow/job present");
  assert.ok(!keys.includes("vcs.revision"), "commit sha kept off the metric");
  assert.ok(!keys.includes("ci.runner_name"), "runner name kept off the metric");
});

test("buildJobDurationPayload returns null when the job start is unparseable", () => {
  assert.equal(buildJobDurationPayload({ ...JOB, started_at: "nope" }, JOB.steps, ENV), null);
});

test("buildJobDurationPayload still emits with absent steps (jobBounds falls back)", () => {
  const finished = { ...JOB, completed_at: "2025-01-01T00:00:40Z" };
  const p = buildJobDurationPayload(finished, null, ENV)!;
  const pt = p.resourceMetrics[0].scopeMetrics[0].metrics[0].gauge.dataPoints[0];
  assert.equal(pt.asDouble, 40, "uses job.completed_at when steps are absent");
});

const ROUTE_TABLE = [
  "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT",
  "eth0\t00000000\t0118A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0",
  "eth0\t0018A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0",
  "docker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0",
  "",
].join("\n");

test("parseDefaultRouteIface returns the iface owning the default route", () => {
  assert.equal(parseDefaultRouteIface(ROUTE_TABLE), "eth0");
});

test("parseDefaultRouteIface handles a non-eth0 primary NIC name", () => {
  const table = [
    "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask",
    "ens5\t00000000\t0118A8C0\t0003\t0\t0\t100\t00000000",
    "ens5\t0018A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF",
  ].join("\n");
  assert.equal(parseDefaultRouteIface(table), "ens5");
});

test("parseDefaultRouteIface returns null when there is no default route", () => {
  const table = [
    "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask",
    "eth0\t0018A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF",
  ].join("\n");
  assert.equal(parseDefaultRouteIface(table), null);
  assert.equal(parseDefaultRouteIface(""), null);
});

const NET_DEV = [
  "Inter-|   Receive                                                |  Transmit",
  " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets",
  "    lo:  123456     100    0    0    0     0          0         0  123456     100",
  "  eth0: 1000000    2000    0    0    0     0          0         0  500000    1500",
  "docker0:  777000     500    0    0    0     0          0         0  888000     600",
  "veth9a1:   42000      80    0    0    0     0          0         0   9000      70",
  "",
].join("\n");

test("parseNetBytes reads ONLY the primary interface counters", () => {
  assert.deepEqual(parseNetBytes(NET_DEV, "eth0"), { rx: 1000000, tx: 500000 });
});

test("parseNetBytes falls back to summing all non-lo ifaces when primary is null", () => {
  const rx = 1000000 + 777000 + 42000;
  const tx = 500000 + 888000 + 9000;
  assert.deepEqual(parseNetBytes(NET_DEV, null), { rx, tx });
});

test("parseNetBytes returns zeros when the primary iface is absent from the table", () => {
  assert.deepEqual(parseNetBytes(NET_DEV, "eth1"), { rx: 0, tx: 0 });
});

const DISKSTATS = [
  "  259       0 nvme0n1 12345 0 987654 4567 8901 0 654321 2345 0 6789 6912",
  "  259       1 nvme0n1p1 11000 0 900000 4000 8000 0 600000 2000 0 6000 6000",
  "  259      15 nvme0n1p15 100 0 5000 50 200 0 8000 100 0 120 150",
  "  259       2 nvme1n1 500 0 40000 200 9999 0 800000 5000 0 5100 5200",
  "  259       3 nvme1n1p1 480 0 39000 190 9900 0 790000 4900 0 5000 5100",
  "    7       0 loop0 10 0 80 5 0 0 0 0 0 5 5",
  "  252       0 dm-0 200 0 1600 100 50 0 400 30 0 130 130",
  "   43       0 nbd0 300 0 24000 150 80 0 6400 40 0 190 190",
  "  254       0 zram0 999 0 70000 400 999 0 90000 500 0 900 900",
  "",
].join("\n");

test("parseDiskSectors sums only whole physical disks, not partitions or pseudo", () => {
  const physical = new Set(["nvme0n1", "nvme1n1"]);
  const want = 987654 + 654321 + 40000 + 800000;
  assert.deepEqual(parseDiskSectors(DISKSTATS, physical), { sectors: want });
});

test("parseDiskSectors null set falls back to the pseudo-only filter", () => {
  const want = 987654 + 654321 + 900000 + 600000 + 5000 + 8000 + 40000 + 800000 + 39000 + 790000;
  assert.deepEqual(parseDiskSectors(DISKSTATS, null), { sectors: want });
});

test("parseDiskSectors excludes md, nbd and zram pseudo/aggregate block devices", () => {
  const stats = [
    "  259       0 nvme0n1 1 0 1000 1 1 0 2000 1 0 1 1",
    "    9       0 md0 9 0 99000 9 9 0 99000 9 0 9 9",
    "   43       0 nbd0 9 0 99000 9 9 0 99000 9 0 9 9",
    "  254       0 zram0 9 0 88000 9 9 0 88000 9 0 9 9",
    "",
  ].join("\n");
  assert.deepEqual(parseDiskSectors(stats, null), { sectors: 3000 });
});
