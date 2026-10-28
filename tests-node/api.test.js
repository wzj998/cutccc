import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { startServer } from "../cutccc/node/server.js";
import { Studio } from "../cutccc/node/studio.js";
import { capture } from "../cutccc/node/processes.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const hasFFmpeg =
  spawnSync("ffmpeg", ["-version"], { windowsHide: true }).status === 0;
const hasPython =
  spawnSync("python", ["--version"], { windowsHide: true }).status === 0;
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cutccc-node-test-"));
  const app = await startServer({
    port: 0,
    dataDir: path.join(root, "data"),
    modelsDir: path.join(root, "models"),
  });
  t.after(async () => {
    await app.close();
    assert.ok(root.startsWith(path.join(os.tmpdir(), "cutccc-node-test-")));
    await fs.rm(root, { recursive: true, force: true });
  });
  async function request(route, method = "GET", value, headers = {}) {
    const r = await fetch(app.url + route, {
      method,
      headers: {
        ...(value === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      body: value === undefined ? undefined : JSON.stringify(value),
    });
    return { status: r.status, body: await r.json() };
  }
  return { ...app, root, request };
}
async function fakeSource(f) {
  const p = await f.studio.createProject("Example"),
    sid = randomUUID().replaceAll("-", "");
  p.sources = [
    {
      id: sid,
      name: "example.mp4",
      file: sid + ".mp4",
      subtitle_version: 0,
      duration: 10,
      width: 320,
      height: 180,
      has_audio: true,
    },
  ];
  p.clips = [{ source_id: sid, start: 0, end: 10 }];
  p.subtitles = { [sid]: [] };
  await fs.writeFile(
    f.studio.projectDir(p.id, "media", sid + ".mp4"),
    "test-video",
  );
  await f.studio.save(p);
  return p;
}
async function waitJob(f, id) {
  for (let i = 0; i < 400; i++) {
    const j = await f.studio.getJob(id);
    if (["completed", "failed"].includes(j.status)) return j;
    await wait(50);
  }
  throw new Error("Job did not finish");
}
test("separated audio ranges and muted video persist through HTTP with strict validation",async t=>{
  const f=await fixture(t),p=await fakeSource(f),sid=p.sources[0].id;
  const edit={revision:p.revision,clips:[{source_id:sid,start:0,end:2,muted:true,audio_link:'pair'}],
    subtitles:p.subtitles,voiceovers:[{source_id:sid,start:0,source_start:3,source_end:4,volume:1,detached:true,link_id:'pair'}]};
  const saved=await f.request('/api/projects/'+p.id,'PATCH',edit);assert.equal(saved.status,200);
  assert.equal(saved.body.clips[0].muted,true);assert.equal(saved.body.voiceovers[0].source_start,3);
  const invalid=await f.request('/api/projects/'+p.id,'PATCH',{...edit,revision:saved.body.revision,voiceovers:[{...edit.voiceovers[0],source_end:20}]});
  assert.equal(invalid.status,400);
  const audioOnly=await f.request('/api/projects/'+p.id,'PATCH',{...edit,revision:saved.body.revision,clips:[]});assert.equal(audioOnly.status,200);
  const reloaded=await f.request('/api/projects/'+p.id);assert.equal(reloaded.body.voiceovers[0].source_end,4);
});

test("export API selects 60 fps without changing cut or subtitle clocks", { skip: !hasFFmpeg }, async t => {
  const f = await fixture(t);
  const input = path.join(f.root, "fps.mp4");
  await capture("ffmpeg", ["-v","error","-f","lavfi","-i","testsrc2=s=640x360:r=60:d=2","-c:v","libx264",input]);
  let p = await f.studio.createProject("60 fps");
  p = await f.studio.importPath(p.id, input);
  const sid = p.sources[0].id;
  p = await f.studio.updateEdit(p.id, {revision:p.revision,clips:[{source_id:sid,start:0.1,end:1.12},{source_id:sid,start:1.2,end:1.8}],subtitles:{[sid]:[{start:0.3,end:0.7,text:"Same clock"}]}});
  for (const options of [{fps:24},{resolution:"8k"},{quality:"bad"}])
    assert.equal((await f.request(`/api/projects/${p.id}/export`,"POST",options)).status,422);
  const submit = await f.request(`/api/projects/${p.id}/export`,"POST",{fps:60,resolution:"480p",quality:"balanced"});
  assert.equal(submit.status,202);
  const done = await waitJob(f,submit.body.id);
  assert.equal(done.status,"completed",done.message);
  assert.equal(done.result.fps,60);
  assert.equal(done.result.width,640);
  const data = JSON.parse((await capture("ffprobe",["-v","error","-show_streams","-of","json",await f.studio.jobFile(done.id,"video.mp4")])).stdout);
  assert.equal(Number(data.streams.find(s=>s.codec_type==="video").nb_frames),98);
  assert.match(await fs.readFile(await f.studio.jobFile(done.id,"subtitles.srt"),"utf8"),/00:00:00,200 --> 00:00:00,600/);
  assert.deepEqual((await f.studio.getProject(p.id)).subtitles,p.subtitles);
});
test("atomic JSON replacement retries transient locks without losing previous data", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.root, "atomic.json");
  await f.studio.write(file, { value: 1 });
  const rename = fs.rename.bind(fs);
  let attempts = 0,
    mode = "transient";
  t.mock.method(fs, "rename", async (from, to) => {
    if (to !== file) return rename(from, to);
    attempts++;
    if (mode === "transient" && attempts > 2) return rename(from, to);
    assert.equal(
      JSON.parse(await fs.readFile(file, "utf8")).value,
      mode === "transient" ? 1 : 2,
    );
    throw Object.assign(new Error("simulated rename failure"), {
      code: mode === "disk" ? "ENOSPC" : "EPERM",
    });
  });
  await f.studio.write(file, { value: 2 });
  assert.equal(attempts, 3);
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).value, 2);
  mode = "persistent";
  attempts = 0;
  await assert.rejects(f.studio.write(file, { value: 3 }), { code: "EPERM" });
  assert.equal(attempts, 6);
  mode = "disk";
  attempts = 0;
  await assert.rejects(f.studio.write(file, { value: 3 }), { code: "ENOSPC" });
  assert.equal(attempts, 1);
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).value, 2);
  assert.ok(
    !(await fs.readdir(f.root)).some(
      (name) => name.startsWith("atomic.json.") && name.endsWith(".tmp"),
    ),
  );
});
async function models(root) {
  for (const n of ["Qwen3-ASR-1.7B", "Qwen3-ForcedAligner-0.6B"]) {
    const dir = path.join(root, n);
    await fs.mkdir(dir, { recursive: true });
    for (const file of [
      "config.json",
      "preprocessor_config.json",
      "tokenizer_config.json",
      "vocab.json",
      "merges.txt",
      "model.safetensors",
    ])
      await fs.writeFile(path.join(dir, file), "{}");
  }
}
test("health, UI, schema and local-origin protections", async (t) => {
  const f = await fixture(t),
    h = await f.request("/api/health");
  assert.equal(h.body.runtime, "nodejs");
  assert.equal(h.body.models_ready, false);
  assert.match(await (await fetch(f.url)).text(), /本地剪辑工作台/);
  assert.ok((await f.request("/openapi.json")).body.paths["/api/projects"]);
  assert.equal(
    (
      await f.request(
        "/api/projects",
        "POST",
        {},
        { Origin: "https://unrelated.invalid" },
      )
    ).status,
    403,
  );
  assert.equal(
    (await f.request("/api/projects", "POST", { unknown: 1 })).status,
    422,
  );
  assert.equal((await f.request("/api/projects/not-an-id")).status, 400);
  assert.equal((await f.request("/api/jobs/" + "a".repeat(32))).status, 404);
});
test("simultaneous saves cannot overwrite revisions; invalid changes are atomic", async (t) => {
  const f = await fixture(t),
    p = await fakeSource(f),
    id = p.sources[0].id;
  const edit = {
    revision: p.revision,
    clips: [{ source_id: id, start: 1, end: 3 }],
    subtitles: { [id]: [{ start: 1, end: 2, text: "字幕" }] },
  };
  const results = await Promise.all([
    f.request(`/api/projects/${p.id}`, "PATCH", edit),
    f.request(`/api/projects/${p.id}`, "PATCH", edit),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const current = await f.studio.getProject(p.id);
  assert.equal(current.sources[0].subtitle_version, 1);
  assert.equal(
    (
      await f.request(`/api/projects/${p.id}`, "PATCH", {
        ...edit,
        revision: current.revision,
        clips: [{ source_id: id, start: 3, end: 2 }],
      })
    ).status,
    400,
  );
  assert.equal((await f.studio.getProject(p.id)).revision, current.revision);
});
test("Range, suffix, HEAD and optional browser proxies preserve originals", async (t) => {
  const f = await fixture(t),
    p = await fakeSource(f),
    id = p.sources[0].id,
    url = `${f.url}/api/projects/${p.id}/sources/${id}/media`;
  let r = await fetch(url, { headers: { Range: "bytes=0-3" } });
  assert.equal(r.status, 206);
  assert.equal(await r.text(), "test");
  r = await fetch(url, { headers: { Range: "bytes=-5" } });
  assert.equal(await r.text(), "video");
  assert.equal(
    (await fetch(url, { headers: { Range: "bytes=100-200" } })).status,
    416,
  );
  assert.equal(
    (await fetch(url, { method: "HEAD" })).headers.get("content-length"),
    "10",
  );
  await fs.writeFile(
    f.studio.projectDir(p.id, "media", id + ".preview.mp4"),
    "preview",
  );
  assert.equal(await (await fetch(url)).text(), "preview");
  assert.equal(
    await fs.readFile(await f.studio.sourcePath(p.id, id), "utf8"),
    "test-video",
  );
});
test("data directory locking and restart recovery retain existing project JSON", async (t) => {
  const f = await fixture(t),
    p = await fakeSource(f);
  await assert.rejects(
    Studio.create({ dataDir: f.studio.root }),
    /already used/,
  );
  const id = "b".repeat(32);
  await fs.mkdir(f.studio.jobDir(id));
  await f.studio.write(f.studio.jobDir(id, "job.json"), {
    id,
    project_id: p.id,
    status: "running",
  });
  await f.close();
  const reopened = await Studio.create({ dataDir: f.studio.root });
  assert.equal((await reopened.getJob(id)).status, "failed");
  assert.equal((await reopened.getProject(p.id)).title, p.title);
  await reopened.close();
});
test("duplicate transcription and concurrent manual edits are protected", async (t) => {
  const f = await fixture(t),
    p = await fakeSource(f),
    id = p.sources[0].id;
  await models(f.studio.models);
  let release, started;
  const gate = new Promise((r) => {
      release = r;
    }),
    ready = new Promise((r) => {
      started = r;
    });
  f.studio.runProcess = async (jid, cmd, args, folder) => {
    started();
    await gate;
    await fs.mkdir(path.join(folder, "transcription"));
    await fs.writeFile(
      path.join(folder, "transcription", "result.json"),
      JSON.stringify({
        duration_seconds: 10,
        cues: [{ start: 0, end: 1, text: "generated" }],
      }),
    );
  };
  const j = await f.studio.submit(p.id, "transcribe", { source_id: id });
  await ready;
  await assert.rejects(
    f.studio.submit(p.id, "transcribe", { source_id: id }),
    /already active/,
  );
  try {
    await f.studio.updateEdit(p.id, {
      revision: p.revision,
      clips: p.clips,
      subtitles: { [id]: [{ start: 0, end: 1, text: "manual" }] },
    });
  } finally {
    release();
  }
  assert.match((await waitJob(f, j.id)).message, /edited during transcription/);
  assert.equal(
    (await f.studio.getProject(p.id)).subtitles[id][0].text,
    "manual",
  );
});
test(
  "actual Python worker JSON events and result files update a Node-owned job",
  { skip: !hasPython },
  async (t) => {
    const f = await fixture(t),
      p = await fakeSource(f),
      sid = p.sources[0].id;
    await models(f.studio.models);
    const script = path.join(f.root, "worker.py");
    await fs.writeFile(
      script,
      `import json,pathlib\nprint(json.dumps({'stage':'loading_asr','chunks':1}),flush=True)\nprint(json.dumps({'stage':'transcribed','index':0}),flush=True)\nprint(json.dumps({'stage':'loading_aligner'}),flush=True)\nprint(json.dumps({'stage':'aligned','index':0}),flush=True)\np=pathlib.Path('transcription');p.mkdir();(p/'result.json').write_text(json.dumps({'duration_seconds':10,'cues':[{'start':1,'end':2,'text':'worker result'}]}),encoding='utf-8')\n`,
    );
    const run = f.studio.runProcess.bind(f.studio);
    f.studio.runProcess = (jid, command, args, folder, duration) => {
      assert.equal(args[2], "cutccc");
      return run(jid, "python", [script], folder, duration);
    };
    const job = await f.studio.submit(p.id, "transcribe", { source_id: sid }),
      done = await waitJob(f, job.id);
    assert.equal(done.status, "completed", done.message);
    assert.equal(done.result.subtitle_count, 1);
    assert.equal(
      (await f.studio.getProject(p.id)).subtitles[sid][0].text,
      "worker result",
    );
    assert.match(
      await fs.readFile(f.studio.jobDir(job.id, "process.log"), "utf8"),
      /loading_asr/,
    );
  },
);
test("recognition language and review downloads preserve original English", async (t) => {
  const f = await fixture(t),
    p = await fakeSource(f),
    sid = p.sources[0].id;
  await models(f.studio.models);
  let release, started;
  const gate = new Promise((resolve) => {
      release = resolve;
    }),
    ready = new Promise((resolve) => {
      started = resolve;
    });
  f.studio.runProcess = async (jid, command, args, folder) => {
    assert.equal(args.at(-2), "--language");
    assert.equal(args.at(-1), "English");
    started();
    await gate;
    const out = path.join(folder, "transcription");
    await fs.mkdir(out);
    await fs.writeFile(
      path.join(out, "result.json"),
      JSON.stringify({
        duration_seconds: 10,
        language: "English",
        review_count: 1,
        cues: [{ start: 1, end: 3, text: "Please be extra careful." }],
      }),
    );
    await fs.writeFile(
      path.join(out, "subtitles.srt"),
      "Please be extra careful.",
    );
    await fs.writeFile(
      path.join(out, "transcript.txt"),
      "Please be extra careful.",
    );
    await fs.writeFile(
      path.join(out, "review.txt"),
      "00:00:04,000 – 00:00:06,000: unclear speech",
    );
  };
  const submitted = await f.request(
    `/api/projects/${p.id}/transcribe`,
    "POST",
    { source_id: sid, language: "English" },
  );
  assert.equal(submitted.status, 202);
  await ready;
  assert.equal(
    (await fetch(f.url + `/api/jobs/${submitted.body.id}/review`)).status,
    400,
  );
  release();
  const job = await waitJob(f, submitted.body.id);
  assert.equal(job.status, "completed", job.message);
  assert.equal(job.language, "English");
  assert.equal(job.result.review_count, 1);
  assert.equal(
    (await f.studio.getProject(p.id)).subtitles[sid][0].text,
    "Please be extra careful.",
  );
  assert.match(
    await (await fetch(f.url + job.result.review_url)).text(),
    /00:00:04,000/,
  );
  assert.equal(
    await (await fetch(f.url + job.result.transcript_url)).text(),
    "Please be extra careful.",
  );
  assert.equal(
    await (await fetch(f.url + job.result.subtitles_url)).text(),
    "Please be extra careful.",
  );
  assert.equal((await fetch(f.url + `/api/jobs/${job.id}/video`)).status, 400);
  assert.equal(
    (
      await f.request(`/api/projects/${p.id}/transcribe`, "POST", {
        source_id: sid,
        language: "unsupported",
      })
    ).status,
    400,
  );
});
test("styled subtitles persist, export to ASS and render at independent positions", {skip: !hasFFmpeg}, async (t) => {
  const f = await fixture(t);
  let p = await f.studio.createProject("Subtitle style export");
  const file = path.join(f.root, "black.mp4");
  await capture("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=black:s=360x640:r=30:d=1.6", "-c:v", "libx264", file]);
  p = await f.studio.importPath(p.id, file);
  const sid = p.sources[0].id;
  const cues = [
    {start: .1, end: .7, text: "Narration", shift: .2, style: {fontFamily: "Arial", fontSize: 64, color: "#ffff00", position: "top-center"}},
    {start: .9, end: 1.5, text: "Dialogue", style: {fontFamily: "Arial", fontSize: 64, color: "#ffffff", position: "bottom-center"}},
  ];
  const saved = await f.request(`/api/projects/${p.id}`, "PATCH", {revision: p.revision, clips: p.clips, subtitles: {[sid]: cues}});
  assert.equal(saved.status, 200);
  p = saved.body;
  assert.deepEqual((await f.studio.getProject(p.id)).subtitles[sid], cues);
  const bad = await f.request(`/api/projects/${p.id}`, "PATCH", {revision: p.revision, clips: p.clips, subtitles: {[sid]: [{...cues[0], style: {fontSize: 500}}]}});
  assert.equal(bad.status, 400);
  assert.equal((await f.studio.getProject(p.id)).revision, p.revision);
  const job = await f.studio.submit(p.id, "export");
  const done = await waitJob(f, job.id);
  assert.equal(done.status, "completed", done.message);
  const ass = await fetch(f.url + done.result.styled_subtitles_url);
  assert.equal(ass.status, 200);
  const styledText = await ass.text();
  assert.match(styledText, /Style: Cue0,Arial/);
  assert.match(styledText, /0:00:00\.30,0:00:00\.90/);
  const video = await f.studio.jobFile(job.id, "video.mp4");
  for (const [at, top] of [[.8, true], [1.1, false]]) {
    const pixels = spawnSync("ffmpeg", ["-v", "error", "-ss", String(at), "-i", video, "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], {windowsHide: true, maxBuffer: 2 * 1024 * 1024});
    assert.equal(pixels.status, 0, pixels.stderr.toString());
    const ys = [];
    for (let n = 0; n < pixels.stdout.length; n += 3) {
      const [r,g,b] = pixels.stdout.subarray(n,n+3);
      if (top ? r > 140 && g > 140 && b < 100 : r > 170 && g > 170 && b > 170) ys.push(Math.floor(n / 3 / 360));
    }
    assert.ok(ys.length > 50, "subtitle glyphs must be present");
    assert.ok(top ? Math.max(...ys) < 210 : Math.min(...ys) > 420, "each cue must use its own vertical position");
  }
  assert.equal((await fetch(f.url + "/static/subtitle-style.js")).status, 200);
});

test("independent pasted captions survive HTTP save and render at their pasted time", {skip: !hasFFmpeg}, async t => {
  const f=await fixture(t),file=path.join(f.root,'copy.mp4');
  await capture('ffmpeg',['-v','error','-f','lavfi','-i','color=black:s=320x180:r=30:d=1.4','-c:v','libx264',file]);
  let p=await f.studio.createProject('Clipboard export');p=await f.studio.importPath(p.id,file);
  const sid=p.sources[0].id;
  const cues=[{start:.1,end:.3,text:'Original'},{start:.1,end:.3,text:'Copied',timeline_offset:.6,style:{fontFamily:'Arial',fontSize:80,color:'#ff00ff',position:'middle-center'}}];
  const saved=await f.request(`/api/projects/${p.id}`,'PATCH',{revision:p.revision,clips:p.clips,subtitles:{[sid]:cues}});
  assert.equal(saved.status,200,JSON.stringify(saved.body));
  assert.deepEqual((await f.studio.getProject(p.id)).subtitles[sid],cues);
  const done=await waitJob(f,(await f.studio.submit(p.id,'export')).id);
  assert.equal(done.status,'completed',done.message);
  assert.match(await fs.readFile(await f.studio.jobFile(done.id,'subtitles.srt'),'utf8'),/00:00:00,700 --> 00:00:00,900\nCopied/);
  const pixels=spawnSync('ffmpeg',['-v','error','-ss','0.8','-i',await f.studio.jobFile(done.id,'video.mp4'),'-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'],{windowsHide:true,maxBuffer:1024*1024});
  assert.equal(pixels.status,0,pixels.stderr.toString());
  let magenta=0;for(let n=0;n<pixels.stdout.length;n+=3)if(pixels.stdout[n]>100&&pixels.stdout[n+1]<100&&pixels.stdout[n+2]>100)magenta++;
  assert.ok(magenta>25,'copied caption must be burned into the requested frame');
});

test("recognition refresh retains independently pasted subtitle copies", async t => {
  const f=await fixture(t);let p=await fakeSource(f);const sid=p.sources[0].id;
  await models(f.studio.models);
  const copy={start:1,end:2,text:'Manual copy',timeline_offset:4,style:{fontSize:40}};
  p=await f.studio.updateEdit(p.id,{revision:p.revision,clips:p.clips,subtitles:{[sid]:[copy]}});
  f.studio.runProcess=async(jid,cmd,args,folder)=>{
    await fs.mkdir(path.join(folder,'transcription'));
    await fs.writeFile(path.join(folder,'transcription/result.json'),JSON.stringify({duration_seconds:10,cues:[{start:1,end:3,text:'Recognized'}]}));
  };
  const done=await waitJob(f,(await f.studio.submit(p.id,'transcribe',{source_id:sid})).id);
  assert.equal(done.status,'completed',done.message);
  assert.deepEqual((await f.studio.getProject(p.id)).subtitles[sid],[{start:1,end:3,text:'Recognized'},copy]);
});

test("open export folder only accepts completed export jobs and no caller paths",async t=>{
 const f=await fixture(t),p=await fakeSource(f),id=randomUUID().replaceAll('-','');
 await fs.mkdir(f.studio.jobDir(id));
 const job={id,project_id:p.id,kind:'export',status:'completed'};
 await f.studio.write(f.studio.jobDir(id,'job.json'),job);
 await fs.writeFile(f.studio.jobDir(id,'video.mp4'),'test export');
 const opened=[];f.studio.openFolder=async folder=>opened.push(folder);
 const route=`/api/jobs/${id}/open-folder`;
 assert.equal((await f.request(route,'GET')).status,404);
 assert.equal((await f.request(route,'POST',{path:'C:/'})).status,422);
 assert.equal((await f.request(route,'POST',{}, {Origin:'https://unrelated.example'})).status,403);
 assert.equal(opened.length,0);
 assert.equal((await f.request(route,'POST',{})).status,200);
 assert.deepEqual(opened,[f.studio.jobDir(id)]);
 for(const changes of [{status:'running'},{status:'failed'},{kind:'transcribe'}]){
  await f.studio.write(f.studio.jobDir(id,'job.json'),{...job,...changes});
  assert.equal((await f.request(route,'POST',{})).status,400);
 }
 assert.equal(opened.length,1);
 await f.studio.write(f.studio.jobDir(id,'job.json'),job);
 await fs.unlink(f.studio.jobDir(id,'video.mp4'));
 assert.equal((await f.request(route,'POST',{})).status,404);
});

test("direct Feishu sample applies its budget, wraps long captions and leaves the edit intact",{skip:!hasFFmpeg},async t=>{
  const f=await fixture(t),file=path.join(f.root,'sample.mp4');
  await capture('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=s=360x640:r=60:d=1.4','-c:v','libx264',file]);
  let p=await f.studio.createProject('Sample preset');p=await f.studio.importPath(p.id,file);
  const sid=p.sources[0].id,text='这是一条用于验证飞书样片自动断行的长字幕，工程中的文字必须保持不变。';
  p=await f.studio.updateEdit(p.id,{revision:p.revision,clips:p.clips,subtitles:{[sid]:[{start:0,end:1.3,text}]}});
  const submit=await f.request(`/api/projects/${p.id}/export`,'POST',{preset:'feishu',fps:60,resolution:'2160p'});
  assert.equal(submit.status,202);assert.equal(submit.body.export_options.fps,30);
  const done=await waitJob(f,submit.body.id);assert.equal(done.status,'completed',done.message);
  assert.equal(done.result.fps,30);assert.equal(done.result.export_options.maxBytes,30_000_000);
  assert.ok(done.result.file_size<30_000_000);assert.equal(done.result.processing.attempts,1);
  assert.match(await fs.readFile(await f.studio.jobFile(done.id,'subtitles.ass'),'utf8'),/\\N/);
  assert.equal((await f.studio.getProject(p.id)).subtitles[sid][0].text,text);
});

test("unsupported GPU decode or scaling falls back to a working software path",{skip:!hasFFmpeg},async t=>{
  const oldHw=process.env.CUTCCC_EXPORT_HWACCEL,oldEncoder=process.env.CUTCCC_EXPORT_ENCODER,oldScale=process.env.CUTCCC_EXPORT_GPU_SCALE;
  process.env.CUTCCC_EXPORT_HWACCEL='cuda';process.env.CUTCCC_EXPORT_ENCODER='libx264';delete process.env.CUTCCC_EXPORT_GPU_SCALE;
  t.after(()=>{for(const [key,value] of [['CUTCCC_EXPORT_HWACCEL',oldHw],['CUTCCC_EXPORT_ENCODER',oldEncoder],['CUTCCC_EXPORT_GPU_SCALE',oldScale]]){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  const f=await fixture(t),file=path.join(f.root,'software-only.mkv');
  await capture('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=s=160x90:r=30:d=1','-c:v','ffv1',file]);
  let p=await f.studio.createProject('Fallback');p=await f.studio.importPath(p.id,file);
  const done=await waitJob(f,(await f.studio.submit(p.id,'export')).id);
  assert.equal(done.status,'completed',done.message);assert.equal(done.result.processing.gpu_scaled_clips,0);
  const plan=JSON.parse(await fs.readFile(f.studio.jobDir(done.id,'render-plan.json'),'utf8'));
  assert.ok(plan.clips[0].fallback);assert.equal(done.result.fps,30);
});

test("an oversize sample retries the original inputs with a lower budget",{skip:!hasFFmpeg},async t=>{
  const f=await fixture(t),file=path.join(f.root,'budget.mp4');
  await capture('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=s=160x90:r=30:d=1','-c:v','libx264',file]);
  let p=await f.studio.createProject('Size bound');p=await f.studio.importPath(p.id,file);
  const run=f.studio.runProcess.bind(f.studio),calls=[];
  f.studio.runProcess=async(...args)=>{
    calls.push(args[2]);await run(...args);
    if(calls.length===1)await fs.appendFile(path.join(args[3],'video.mp4'),Buffer.alloc(30_000_000));
  };
  const done=await waitJob(f,(await f.studio.submit(p.id,'export',{preset:'feishu'})).id);
  assert.equal(done.status,'completed',done.message);assert.equal(done.result.processing.attempts,2);
  assert.ok(done.result.file_size<30_000_000);assert.ok(done.result.export_options.bitrate<2500);
  assert.equal(calls[0][calls[0].indexOf('-i')+1],calls[1][calls[1].indexOf('-i')+1]);
});

test("waveform API extracts real audio once, caches it and preserves the project", {skip: !hasFFmpeg}, async (t) => {
  const f = await fixture(t);
  let p = await f.studio.createProject("Waveform cache");
  const file = path.join(f.root, "signal.mp4");
  await capture("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=black:s=160x90:r=30:d=1",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=8000:duration=1",
    "-af", "volume=0:enable='lt(t,0.5)'", "-c:v", "libx264", "-c:a", "aac", "-t", "1", file]);
  p = await f.studio.importPath(p.id, file);
  const sid = p.sources[0].id, url = `/api/projects/${p.id}/sources/${sid}/waveform`;
  const [a, b] = await Promise.all([f.request(url), f.request(url)]);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.deepEqual(a.body, b.body);
  assert.equal(a.body.peaks_per_second, 100);
  assert.ok(a.body.peaks.length >= 99 && a.body.peaks.length <= 103);
  assert.ok(Math.max(...a.body.peaks.slice(0, 30)) < .005);
  assert.ok(Math.max(...a.body.peaks.slice(65, 90)) > .05);
  assert.equal((await f.studio.getProject(p.id)).revision, p.revision);
  const cache = f.studio.projectDir(p.id, "waveforms", sid + ".json");
  const before = (await fs.stat(cache)).mtimeMs;
  assert.deepEqual((await f.request(url)).body, a.body);
  assert.equal((await fs.stat(cache)).mtimeMs, before);
  assert.equal(f.studio.waveformTasks.size, 0);
  assert.equal(f.studio.processes.size, 0);
  const source = await f.studio.sourcePath(p.id, sid);
  await fs.utimes(source, new Date(), new Date(Date.now() + 10000));
  assert.notEqual((await f.request(url)).body.fingerprint, a.body.fingerprint);
  await fs.writeFile(cache, "invalid cache");
  assert.equal((await f.request(url)).status, 200);
  assert.equal((await f.request(`/api/projects/${p.id}/sources/invalid/waveform`)).status, 400);
  const silent = path.join(f.root, "no-audio.mp4");
  await capture("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=blue:s=160x90:r=30:d=0.2", "-c:v", "libx264", silent]);
  p = await f.studio.importPath(p.id, silent);
  const noAudio = await f.request(`/api/projects/${p.id}/sources/${p.sources[1].id}/waveform`);
  assert.equal(noAudio.status, 200);
  assert.equal(noAudio.body.has_audio, false);
  assert.deepEqual(noAudio.body.peaks, []);
});

test("spectrogram images retain time and frequency ordering, cache and validate tile bounds", {skip: !hasFFmpeg}, async (t) => {
  const f = await fixture(t);
  let p = await f.studio.createProject("Frequency spectrum");
  const file = path.join(f.root, "tones.mp4");
  await capture("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=black:s=160x90:r=30:d=2",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000:duration=1",
    "-f", "lavfi", "-i", "sine=frequency=2000:sample_rate=16000:duration=1",
    "-filter_complex", "[1:a][2:a]concat=n=2:v=0:a=1[a]", "-map", "0:v", "-map", "[a]", "-c:v", "libx264", "-c:a", "aac", "-t", "2", file]);
  p = await f.studio.importPath(p.id, file);
  const sid = p.sources[0].id, url = `${f.url}/api/projects/${p.id}/sources/${sid}/spectrogram`;
  const responses = await Promise.all([fetch(url), fetch(url)]);
  assert.ok(responses.every(r => r.status === 200));
  assert.match(responses[0].headers.get("content-type"), /image\/png/);
  const images = await Promise.all(responses.map(async r => Buffer.from(await r.arrayBuffer())));
  assert.deepEqual(images[0], images[1]);
  assert.equal(images[0].readUInt32BE(16), 2048);
  const png = await f.studio.spectrogram(p.id, sid);
  const before = (await fs.stat(png)).mtimeMs;
  await f.studio.spectrogram(p.id, sid);
  assert.equal((await fs.stat(png)).mtimeMs, before);
  const raw = spawnSync("ffmpeg", ["-v", "error", "-i", png, "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], {windowsHide: true, maxBuffer: 4 * 1024 * 1024});
  assert.equal(raw.status, 0, raw.stderr.toString());
  const peakRow = x => {
    const scores = Array.from({length: 512}, (_, y) => {
      let value = 0;
      for (let offset = -5; offset <= 5; offset++) {
        const index = (y * 2048 + x + offset) * 3;
        value += raw.stdout[index] + raw.stdout[index + 1] + raw.stdout[index + 2];
      }
      return value;
    });
    return scores.indexOf(Math.max(...scores));
  };
  assert.ok(peakRow(512) > peakRow(1536) + 20, "low tone must be below high tone in their respective time intervals");
  for (const [x, hz] of [[512, 440], [1536, 2000]]) {
    const expectedRow = 511 * (1 - (hz - 80) / (8000 - 80));
    assert.ok(Math.abs(peakRow(x) - expectedRow) < 5, `frequency rows must match their calibrated frequencies: ${hz} Hz at ${peakRow(x)}, expected ${expectedRow}`);
  }
  const tile = await fetch(url + "?tile=0");
  assert.equal(tile.status, 200);
  assert.equal(Buffer.from(await tile.arrayBuffer()).readUInt32BE(16), 1024);
  assert.equal((await fetch(url + "?tile=1")).status, 400);
  assert.equal((await fetch(url + "?tile=..%2Fbad")).status, 400);
  assert.equal((await f.studio.getProject(p.id)).revision, p.revision);
  assert.equal(f.studio.waveformTasks.size, 0);
});

test("unused source removal respects revisions, usage and recoverable media", async (t) => {
  const f = await fixture(t);
  let p = await fakeSource(f);
  const sid = p.sources[0].id, file = await f.studio.sourcePath(p.id, sid);
  const url = `/api/projects/${p.id}/sources/${sid}`;
  assert.equal((await f.request(url, "DELETE", {revision: p.revision})).status, 400);
  p = await f.studio.updateEdit(p.id, {revision: p.revision, clips: [], subtitles: p.subtitles, voiceovers: []});
  assert.equal((await f.request(url, "DELETE", {revision: p.revision - 1})).status, 409);
  const removed = await f.request(url, "DELETE", {revision: p.revision});
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body.sources, []);
  assert.deepEqual(removed.body.subtitles, {});
  assert.ok((await fs.stat(file)).isFile());
});

test("shutdown terminates owned child processes and releases the project directory", async (t) => {
  const f = await fixture(t),
    p = await fakeSource(f),
    id = "e".repeat(32);
  await fs.mkdir(f.studio.jobDir(id));
  await f.studio.write(f.studio.jobDir(id, "job.json"), {
    id,
    project_id: p.id,
    status: "running",
    progress: 0,
  });
  const result = f.studio
    .runProcess(
      id,
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      f.studio.jobDir(id),
    )
    .catch((e) => e);
  await wait(40);
  const child = [...f.studio.processes][0];
  assert.ok(child?.pid);
  await f.close();
  await result;
  assert.throws(() => process.kill(child.pid, 0));
  const reopened = await Studio.create({ dataDir: f.studio.root });
  await reopened.close();
});
test(
  "multipart import streams real video and rejects incomplete uploads",
  { skip: !hasFFmpeg },
  async (t) => {
    const f = await fixture(t),
      p = await f.studio.createProject("Upload"),
      file = path.join(f.root, "source.mp4");
    await capture("ffmpeg", [
      "-nostdin",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=red:s=160x90:r=30:d=0.2",
      "-c:v",
      "libx264",
      file,
    ]);
    const form = new FormData();
    form.append("file", new Blob([await fs.readFile(file)]), "sample.mp4");
    const r = await fetch(`${f.url}/api/projects/${p.id}/sources/upload`, {
      method: "POST",
      body: form,
    });
    assert.equal(r.status, 201, await r.clone().text());
    assert.equal((await r.json()).sources.length, 1);
    const bad = await fetch(`${f.url}/api/projects/${p.id}/sources/upload`, {
      method: "POST",
      headers: { "Content-Type": "multipart/form-data; boundary=test" },
      body: '--test\r\nContent-Disposition: form-data; name="file"; filename="bad.mp4"\r\n\r\nincomplete',
    });
    assert.equal(bad.status, 400);
    assert.deepEqual(await fs.readdir(path.join(f.studio.root, "uploads")), []);
  },
);
test(
  "real export reorders silent video, retimes subtitles and mixes timed voiceovers",
  { skip: !hasFFmpeg },
  async (t) => {
    const f = await fixture(t);
    let p = await f.studio.createProject("Synthetic export");
    for (const [name, color, freq, duration] of [
      ["scene", "red", 440, 2],
      ["silent", "blue", null, 2],
      ["voice", "black", 1000, 0.5],
    ]) {
      const file = path.join(f.root, name + ".mp4"),
        args = [
          "-nostdin",
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          `color=${color}:s=160x90:r=30:d=${duration}`,
        ];
      if (freq)
        args.push(
          "-f",
          "lavfi",
          "-i",
          `sine=frequency=${freq}:duration=${duration}`,
          "-c:a",
          "aac",
        );
      args.push(
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-t",
        String(duration),
        file,
      );
      await capture("ffmpeg", args);
      p = await f.studio.importPath(p.id, file);
    }
    const [scene, silent, voice] = p.sources.map((s) => s.id),
      voices = [{ source_id: voice, start: 1.2, volume: 1 }];
    const edit = {
      revision: p.revision,
      clips: [
        { source_id: silent, start: 0.5, end: 1.5 },
        { source_id: scene, start: 0, end: 1 },
      ],
      subtitles: { [scene]: [{ start: 0.2, end: 0.8, text: "Sample" }] },
      voiceovers: voices,
    };
    p = await f.studio.updateEdit(p.id, edit);
    const { voiceovers: ignored, ...older } = edit;
    p = await f.studio.updateEdit(p.id, { ...older, revision: p.revision });
    assert.deepEqual(p.voiceovers, voices);
    const job = await f.studio.submit(p.id, "export");
    p = await f.studio.updateEdit(p.id, {
      revision: p.revision,
      clips: [{ source_id: scene, start: 0, end: 2 }],
      subtitles: p.subtitles,
    });
    const done = await waitJob(f, job.id);
    assert.equal(done.status, "completed", done.message);
    assert.ok(Math.abs(done.result.duration - 2) < 0.1);
    const file = await f.studio.jobFile(job.id, "video.mp4");
    assert.match(
      await fs.readFile(
        await f.studio.jobFile(job.id, "subtitles.srt"),
        "utf8",
      ),
      /00:00:01,200 --> 00:00:01,800/,
    );
    for (const [at, index] of [
      [0.2, 2],
      [1.1, 0],
    ]) {
      const raw = await new Promise((resolve, reject) => {
        const child = spawnSync(
          "ffmpeg",
          [
            "-v",
            "error",
            "-ss",
            String(at),
            "-i",
            file,
            "-frames:v",
            "1",
            "-vf",
            "scale=1:1",
            "-pix_fmt",
            "rgb24",
            "-f",
            "rawvideo",
            "pipe:1",
          ],
          { windowsHide: true },
        );
        child.status === 0
          ? resolve(child.stdout)
          : reject(new Error(child.stderr.toString()));
      });
      assert.equal(raw.indexOf(Math.max(...raw)), index);
    }
    const raw = spawnSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        file,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "48000",
        "-f",
        "f32le",
        "pipe:1",
      ],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    );
    assert.equal(raw.status, 0);
    const amplitude = (at, hz) => {
      let re = 0,
        im = 0;
      const start = Math.round(at * 48000);
      for (let i = 0; i < 4800; i++) {
        const v = raw.stdout.readFloatLE((start + i) * 4),
          a = (2 * Math.PI * hz * i) / 48000;
        re += v * Math.cos(a);
        im += v * Math.sin(a);
      }
      return Math.hypot(re, im) / 4800;
    };
    assert.ok(amplitude(1.35, 1000) > amplitude(1.05, 1000) * 20);
    assert.ok(amplitude(1.35, 440) < amplitude(1.05, 440) * 0.45);
    assert.ok(amplitude(1.8, 440) > amplitude(1.05, 440) * 0.9);
    assert.ok(amplitude(1.8, 1000) < amplitude(1.35, 1000) * 0.05);
    await capture("ffmpeg", ["-v", "error", "-i", file, "-f", "null", "-"]);
    await assert.rejects(
      f.studio.updateEdit(p.id, {
        revision: p.revision,
        clips: [{ source_id: scene, start: 0, end: 0.5 }],
        subtitles: p.subtitles,
      }),
      /fit within/,
    );
    p = await f.studio.updateEdit(p.id, {
      revision: p.revision, clips: p.clips,
      subtitles: {...p.subtitles, [voice]: [{start: 0, end: .5, text: "Silent narration", style: {position: "top-center"}}]},
      voiceovers: [{source_id: voice, start: .5, volume: 0}],
    });
    const silentJob = await f.studio.submit(p.id, "export");
    const silentDone = await waitJob(f, silentJob.id);
    assert.equal(silentDone.status, "completed", silentDone.message);
    const ass = await fs.readFile(await f.studio.jobFile(silentJob.id, "subtitles.ass"), "utf8");
    assert.match(ass, /Silent narration/);
    const filters = await fs.readFile(f.studio.jobDir(silentJob.id, "filters.txt"), "utf8");
    assert.doesNotMatch(filters, /ducked|amix/);
    const audio = spawnSync("ffmpeg", ["-v", "error", "-i", await f.studio.jobFile(silentJob.id, "video.mp4"), "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1"], {windowsHide: true, maxBuffer: 4 * 1024 * 1024});
    assert.equal(audio.status, 0);
    const rms = at => {
      let power = 0;
      for (let i = Math.round(at * 48000); i < Math.round(at * 48000) + 4800; i++) power += audio.stdout.readFloatLE(i * 4) ** 2;
      return Math.sqrt(power / 4800);
    };
    assert.ok(rms(.7) / rms(.2) > .9 && rms(.7) / rms(.2) < 1.1, "caption-only narration must not duck original audio");
    await f.studio.updateEdit(p.id, {
      revision: p.revision,
      clips: [{ source_id: scene, start: 0, end: 0.5 }],
      subtitles: p.subtitles,
      voiceovers: [],
    });
  },
);
