"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OTLP_METRICS = exports.JOB_DURATION_METRIC = void 0;
exports.buildOtlpPayload = buildOtlpPayload;
exports.buildTracePayload = buildTracePayload;
exports.jobBounds = jobBounds;
exports.buildJobDurationPayload = buildJobDurationPayload;
exports.ciResourceAttributes = ciResourceAttributes;
exports.spanStatus = spanStatus;
exports.allSteps = allSteps;
exports.selectJob = selectJob;
exports.postOtlp = postOtlp;
exports.parseDefaultRouteIface = parseDefaultRouteIface;
exports.parseNetBytes = parseNetBytes;
exports.parseDiskSectors = parseDiskSectors;
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
const url_1 = require("url");
const child_process_1 = require("child_process");
const CSV_PATH = path_1.default.join(os_1.default.tmpdir(), "resource-samples.csv");
const START_PATH = path_1.default.join(os_1.default.tmpdir(), "resource-sampler-start");
const CPU_COLOR = "#1f77b4";
const MEM_COLOR = "#2ca02c";
const IOWAIT_COLOR = "#d62728";
const DISK_COLOR = "#9467bd";
const NET_RX_COLOR = "#1f77b4";
const NET_TX_COLOR = "#ff7f0e";
const SECTOR_BYTES = 512;
const COLUMNS = [
    { key: "elapsed", header: "elapsed_s" },
    { key: "mem", header: "mem_used_mb" },
    { key: "cpu", header: "cpu_pct" },
    { key: "iowait", header: "iowait_pct" },
    { key: "disk", header: "disk_mbps" },
    { key: "netRx", header: "net_rx_mbps" },
    { key: "netTx", header: "net_tx_mbps" },
];
const COL = Object.fromEntries(COLUMNS.map((c, i) => [c.key, i]));
const CSV_HEADER = COLUMNS.map((c) => c.header).join(",") + "\n";
function saveState(name, value) {
    const f = process.env.GITHUB_STATE;
    if (f)
        fs_1.default.appendFileSync(f, `${name}=${value}\n`);
}
function appendSummary(md) {
    const f = process.env.GITHUB_STEP_SUMMARY;
    if (f)
        fs_1.default.appendFileSync(f, md);
    else
        process.stdout.write(md);
}
function readCpuBusyTotal() {
    const line = fs_1.default
        .readFileSync("/proc/stat", "utf8")
        .split("\n")
        .find((l) => l.startsWith("cpu "));
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    const total = parts.reduce((a, b) => a + b, 0);
    const iowait = parts[4] || 0;
    const idle = (parts[3] || 0) + iowait;
    return { busy: total - idle, total, iowait };
}
const PSEUDO_DISK = /^(loop|ram|dm-|md|nbd|zram)/;
function readPhysicalDisks() {
    try {
        return new Set(fs_1.default.readdirSync("/sys/block").filter((n) => !PSEUDO_DISK.test(n)));
    }
    catch {
        return null;
    }
}
function parseDiskSectors(diskstatsText, physicalDisks) {
    let rd = 0;
    let wr = 0;
    for (const l of diskstatsText.split("\n")) {
        const p = l.trim().split(/\s+/);
        const name = p[2];
        if (!name)
            continue;
        const keep = physicalDisks ? physicalDisks.has(name) : !PSEUDO_DISK.test(name);
        if (!keep)
            continue;
        rd += Number(p[5]) || 0;
        wr += Number(p[9]) || 0;
    }
    return { sectors: rd + wr };
}
function readDiskSectors(physicalDisks) {
    return parseDiskSectors(fs_1.default.readFileSync("/proc/diskstats", "utf8"), physicalDisks);
}
function parseDefaultRouteIface(routeText) {
    for (const l of routeText.split("\n")) {
        const p = l.trim().split(/\s+/);
        if (p[1] === "00000000")
            return p[0];
    }
    return null;
}
function readDefaultRouteIface() {
    try {
        return parseDefaultRouteIface(fs_1.default.readFileSync("/proc/net/route", "utf8"));
    }
    catch {
        return null;
    }
}
function parseNetBytes(devText, primaryIface) {
    let rx = 0;
    let tx = 0;
    for (const l of devText.split("\n")) {
        const m = l.match(/^\s*([\w@.-]+):\s*(\d+)(?:\s+\d+){7}\s+(\d+)/);
        if (!m)
            continue;
        if (primaryIface ? m[1] !== primaryIface : m[1] === "lo")
            continue;
        rx += Number(m[2]) || 0;
        tx += Number(m[3]) || 0;
    }
    return { rx, tx };
}
function readNetBytes(primaryIface) {
    return parseNetBytes(fs_1.default.readFileSync("/proc/net/dev", "utf8"), primaryIface);
}
function readMemUsedMb() {
    const info = {};
    for (const l of fs_1.default.readFileSync("/proc/meminfo", "utf8").split("\n")) {
        const m = l.match(/^(\w+):\s+(\d+)\s*kB/);
        if (m)
            info[m[1]] = Number(m[2]);
    }
    const used = (info.MemTotal ?? 0) - (info.MemAvailable ?? info.MemFree ?? 0);
    return Math.round(used / 1024);
}
const MIB = 1024 * 1024;
const OTLP_TIMEOUT_MS = 5000;
const OTLP_METRICS = [
    { col: COL.mem, name: "ci.runner.mem.used", unit: "By", scale: MIB },
    { col: COL.cpu, name: "ci.runner.cpu.utilization", unit: "%" },
    { col: COL.iowait, name: "ci.runner.iowait", unit: "%" },
    { col: COL.disk, name: "ci.runner.disk.throughput", unit: "By/s", scale: MIB },
    { col: COL.netRx, name: "ci.runner.net.rx", unit: "By/s", scale: MIB },
    { col: COL.netTx, name: "ci.runner.net.tx", unit: "By/s", scale: MIB },
];
exports.OTLP_METRICS = OTLP_METRICS;
function ciResourceAttributes(env) {
    const prMatch = /^(\d+)\/merge$/.exec(env.GITHUB_REF_NAME || "");
    const prNumber = prMatch ? prMatch[1] : undefined;
    const attrs = [
        ["service.name", "github-ci-runner"],
        ["ci.repo", env.GITHUB_REPOSITORY],
        ["ci.workflow", env.GITHUB_WORKFLOW],
        ["ci.job", env.GITHUB_JOB],
        ["ci.run_id", env.GITHUB_RUN_ID],
        ["ci.run_attempt", env.GITHUB_RUN_ATTEMPT],
        ["ci.run_number", env.GITHUB_RUN_NUMBER],
        ["ci.event", env.GITHUB_EVENT_NAME],
        ["ci.branch", env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME],
        ["ci.pr_number", prNumber],
        ["vcs.revision", env.GITHUB_SHA],
        ["ci.actor", env.GITHUB_ACTOR],
        ["ci.triggering_actor", env.GITHUB_TRIGGERING_ACTOR],
        ["ci.runner_os", env.RUNNER_OS],
        ["ci.runner_name", env.RUNNER_NAME],
    ];
    return attrs
        .filter(([, v]) => v !== undefined && v !== "")
        .map(([key, value]) => ({ key, value: { stringValue: String(value) } }));
}
const HIGH_CARDINALITY_KEYS = new Set([
    "vcs.revision",
    "ci.run_number",
    "ci.pr_number",
    "ci.runner_name",
]);
function ciMetricAttributes(env) {
    return ciResourceAttributes(env).filter((a) => !HIGH_CARDINALITY_KEYS.has(a.key));
}
function buildOtlpPayload(rows, originMs, env) {
    const pointAttrs = ciMetricAttributes(env);
    const metrics = OTLP_METRICS.map((m) => ({
        name: m.name,
        unit: m.unit,
        gauge: {
            dataPoints: rows.map((r) => {
                const nano = String((originMs + r[COL.elapsed] * 1000) * 1e6);
                return {
                    timeUnixNano: nano,
                    startTimeUnixNano: nano,
                    asDouble: m.scale ? r[m.col] * m.scale : r[m.col],
                    attributes: pointAttrs,
                };
            }),
        },
    }));
    return {
        resourceMetrics: [
            {
                resource: { attributes: ciResourceAttributes(env) },
                scopeMetrics: [{ scope: { name: "resource-sampler" }, metrics }],
            },
        ],
    };
}
async function postOtlp(endpoint, auth, signal, body) {
    let url;
    try {
        url = new url_1.URL(endpoint);
        let base = url.pathname;
        while (base.endsWith("/"))
            base = base.slice(0, -1);
        url.pathname = base + `/v1/${signal}`;
    }
    catch {
        return null;
    }
    try {
        const res = await fetch(url, {
            method: "POST",
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(OTLP_TIMEOUT_MS),
            headers: {
                "content-type": "application/json",
                authorization: auth,
                "user-agent": "resource-sampler",
            },
        });
        return res.status;
    }
    catch {
        return null;
    }
}
async function pushOtlp(rows, originMs) {
    const endpoint = process.env.STATE_otlpEndpoint;
    const auth = process.env.STATE_otlpAuth;
    if (!endpoint || !auth)
        return;
    if (!Number.isFinite(originMs)) {
        console.log("[resource-sampler] otlp push skipped: no sampler origin timestamp");
        return;
    }
    const payload = buildOtlpPayload(rows, originMs, process.env);
    const points = rows.length * OTLP_METRICS.length;
    const status = await postOtlp(endpoint, auth, "metrics", payload);
    if (status && status >= 200 && status < 300) {
        console.log(`[resource-sampler] pushed ${points} OTLP data points (HTTP ${status})`);
    }
    else {
        console.log(`[resource-sampler] otlp metrics push failed (status ${status}) — charts unaffected`);
    }
}
function genId(bytes) {
    return crypto_1.default.randomBytes(bytes).toString("hex");
}
function spanStatus(conclusion) {
    if (conclusion === "success")
        return { code: 1 };
    if (conclusion === "failure" || conclusion === "timed_out" || conclusion === "cancelled") {
        return { code: 2 };
    }
    return { code: 0 };
}
function parseMs(iso) {
    return iso ? Date.parse(iso) : NaN;
}
function jobBounds(job, steps) {
    const start = parseMs(job.started_at);
    if (!Number.isFinite(start))
        return null;
    const stepEnds = (steps || []).map((s) => parseMs(s.completed_at)).filter(Number.isFinite);
    const endRaw = parseMs(job.completed_at);
    const end = Number.isFinite(endRaw) ? endRaw : stepEnds.length ? Math.max(...stepEnds) : start;
    return { start, end };
}
function buildTracePayload(job, steps, env, idGen = genId) {
    const bounds = jobBounds(job, steps);
    if (!bounds)
        return null;
    const { start: jobStart, end: jobEnd } = bounds;
    const traceId = idGen(16);
    const rootId = idGen(8);
    const rootSpan = {
        traceId,
        spanId: rootId,
        name: job.name || "job",
        kind: 1,
        startTimeUnixNano: String(jobStart * 1e6),
        endTimeUnixNano: String(jobEnd * 1e6),
        status: spanStatus(job.conclusion ?? null),
        attributes: [
            { key: "ci.job", value: { stringValue: String(job.name || "") } },
            { key: "ci.job_id", value: { intValue: String(job.id ?? 0) } },
        ],
    };
    const stepSpans = steps
        .map((s) => ({ s, start: parseMs(s.started_at), end: parseMs(s.completed_at) }))
        .filter(({ start, end }) => Number.isFinite(start) && Number.isFinite(end))
        .map(({ s, start, end }) => ({
        traceId,
        spanId: idGen(8),
        parentSpanId: rootId,
        name: s.name,
        kind: 1,
        startTimeUnixNano: String(start * 1e6),
        endTimeUnixNano: String(end * 1e6),
        status: spanStatus(s.conclusion),
        attributes: [
            { key: "ci.step.number", value: { intValue: String(s.number ?? 0) } },
            { key: "ci.step.conclusion", value: { stringValue: String(s.conclusion || "") } },
        ],
    }));
    return {
        resourceSpans: [
            {
                resource: { attributes: ciResourceAttributes(env) },
                scopeSpans: [{ scope: { name: "resource-sampler" }, spans: [rootSpan, ...stepSpans] }],
            },
        ],
    };
}
async function pushTraces(job, steps) {
    const endpoint = process.env.STATE_otlpEndpoint;
    const auth = process.env.STATE_otlpAuth;
    if (!endpoint || !auth)
        return;
    if (!job || !job.started_at || !Array.isArray(steps))
        return;
    const payload = buildTracePayload(job, steps, process.env);
    if (!payload) {
        console.log("[resource-sampler] otlp traces push skipped: unparseable job start time");
        return;
    }
    const nSpans = payload.resourceSpans[0].scopeSpans[0].spans.length;
    const status = await postOtlp(endpoint, auth, "traces", payload);
    if (status && status >= 200 && status < 300) {
        console.log(`[resource-sampler] pushed trace with ${nSpans} spans (HTTP ${status})`);
    }
    else {
        console.log(`[resource-sampler] otlp traces push failed (status ${status}) — summary unaffected`);
    }
}
const JOB_DURATION_METRIC = "ci.runner.job.duration";
exports.JOB_DURATION_METRIC = JOB_DURATION_METRIC;
function buildJobDurationPayload(job, steps, env) {
    const bounds = jobBounds(job, steps);
    if (!bounds)
        return null;
    const durationSecs = (bounds.end - bounds.start) / 1000;
    const nano = String(bounds.end * 1e6);
    return {
        resourceMetrics: [
            {
                resource: { attributes: ciResourceAttributes(env) },
                scopeMetrics: [
                    {
                        scope: { name: "resource-sampler" },
                        metrics: [
                            {
                                name: JOB_DURATION_METRIC,
                                unit: "s",
                                gauge: {
                                    dataPoints: [
                                        {
                                            timeUnixNano: nano,
                                            startTimeUnixNano: nano,
                                            asDouble: durationSecs,
                                            attributes: ciMetricAttributes(env),
                                        },
                                    ],
                                },
                            },
                        ],
                    },
                ],
            },
        ],
    };
}
async function pushJobDuration(job, steps) {
    const endpoint = process.env.STATE_otlpEndpoint;
    const auth = process.env.STATE_otlpAuth;
    if (!endpoint || !auth)
        return;
    if (!job || !job.started_at)
        return;
    const payload = buildJobDurationPayload(job, steps, process.env);
    if (!payload) {
        console.log("[resource-sampler] otlp job duration push skipped: unparseable job start time");
        return;
    }
    const status = await postOtlp(endpoint, auth, "metrics", payload);
    if (status && status >= 200 && status < 300) {
        console.log(`[resource-sampler] pushed job duration metric (HTTP ${status})`);
    }
    else {
        console.log(`[resource-sampler] otlp job duration push failed (status ${status}) — charts unaffected`);
    }
}
function runSampleLoop() {
    const interval = Number(process.env.RS_INTERVAL || "5");
    const start = Date.now();
    fs_1.default.writeFileSync(START_PATH, String(start));
    fs_1.default.writeFileSync(CSV_PATH, CSV_HEADER);
    const primaryIface = readDefaultRouteIface();
    const physicalDisks = readPhysicalDisks();
    let prev = readCpuBusyTotal();
    let prevDisk = readDiskSectors(physicalDisks);
    let prevNet = readNetBytes(primaryIface);
    let prevMs = start;
    setInterval(() => {
        const nowMs = Date.now();
        const cur = readCpuBusyTotal();
        const curDisk = readDiskSectors(physicalDisks);
        const curNet = readNetBytes(primaryIface);
        const dBusy = cur.busy - prev.busy;
        const dTotal = cur.total - prev.total;
        const dIowait = cur.iowait - prev.iowait;
        const dSectors = curDisk.sectors - prevDisk.sectors;
        const dRx = curNet.rx - prevNet.rx;
        const dTx = curNet.tx - prevNet.tx;
        const dSecs = (nowMs - prevMs) / 1000;
        prev = cur;
        prevDisk = curDisk;
        prevNet = curNet;
        prevMs = nowMs;
        const cpuPct = dTotal > 0 ? ((dBusy / dTotal) * 100).toFixed(1) : "0.0";
        const iowaitPct = dTotal > 0 ? ((dIowait / dTotal) * 100).toFixed(1) : "0.0";
        const toMbps = (bytes) => dSecs > 0 ? (bytes / 1024 / 1024 / dSecs).toFixed(1) : "0.0";
        const sample = {
            elapsed: Math.round((nowMs - start) / 1000),
            mem: readMemUsedMb(),
            cpu: cpuPct,
            iowait: iowaitPct,
            disk: toMbps(dSectors * SECTOR_BYTES),
            netRx: toMbps(dRx),
            netTx: toMbps(dTx),
        };
        fs_1.default.appendFileSync(CSV_PATH, COLUMNS.map((c) => sample[c.key]).join(",") + "\n");
    }, interval * 1000);
}
function start() {
    const interval = process.env.INPUT_INTERVAL || "5";
    const maxPoints = process.env["INPUT_MAX-POINTS"] || "120";
    const child = (0, child_process_1.spawn)(process.execPath, [__filename], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, RS_MODE: "sample", RS_INTERVAL: interval },
    });
    child.unref();
    saveState("isPost", "true");
    saveState("pid", String(child.pid));
    saveState("maxPoints", maxPoints);
    saveState("interval", interval);
    const token = process.env["INPUT_GITHUB-TOKEN"];
    if (token)
        saveState("token", token);
    const otlpEndpoint = process.env["INPUT_OTLP-ENDPOINT"];
    const otlpAuth = process.env["INPUT_OTLP-AUTH"];
    if (otlpEndpoint)
        saveState("otlpEndpoint", otlpEndpoint);
    if (otlpAuth)
        saveState("otlpAuth", otlpAuth);
    const nic = readDefaultRouteIface() || "all (no default route)";
    console.log(`[resource-sampler] started (pid ${child.pid}, ${interval}s interval, net iface ${nic})`);
}
function buildChart(title, yLabel, yMax, xMax, series) {
    const palette = series.map((s) => s.color).join(", ");
    const init = `%%{init: {"themeVariables": {"xyChart": {"plotColorPalette": "${palette}"}}}}%%`;
    return [
        "```mermaid",
        init,
        "xychart-beta",
        `    title "${title}"`,
        `    x-axis "elapsed (s)" 0 --> ${xMax}`,
        `    y-axis "${yLabel}" 0 --> ${yMax}`,
        ...series.map((s) => `    line [${s.ys.join(",")}]`),
        "```",
        "",
    ].join("\n");
}
async function apiGet(path, token) {
    try {
        const res = await fetch(`https://api.github.com${path}`, {
            signal: AbortSignal.timeout(OTLP_TIMEOUT_MS),
            headers: {
                authorization: `Bearer ${token}`,
                accept: "application/vnd.github+json",
                "user-agent": "resource-sampler",
            },
        });
        if (res.status !== 200)
            return null;
        return await res.json();
    }
    catch {
        return null;
    }
}
function selectJob(jobs, runner, runAttempt) {
    return (jobs || []).find((j) => j.id &&
        j.runner_name === runner &&
        (runAttempt == null || j.run_attempt == null || String(j.run_attempt) === String(runAttempt)));
}
async function fetchJob() {
    const token = process.env.STATE_token || process.env.GITHUB_TOKEN;
    const repo = process.env.GITHUB_REPOSITORY;
    const runId = process.env.GITHUB_RUN_ID;
    const runner = process.env.RUNNER_NAME;
    const runAttempt = process.env.GITHUB_RUN_ATTEMPT;
    if (!token || !repo || !runId || !runner) {
        console.log(`[resource-sampler] step timings skipped: token=${!!token} repo=${!!repo} runId=${!!runId} runner=${!!runner}`);
        return null;
    }
    for (let attempt = 0; attempt < 5; attempt++) {
        const data = (await apiGet(`/repos/${repo}/actions/runs/${runId}/jobs?per_page=100&filter=latest`, token));
        const job = selectJob(data?.jobs, runner, runAttempt);
        if (job)
            return job;
        await new Promise((r) => setTimeout(r, 1000));
    }
    console.log(`[resource-sampler] step timings skipped: no job matched runner ${runner}`);
    return null;
}
function allSteps(steps) {
    return steps
        .filter((s) => s.started_at && s.completed_at)
        .map((s) => ({
        name: s.name,
        start: Date.parse(s.started_at),
        end: Date.parse(s.completed_at),
    }));
}
function buildWaterfall(steps) {
    const rows = allSteps(steps);
    if (rows.length === 0)
        return "";
    const span = Math.max(...rows.map((r) => r.end)) - Math.min(...rows.map((r) => r.start));
    const minBarMs = Math.max(1000, Math.round(span * 0.015));
    const lines = [
        "**Step timeline**",
        "",
        "```mermaid",
        "gantt",
        "    title Step durations",
        "    dateFormat x",
        "    axisFormat %H:%M:%S",
        "    todayMarker off",
    ];
    for (const r of rows) {
        const secs = Math.round((r.end - r.start) / 1000);
        const name = `${r.name} (${secs}s)`.replace(/[:,]/g, " ");
        const end = Math.max(r.end, r.start + minBarMs);
        lines.push(`    ${name} : ${r.start}, ${end}`);
    }
    lines.push("```", "");
    return lines.join("\n");
}
async function publish() {
    const pid = process.env.STATE_pid;
    if (pid) {
        try {
            process.kill(Number(pid));
        }
        catch { }
    }
    if (!fs_1.default.existsSync(CSV_PATH)) {
        appendSummary("### Resource usage\n_No samples collected._\n");
        return;
    }
    const rows = fs_1.default
        .readFileSync(CSV_PATH, "utf8")
        .trim()
        .split("\n")
        .slice(1)
        .filter(Boolean)
        .map((l) => l.split(",").map(Number));
    if (rows.length === 0) {
        appendSummary("### Resource usage\n_No samples collected (job too short)._\n");
        return;
    }
    const maxPoints = Number(process.env.STATE_maxPoints || "60");
    const interval = process.env.STATE_interval || "5";
    const peak = rows.reduce((p, r) => ({
        mem: Math.max(p.mem, r[COL.mem]),
        cpu: Math.max(p.cpu, r[COL.cpu]),
        iowait: Math.max(p.iowait, r[COL.iowait]),
        disk: Math.max(p.disk, r[COL.disk]),
        net: Math.max(p.net, r[COL.netRx], r[COL.netTx]),
    }), { mem: 0, cpu: 0, iowait: 0, disk: 0, net: 0 });
    const step = rows.length > maxPoints ? Math.ceil(rows.length / maxPoints) : 1;
    const picked = rows.filter((_, i) => i % step === 0 || i === rows.length - 1);
    const xMax = rows[rows.length - 1][COL.elapsed];
    const mem = picked.map((r) => r[COL.mem]);
    const cpu = picked.map((r) => r[COL.cpu]);
    const iowait = picked.map((r) => r[COL.iowait]);
    const disk = picked.map((r) => r[COL.disk]);
    const netRx = picked.map((r) => r[COL.netRx]);
    const netTx = picked.map((r) => r[COL.netTx]);
    const memMax = Math.round(peak.mem * 1.1) + 1;
    const diskMax = Math.round(peak.disk * 1.1) + 1;
    const netMax = Math.round(peak.net * 1.1) + 1;
    let waterfall = "";
    let job = null;
    const steps = await fetchJob().then((j) => {
        job = j;
        return j?.steps || null;
    });
    if (steps)
        waterfall = buildWaterfall(steps);
    const originMs = fs_1.default.existsSync(START_PATH) ? Number(fs_1.default.readFileSync(START_PATH, "utf8")) : NaN;
    appendSummary([
        "### Resource usage",
        "",
        `Peak CPU **${peak.cpu}%** · peak memory **${peak.mem} MB** · peak iowait **${peak.iowait}%** · peak disk **${peak.disk} MB/s** · peak network **${peak.net} MB/s** · sampled every ${interval}s over ${rows.length} points.`,
        "",
        "**CPU (% of all cores)**",
        buildChart("CPU percent over time (s)", "percent", 100, xMax, [
            { ys: cpu, color: CPU_COLOR },
        ]),
        "**Memory (MB)**",
        buildChart("Memory used (MB) over time (s)", "MB", memMax, xMax, [
            { ys: mem, color: MEM_COLOR },
        ]),
        "**I/O wait (% of all cores)**",
        buildChart("I/O wait percent over time (s)", "percent", 100, xMax, [
            { ys: iowait, color: IOWAIT_COLOR },
        ]),
        "**Disk throughput (MB/s, read+write)**",
        buildChart("Disk MB/s over time (s)", "MB/s", diskMax, xMax, [
            { ys: disk, color: DISK_COLOR },
        ]),
        "**Network (MB/s) — RX (blue) / TX (orange)**",
        buildChart("Network MB/s over time (s)", "MB/s", netMax, xMax, [
            { ys: netRx, color: NET_RX_COLOR },
            { ys: netTx, color: NET_TX_COLOR },
        ]),
        waterfall,
    ].join("\n"));
    await pushOtlp(rows, originMs);
    if (job && steps)
        await pushTraces(job, steps);
    if (job)
        await pushJobDuration(job, steps);
}
if (require.main === module) {
    if (process.env.RS_MODE === "sample") {
        runSampleLoop();
    }
    else if (process.env.STATE_isPost === "true") {
        publish().catch((e) => {
            console.log(`[resource-sampler] publish error: ${e.message}`);
        });
    }
    else {
        start();
    }
}
