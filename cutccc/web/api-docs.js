"use strict";
document.getElementById("apiOrigin").textContent = location.origin;
document.getElementById("mcpConfig").textContent = JSON.stringify(
  {
    mcpServers: {
      cutccc: {
        command: "/path/to/venv/python",
        args: ["-m", "cutccc", "mcp", "--api-url", location.origin],
      },
    },
  },
  null,
  2,
);
fetch("/openapi.json")
  .then((r) => r.json())
  .then((spec) => {
    const list = document.getElementById("endpointList");
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, info] of Object.entries(methods)) {
        const row = document.createElement("div");
        row.style.cssText =
          "display:flex;gap:16px;align-items:center;padding:14px 0;border-bottom:1px solid #2a3435;flex-wrap:wrap";
        const verb = document.createElement("strong");
        verb.textContent = method.toUpperCase();
        verb.style.cssText = "font:11px monospace;color:#aff2bd;width:55px";
        const route = document.createElement("code");
        route.textContent = path;
        route.style.fontSize = "12px";
        const description = document.createElement("span");
        description.textContent = info.summary || "";
        description.className = "muted";
        description.style.marginLeft = "auto";
        row.append(verb, route, description);
        list.append(row);
      }
    }
  })
  .catch(() => {
    document.getElementById("endpointList").textContent =
      "暂时无法读取 API 定义。";
  });
