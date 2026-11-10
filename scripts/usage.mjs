import { loadConfig } from "./config.mjs";
// Read-only analytics. Wrangler credentials are captured in memory, never logged.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

try {
  const config = loadConfig();
  const account = config.vars.CF_ACCOUNT_ID;
  const auth = JSON.parse(
    execFileSync(
      process.execPath,
      ["node_modules/wrangler/bin/wrangler.js", "auth", "token", "--json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000 },
    ),
  );
  if (typeof auth.token !== "string") throw new Error("credential_unavailable");
  const headers = {
    Authorization: `Bearer ${auth.token}`,
    "Content-Type": "application/json",
  };
  async function request(path, body) {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/${path}`,
      {
        method: body ? "POST" : "GET",
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(20000),
      },
    );
    if (!response.ok) throw new Error("metrics_unavailable");
    const result = await response.json();
    if (result.success === false || result.errors?.length)
      throw new Error("metrics_unavailable");
    return result;
  }
  const end = new Date().toISOString();
  const today = end.slice(0, 10);
  const start = new Date(Date.parse(today) - 6 * 86400000).toISOString();
  const query = `query Audit($account:string!,$script:string!,$start:Time!,$end:Time!){viewer{accounts(filter:{accountTag:$account}){
    worker:workersInvocationsAdaptive(limit:1000,filter:{scriptName:$script,datetime_geq:$start,datetime_lt:$end}){dimensions{date eventType status}sum{requests errors}quantiles{cpuTimeP50 cpuTimeP99}}
    accountWorkers:workersInvocationsAdaptive(limit:1000,filter:{datetime_geq:$start,datetime_lt:$end}){dimensions{date}sum{requests errors}}
    queues:queueMessageOperationsAdaptiveGroups(limit:1000,filter:{datetime_geq:$start,datetime_lt:$end}){dimensions{date queueId actionType outcome}sum{billableOperations}}
    d1:d1AnalyticsAdaptiveGroups(limit:1000,filter:{datetime_geq:$start,datetime_lt:$end}){dimensions{date databaseId}sum{rowsRead rowsWritten}}
  }}}`;
  const analytics = await request("graphql", {
    query,
    variables: { account, script: config.name, start, end },
  });
  const data = analytics.data?.viewer?.accounts?.[0];
  if (
    !data ||
    [data.worker, data.accountWorkers, data.queues, data.d1].some(
      (rows) => !Array.isArray(rows) || rows.length >= 1000,
    )
  )
    throw new Error("incomplete_metrics");
  const listed = await request(`accounts/${account}/queues`);
  const targetNames = [
    config.queues.producers[0].queue,
    config.queues.consumers[0].dead_letter_queue,
  ];
  const backlog = [];
  for (const name of targetNames) {
    const queue = listed.result?.find((q) => q.queue_name === name);
    if (!queue) throw new Error("queue_unavailable");
    const metrics = (
      await request(`accounts/${account}/queues/${queue.queue_id}/metrics`)
    ).result;
    backlog.push({
      name,
      messages: metrics.backlog_count,
      bytes: metrics.backlog_bytes,
      oldestMessageAt: metrics.oldest_message_timestamp_ms
        ? new Date(metrics.oldest_message_timestamp_ms).toISOString()
        : null,
    });
  }
  const database = (
    await request(
      `accounts/${account}/d1/database/${config.d1_databases[0].database_id}`,
    )
  ).result;
  const days = [];
  for (
    let time = Date.parse(start);
    time <= Date.parse(today);
    time += 86400000
  ) {
    const date = new Date(time).toISOString().slice(0, 10);
    const sum = (rows, field) =>
      rows
        .filter((r) => r.dimensions.date === date)
        .reduce((total, r) => total + r.sum[field], 0);
    days.push({
      date,
      partial: date === today,
      accountInvocations: sum(data.accountWorkers, "requests"),
      workerInvocations: sum(data.worker, "requests"),
      workerErrors: sum(data.worker, "errors"),
      accountQueueOperations: sum(data.queues, "billableOperations"),
      accountD1RowsRead: sum(data.d1, "rowsRead"),
      accountD1RowsWritten: sum(data.d1, "rowsWritten"),
    });
  }
  const cpu = data.worker.map((r) => ({
    date: r.dimensions.date,
    eventType: r.dimensions.eventType,
    status: r.dimensions.status,
    invocations: r.sum.requests,
    p50ms: r.quantiles.cpuTimeP50 / 1000,
    p99ms: r.quantiles.cpuTimeP99 / 1000,
  }));
  const report = {
    generatedAt: end,
    start,
    end,
    dayBoundary: "UTC",
    days,
    cpu,
    backlog,
    databaseBytes: database.file_size ?? database.database_size ?? null,
    freeDailyReference: {
      invocations: 100000,
      queueOperations: 10000,
      d1RowsRead: 5000000,
      d1RowsWritten: 100000,
      checkedOn: "2026-11-08",
    },
    notes: [
      "Analytics may be sampled, delayed or revised; today is incomplete. Zero reported invocation errors does not rule out handled retries.",
      "Queue and D1 totals include the account; CPU is per Worker/day/event type/status. Percentiles are not averaged across groups.",
      "The subscription/billing plan is not verified by this report. No plan changes or synthetic traffic are generated.",
    ],
  };
  if (process.argv.includes("--json"))
    console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Usage through ${end} · UTC days · today is partial`);
    console.table(days);
    console.log(`D1 storage: ${report.databaseBytes ?? "unavailable"} bytes`);
    console.table(backlog);
    console.log("Today's CPU cohorts (milliseconds):");
    console.table(cpu.filter((r) => r.date === today));
    console.log(
      "Free daily reference: 100,000 invocations; 10,000 queue operations; 5,000,000 D1 rows read; 100,000 rows written. Checked 2026-11-08.",
    );
    for (const note of report.notes) console.log(note);
  }
} catch {
  console.error(
    "Could not read complete Cloudflare usage. Check Wrangler login, analytics/queue/D1 read access, configuration and network connectivity. No credentials were printed.",
  );
  process.exitCode = 1;
}
