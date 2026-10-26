import readline from "node:readline";

const string = { type: "string" },
  integer = { type: "integer" },
  boolean = { type: "boolean" };
const definitions = [
  [
    "service_status",
    "Check the Node.js service and Python inference model files.",
    {},
    [],
  ],
  ["list_projects", "List local editing projects.", {}, []],
  ["create_project", "Create a local project.", { title: string }, []],
  [
    "import_video",
    "Copy an explicitly selected local video into a project.",
    { project_id: string, path: string },
    ["project_id", "path"],
  ],
  [
    "get_project",
    "Read the project and its revision before editing.",
    { project_id: string },
    ["project_id"],
  ],
  [
    "update_edit",
    "Save clips, source-clock subtitles and output-clock voiceovers with revision conflict protection.",
    {
      project_id: string,
      revision: integer,
      clips: { type: "array", items: { type: "object" } },
      subtitles: { type: "object" },
      title: string,
      voiceovers: { type: "array", items: { type: "object" } },
    },
    ["project_id", "revision", "clips", "subtitles"],
  ],
  [
    "transcribe_source",
    "Queue a Python subtitle inference job; poll get_job.",
    { project_id: string, source_id: string },
    ["project_id", "source_id"],
  ],
  [
    "export_video",
    "Queue a saved project snapshot export with FFmpeg.",
    { project_id: string, burn_subtitles: boolean },
    ["project_id"],
  ],
  [
    "get_job",
    "Read task state and complete output download URLs.",
    { job_id: string },
    ["job_id"],
  ],
];
export function loopbackBase(value) {
  const u = new URL(value);
  if (
    u.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(u.hostname) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    !["", "/"].includes(u.pathname)
  )
    throw new Error("MCP requires a loopback cutccc HTTP URL");
  return u.origin;
}
export async function apiCall(base, method, route, body) {
  const response = await fetch(base + route, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(300000),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(`cutccc API ${response.status}: ${data.detail}`);
  return data;
}
export async function callTool(base, name, a = {}) {
  const id = encodeURIComponent(a.project_id || "");
  switch (name) {
    case "service_status":
      return apiCall(base, "GET", "/api/health");
    case "list_projects":
      return apiCall(base, "GET", "/api/projects");
    case "create_project":
      return apiCall(base, "POST", "/api/projects", {
        title: a.title ?? "新项目",
      });
    case "import_video":
      return apiCall(base, "POST", `/api/projects/${id}/sources/import`, {
        path: a.path,
      });
    case "get_project":
      return apiCall(base, "GET", `/api/projects/${id}`);
    case "update_edit": {
      const b = {
        revision: a.revision,
        clips: a.clips,
        subtitles: a.subtitles,
      };
      if (a.title !== undefined) b.title = a.title;
      if (a.voiceovers !== undefined) b.voiceovers = a.voiceovers;
      return apiCall(base, "PATCH", `/api/projects/${id}`, b);
    }
    case "transcribe_source":
      return apiCall(base, "POST", `/api/projects/${id}/transcribe`, {
        source_id: a.source_id,
      });
    case "export_video":
      return apiCall(base, "POST", `/api/projects/${id}/export`, {
        burn_subtitles: a.burn_subtitles ?? true,
      });
    case "get_job": {
      const j = await apiCall(
        base,
        "GET",
        `/api/jobs/${encodeURIComponent(a.job_id || "")}`,
      );
      for (const key of ["video_url", "subtitles_url"])
        if (j.result?.[key]) j.result[key] = base + j.result[key];
      return j;
    }
    default:
      throw new Error("Unknown tool");
  }
}
export async function runMcp(value = "http://127.0.0.1:18765") {
  const base = loopbackBase(value);
  const tools = definitions.map(
    ([name, description, properties, required]) => ({
      name,
      description,
      inputSchema: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      },
    }),
  );
  const resources = [
    {
      uri: "cutccc://status",
      name: "Local cutccc status",
      mimeType: "application/json",
    },
  ];
  const lines = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });
  const send = (id, result, error) =>
    process.stdout.write(
      JSON.stringify(
        error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result },
      ) + "\n",
    );
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      send(null, null, { code: -32700, message: "Parse error" });
      continue;
    }
    if (message.id === undefined) continue;
    try {
      const p = message.params || {};
      let result;
      switch (message.method) {
        case "initialize":
          result = {
            protocolVersion: [
              "2024-11-05",
              "2025-03-26",
              "2025-06-18",
            ].includes(p.protocolVersion)
              ? p.protocolVersion
              : "2024-11-05",
            capabilities: { tools: {}, resources: {} },
            serverInfo: { name: "cutccc", version: "0.3.0" },
          };
          break;
        case "ping":
          result = {};
          break;
        case "tools/list":
          result = { tools };
          break;
        case "tools/call": {
          try {
            const value = await callTool(base, p.name, p.arguments);
            result = {
              content: [{ type: "text", text: JSON.stringify(value) }],
              structuredContent: value,
            };
          } catch (e) {
            result = {
              isError: true,
              content: [{ type: "text", text: e.message }],
            };
          }
          break;
        }
        case "resources/list":
          result = { resources };
          break;
        case "resources/templates/list":
          result = { resourceTemplates: [] };
          break;
        case "resources/read":
          if (p.uri !== "cutccc://status") throw new Error("Unknown resource");
          result = {
            contents: [
              {
                uri: p.uri,
                mimeType: "application/json",
                text: JSON.stringify(await apiCall(base, "GET", "/api/health")),
              },
            ],
          };
          break;
        default:
          send(message.id, null, { code: -32601, message: "Method not found" });
          continue;
      }
      send(message.id, result);
    } catch (e) {
      send(message.id, null, { code: -32602, message: e.message });
    }
  }
}
