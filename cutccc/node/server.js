import http from "node:http";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { APIError, fail } from "./editing.js";
import { validateModels } from "./media.js";
import { Studio } from "./studio.js";
import { exportSchema } from "../web/export-options.js";

const WEB = fileURLToPath(new URL("../web/", import.meta.url));
const SECURITY = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; frame-ancestors 'none'",
};
function json(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    ...SECURITY,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
  });
  res.end(body);
}
async function body(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] || ""))
    fail("Content-Type must be application/json", 415);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024 * 1024) fail("JSON body is too large", 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    fail("Invalid JSON body");
  }
}
function object(value, allowed, required = []) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("Expected a JSON object", 422);
  if (Object.keys(value).some((k) => !allowed.includes(k)))
    fail("Unknown request field", 422);
  if (required.some((k) => !(k in value)))
    fail("Required request field is missing", 422);
  return value;
}
function editBody(b) {
  object(
    b,
    ["revision", "clips", "subtitles", "title", "voiceovers"],
    ["revision", "clips", "subtitles"],
  );
  if (!Number.isInteger(b.revision) || b.revision < 1)
    fail("revision must be a positive integer", 422);
  if (!Array.isArray(b.clips)) fail("clips must be an array", 422);
  for (const c of b.clips)
    object(c, ["source_id", "start", "end"], ["source_id", "start", "end"]);
  if (
    !b.subtitles ||
    typeof b.subtitles !== "object" ||
    Array.isArray(b.subtitles)
  )
    fail("subtitles must be an object", 422);
  for (const cues of Object.values(b.subtitles)) {
    if (!Array.isArray(cues)) fail("Subtitle cues must be arrays", 422);
    for (const c of cues)
      object(c, ["start", "end", "text", "style", "shift"], ["start", "end", "text"]);
  }
  if (b.voiceovers !== undefined && b.voiceovers !== null) {
    if (!Array.isArray(b.voiceovers)) fail("voiceovers must be an array", 422);
    for (const v of b.voiceovers)
      object(v, ["source_id", "start", "volume"], ["source_id", "start"]);
  }
  return b;
}
async function sendFile(req, res, file, { name } = {}) {
  const stat = await fs.stat(file);
  if (!stat.isFile()) fail("File not found", 404);
  const mime = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".mp4": "video/mp4",
    ".srt": "text/plain; charset=utf-8",
    ".ass": "text/plain; charset=utf-8",
    ".log": "text/plain; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
  };
  const headers = {
    ...SECURITY,
    "Content-Type": mime[path.extname(file)] || "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Last-Modified": stat.mtime.toUTCString(),
  };
  if (name) headers["Content-Disposition"] = `attachment; filename="${name}"`;
  let start = 0,
    end = stat.size - 1,
    status = 200;
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m || (!m[1] && !m[2])) {
      res.writeHead(416, {
        ...headers,
        "Content-Range": `bytes */${stat.size}`,
      });
      res.end();
      return;
    }
    if (m[1]) {
      start = Number(m[1]);
      if (m[2]) end = Math.min(Number(m[2]), end);
    } else start = Math.max(0, stat.size - Number(m[2]));
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start >= stat.size ||
      end < start ||
      !stat.size
    ) {
      res.writeHead(416, {
        ...headers,
        "Content-Range": `bytes */${stat.size}`,
      });
      res.end();
      return;
    }
    status = 206;
    headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
  }
  headers["Content-Length"] = stat.size ? end - start + 1 : 0;
  res.writeHead(status, headers);
  if (req.method === "HEAD" || !stat.size) {
    res.end();
    return;
  }
  const stream = createReadStream(file, { start, end });
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}
// The UI sends one file. Keep only a boundary-sized tail in memory while writing.
async function upload(req, folder) {
  const type = req.headers["content-type"] || "";
  if (!/^multipart\/form-data;/i.test(type))
    fail("Expected multipart/form-data", 415);
  const match = /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(type),
    boundary = match?.[1] || match?.[2];
  if (!boundary || boundary.length > 200 || /[\r\n]/.test(boundary))
    fail("Invalid multipart boundary");
  await fs.mkdir(folder, { recursive: true });
  const temp = path.join(folder, randomUUID() + ".upload");
  const delimiter = Buffer.from("\r\n--" + boundary),
    first = Buffer.from("--" + boundary + "\r\n");
  let buffer = Buffer.alloc(0),
    headers = false,
    done = false,
    name,
    handle,
    size = 0;
  const write = async (b) => {
    let offset = 0;
    while (offset < b.length)
      offset += (await handle.write(b.subarray(offset))).bytesWritten;
  };
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 64 * 1024 ** 3) fail("Upload is too large", 413);
      if (done) continue;
      buffer = Buffer.concat([buffer, chunk]);
      if (!headers) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) {
          if (buffer.length > 16384) fail("Multipart headers are too large");
          continue;
        }
        if (!buffer.subarray(0, first.length).equals(first))
          fail("Invalid multipart body");
        const h = buffer.subarray(first.length, end).toString("utf8");
        const disposition =
          h.split("\r\n").find((s) => /^content-disposition:/i.test(s)) || "";
        if (!/;\s*name="file"(?:;|$)/i.test(disposition))
          fail("Expected one file in the file field");
        const filename = /;\s*filename="([^"\r\n]*)"/i.exec(disposition);
        if (!filename) fail("Upload filename is missing");
        name = filename[1] || "video.mp4";
        headers = true;
        buffer = buffer.subarray(end + 4);
        handle = await fs.open(temp, "wx");
      }
      let index = buffer.indexOf(delimiter);
      while (index >= 0) {
        if (buffer.length < index + delimiter.length + 2) break;
        const suffix = buffer
          .subarray(index + delimiter.length, index + delimiter.length + 2)
          .toString("ascii");
        if (suffix === "--") {
          await write(buffer.subarray(0, index));
          done = true;
          buffer = Buffer.alloc(0);
          break;
        }
        if (suffix === "\r\n") fail("Only one uploaded file is supported");
        index = buffer.indexOf(delimiter, index + 1);
      }
      if (!done && buffer.length > delimiter.length + 4) {
        const count = buffer.length - delimiter.length - 4;
        await write(buffer.subarray(0, count));
        buffer = buffer.subarray(count);
      }
    }
    if (!done || !headers) fail("Incomplete multipart upload");
    await handle.close();
    handle = null;
    return { temp, name };
  } catch (e) {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temp).catch(() => {});
    throw e;
  }
}
const ROUTES = [
  ["get", "/api/health", "服务与模型状态"],
  ["get", "/api/projects", "列出项目"],
  ["post", "/api/projects", "创建项目"],
  ["get", "/api/projects/{id}", "读取项目"],
  ["patch", "/api/projects/{id}", "保存剪辑、字幕和旁白"],
  ["post", "/api/projects/{id}/sources/import", "导入本机视频"],
  ["post", "/api/projects/{id}/sources/upload", "上传单个视频"],
  ["delete", "/api/projects/{id}/sources/{source_id}", "移除未使用的素材引用，保留磁盘文件"],
  ["get", "/api/projects/{id}/sources/{source_id}/media", "兼容预览媒体"],
  ["get", "/api/projects/{id}/sources/{source_id}/poster", "素材缩略图"],
  ["get", "/api/projects/{id}/sources/{source_id}/waveform", "原素材音频波形（自动缓存）"],
  ["get", "/api/projects/{id}/sources/{source_id}/spectrogram", "频谱PNG，tile=overview或20秒分块序号"],
  ["post", "/api/projects/{id}/transcribe", "排队生成字幕"],
  ["post", "/api/projects/{id}/export", "排队导出快照"],
  ["get", "/api/projects/{id}/jobs", "列出项目任务"],
  ["get", "/api/jobs/{id}", "读取任务"],
  ["get", "/api/jobs/{id}/video", "下载MP4"],
  ["get", "/api/jobs/{id}/subtitles", "下载SRT"],
  ["get", "/api/jobs/{id}/styled-subtitles", "下载带逐条样式的ASS字幕"],
  ["get", "/api/jobs/{id}/log", "任务日志"],
  ["get", "/api/jobs/{id}/review", "未识别及待复核区间（原素材时间）"],
  ["get", "/api/jobs/{id}/transcript", "下载原文转写"],
];
export function openapi() {
  const str = { type: "string" },
    number = { type: "number" },
    ref = (name) => ({ $ref: "#/components/schemas/" + name });
  const schema = (properties, required) => ({
    type: "object",
    properties,
    required,
    additionalProperties: false,
  });
  const schemas = {
    NewProject: schema(
      { title: { type: "string", minLength: 1, maxLength: 120 } },
      [],
    ),
    ImportPath: schema({ path: { type: "string", minLength: 1 } }, ["path"]),
    RemoveSource: schema({revision: {type: "integer", minimum: 1}}, ["revision"]),
    Clip: schema({ source_id: str, start: number, end: number }, [
      "source_id",
      "start",
      "end",
    ]),
    SubtitleStyle: schema({
      fontFamily: {type: "string", enum: ["Microsoft YaHei", "Noto Sans CJK SC", "Arial"]},
      fontSize: {type: "number", minimum: 12, maximum: 96},
      color: {type: "string", pattern: "^#[0-9a-fA-F]{6}$"},
      bold: {type: "boolean"}, italic: {type: "boolean"},
      outlineColor: {type: "string", pattern: "^#[0-9a-fA-F]{6}$"},
      outlineWidth: {type: "number", minimum: 0, maximum: 8},
      position: {type: "string", enum: ["top-left", "top-center", "top-right", "middle-left", "middle-center", "middle-right", "bottom-left", "bottom-center", "bottom-right"]},
      marginX: {type: "number", minimum: 0, maximum: 40},
      marginY: {type: "number", minimum: 0, maximum: 40},
    }, []),
    Subtitle: schema({ start: number, end: number, text: str, style: ref("SubtitleStyle"), shift: {type: "number", minimum: -86400, maximum: 86400, default: 0} }, [
      "start",
      "end",
      "text",
    ]),
    Voiceover: schema(
      {
        source_id: str,
        start: { type: "number", minimum: 0 },
        volume: { type: "number", minimum: 0, maximum: 2, default: 1 },
      },
      ["source_id", "start"],
    ),
    Edit: schema(
      {
        revision: { type: "integer", minimum: 1 },
        clips: { type: "array", maxItems: 64, items: ref("Clip") },
        subtitles: {
          type: "object",
          additionalProperties: {
            type: "array",
            maxItems: 10000,
            items: ref("Subtitle"),
          },
        },
        voiceovers: {
          anyOf: [
            { type: "array", maxItems: 32, items: ref("Voiceover") },
            { type: "null" },
          ],
        },
        title: { anyOf: [str, { type: "null" }] },
      },
      ["revision", "clips", "subtitles"],
    ),
    Transcription: schema(
      {
        source_id: str,
        language: {
          type: "string",
          enum: ["auto", "Chinese", "English"],
          default: "auto",
        },
      },
      ["source_id"],
    ),
    Export: schema({ burn_subtitles: { type: "boolean", default: true }, ...exportSchema }, []),
  };
  const paths = {};
  for (const [method, url, summary] of ROUTES) {
    const operation = {
      summary,
      parameters: [...url.matchAll(/\{([^}]+)\}/g)].map((m) => ({
        name: m[1],
        in: "path",
        required: true,
        schema: { type: "string" },
      })),
      responses: {
        200: { description: "Success" },
        400: { description: "Invalid request" },
        409: { description: "Revision conflict" },
      },
    };
    if (method === "post" || method === "patch" || method === "delete") {
      const name =
        method === "delete" ? "RemoveSource" : method === "patch"
          ? "Edit"
          : url === "/api/projects"
            ? "NewProject"
            : url.endsWith("/import")
              ? "ImportPath"
              : url.endsWith("/transcribe")
                ? "Transcription"
                : "Export";
      const multipart = url.endsWith("/upload");
      operation.requestBody = {
        required: true,
        content: multipart
          ? {
              "multipart/form-data": {
                schema: schema({ file: { type: "string", format: "binary" } }, [
                  "file",
                ]),
              },
            }
          : { "application/json": { schema: ref(name) } },
      };
      if (method === "post") {
        delete operation.responses[200];
        operation.responses[
          url.endsWith("/transcribe") || url.endsWith("/export") ? 202 : 201
        ] = { description: "Success" };
      }
    }
    (paths[url] ??= {})[method] = operation;
  }
  return {
    openapi: "3.1.0",
    info: { title: "cutccc Node.js local API", version: "0.3.0" },
    paths,
    components: { schemas },
  };
}
export async function startServer(options = {}) {
  const studio = await Studio.create(options);
  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host || "";
      if (!/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(host))
        fail("Invalid host", 400);
      if (req.headers.origin) {
        let origin;
        try {
          origin = new URL(req.headers.origin);
        } catch {
          fail("Cross-origin requests are not allowed", 403);
        }
        if (
          !["http:", "https:"].includes(origin.protocol) ||
          origin.host !== host
        )
          fail("Cross-origin requests are not allowed", 403);
      }
      const url = new URL(req.url, "http://" + host),
        route = url.pathname,
        method = req.method;
      if (
        (method === "GET" || method === "HEAD") &&
        (route === "/" || route === "/api-docs" || route.startsWith("/static/"))
      ) {
        const name =
          route === "/"
            ? "index.html"
            : route === "/api-docs"
              ? "api.html"
              : route.slice(8);
        if (
          ![
            "index.html",
            "api.html",
            "app.js",
            "subtitle-style.js",
            "edit-history.js",
            "export-options.js",
            "caption-timing.js",
            "style.css",
            "api-docs.js",
          ].includes(name)
        )
          fail("File not found", 404);
        await sendFile(req, res, path.join(WEB, name));
        return;
      }
      if (method === "GET" && route === "/openapi.json") {
        json(res, 200, openapi());
        return;
      }
      if (method === "GET" && route === "/api/health") {
        let ready = true;
        try {
          await validateModels(studio.models);
        } catch {
          ready = false;
        }
        json(res, 200, {
          status: "ok",
          version: "0.3.0",
          runtime: "nodejs",
          inference_runtime: "python",
          models_ready: ready,
        });
        return;
      }
      if (route === "/api/projects") {
        if (method === "GET") {
          json(res, 200, { projects: await studio.listProjects() });
          return;
        }
        if (method === "POST") {
          const b = object(await body(req), ["title"]);
          json(res, 201, await studio.createProject(b.title));
          return;
        }
      }
      let m = /^\/api\/projects\/([^/]+)(?:\/(.*))?$/.exec(route);
      if (m) {
        const [, id, rest] = m;
        if (!rest && method === "GET") {
          json(res, 200, await studio.getProject(id));
          return;
        }
        if (!rest && method === "PATCH") {
          json(
            res,
            200,
            await studio.updateEdit(id, editBody(await body(req))),
          );
          return;
        }
        if (rest === "sources/import" && method === "POST") {
          const b = object(await body(req), ["path"], ["path"]);
          if (typeof b.path !== "string" || !b.path)
            fail("path must be a nonempty string", 422);
          json(res, 201, await studio.importPath(id, b.path));
          return;
        }
        if (rest === "sources/upload" && method === "POST") {
          await studio.getProject(id);
          const file = await upload(req, path.join(studio.root, "uploads"));
          try {
            json(res, 201, await studio.importPath(id, file.temp, file.name));
          } finally {
            await fs.unlink(file.temp).catch(() => {});
          }
          return;
        }
        const removeSource = /^sources\/([^/]+)$/.exec(rest || "");
        if (removeSource && method === "DELETE") {
          const b = object(await body(req), ["revision"], ["revision"]);
          if (!Number.isInteger(b.revision) || b.revision < 1) fail("revision must be a positive integer", 422);
          json(res, 200, await studio.removeSource(id, removeSource[1], b.revision));
          return;
        }
        const waveform = /^sources\/([^/]+)\/waveform$/.exec(rest || "");
        if (waveform && method === "GET") {
          json(res, 200, await studio.waveform(id, waveform[1]));
          return;
        }
        const spectrum = /^sources\/([^/]+)\/spectrogram$/.exec(rest || "");
        if (spectrum && (method === "GET" || method === "HEAD")) {
          await sendFile(req, res, await studio.spectrogram(id, spectrum[1], url.searchParams.get("tile") ?? "overview"));
          return;
        }
        const media = /^sources\/([^/]+)\/(media|poster)$/.exec(rest || "");
        if (media && (method === "GET" || method === "HEAD")) {
          await sendFile(
            req,
            res,
            await studio.sourcePath(id, media[1], {
              poster: media[2] === "poster",
              preview: media[2] === "media",
            }),
          );
          return;
        }
        if (rest === "jobs" && method === "GET") {
          json(res, 200, { jobs: await studio.listJobs(id) });
          return;
        }
        if (rest === "transcribe" && method === "POST") {
          const b = object(
            await body(req),
            ["source_id", "language"],
            ["source_id"],
          );
          json(res, 202, await studio.submit(id, "transcribe", b));
          return;
        }
        if (rest === "export" && method === "POST") {
          const b = object(await body(req), ["burn_subtitles", ...Object.keys(exportSchema)]);
          if (
            b.burn_subtitles !== undefined &&
            typeof b.burn_subtitles !== "boolean"
          )
            fail("burn_subtitles must be a boolean", 422);
          json(res, 202, await studio.submit(id, "export", b));
          return;
        }
      }
      m =
        /^\/api\/jobs\/([^/]+)(?:\/(video|subtitles|styled-subtitles|log|review|transcript))?$/.exec(
          route,
        );
      if (m && (method === "GET" || method === "HEAD")) {
        if (!m[2]) {
          json(res, 200, await studio.getJob(m[1]));
          return;
        }
        const names = {
          video: ["video.mp4", "cutccc-export.mp4"],
          subtitles: ["subtitles.srt", "subtitles.srt"],
          "styled-subtitles": ["subtitles.ass", "subtitles.ass"],
          log: ["process.log", null],
          review: ["review.txt", "recognition-review.txt"],
          transcript: ["transcript.txt", "transcript.txt"],
        };
        const [file, name] = names[m[2]];
        await sendFile(req, res, await studio.jobFile(m[1], file), { name });
        return;
      }
      fail("Not found", 404);
    } catch (e) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const status =
        e instanceof APIError ? e.status : e.code === "ENOENT" ? 404 : 503;
      json(res, status, { detail: e.message });
    }
  });
  server.requestTimeout = 0;
  server.headersTimeout = 60000;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 18765, "127.0.0.1", resolve);
    });
  } catch (e) {
    await studio.close();
    throw e;
  }
  let closing;
  return {
    server,
    studio,
    url: `http://127.0.0.1:${server.address().port}`,
    close() {
      return (closing ??= (async () => {
        const stopped = new Promise((resolve) => server.close(resolve));
        server.closeAllConnections();
        await studio.close();
        await stopped;
      })());
    },
  };
}
