import asyncio
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from urllib.request import urlopen

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from cutccc.mcp_server import create_mcp
from cutccc.processes import stop_process


class MCPTests(unittest.TestCase):
    def test_remote_urls_are_rejected(self):
        for url in ["https://example.com", "http://0.0.0.0:1234", "http://user@localhost:1234", "http://localhost:1234/other"]:
            with self.assertRaises(ValueError):
                create_mcp(url)

    def test_stdio_client_talks_to_same_http_project(self):
        with tempfile.TemporaryDirectory() as tmp:
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0));port=sock.getsockname()[1]
            base=f"http://127.0.0.1:{port}"
            with (Path(tmp)/"server.log").open("w",encoding="utf-8") as log:
                process=subprocess.Popen([sys.executable,"-m","cutccc","serve","--port",str(port),"--data-dir",str(Path(tmp)/"data"),"--models-dir",str(Path(tmp)/"models")],
                    stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW if os.name=="nt" else 0)
                try:
                    deadline=time.monotonic()+20
                    while time.monotonic()<deadline:
                        try:
                            with urlopen(base+"/api/health",timeout=1):break
                        except OSError:time.sleep(.1)
                    else:self.fail("API did not start")
                    asyncio.run(self.exercise(base))
                finally:
                    stop_process(process)

    async def exercise(self,base):
        params=StdioServerParameters(command=sys.executable,args=["-m","cutccc","mcp","--api-url",base])
        async with stdio_client(params) as (read,write):
            async with ClientSession(read,write) as session:
                await session.initialize()
                tools=await session.list_tools()
                names={t.name for t in tools.tools}
                self.assertTrue({"create_project","import_video","update_edit","export_video","get_job"}<=names)
                result=await session.call_tool("create_project",{"title":"MCP test"})
                self.assertFalse(result.isError)
                data=json.loads(result.content[0].text)
                with urlopen(base+"/api/projects/"+data["id"]) as r:
                    same=json.load(r)
                self.assertEqual(same["title"],"MCP test")
                result=await session.call_tool("update_edit",dict(project_id=data["id"],revision=data["revision"],clips=[],subtitles={},title="Updated through MCP"))
                self.assertFalse(result.isError)
                stale=await session.call_tool("update_edit",dict(project_id=data["id"],revision=data["revision"],clips=[],subtitles={}))
                self.assertTrue(stale.isError)
                health=await session.read_resource("cutccc://status")
                self.assertIn('"status": "ok"',health.contents[0].text)


if __name__=="__main__":unittest.main()
