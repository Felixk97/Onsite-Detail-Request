import { getStore } from "@netlify/blobs";
import { timingSafeEqual, randomUUID, randomBytes, createHash } from "node:crypto";

const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const same = (a, b) => { const x = Buffer.from(a || ""), y = Buffer.from(b || ""); return x.length === y.length && timingSafeEqual(x, y); };
const uid = () => randomUUID().replace(/-/g, "").slice(0, 16);
const safe = (s) => typeof s === "string" && /^[\w-]{1,40}$/.test(s);
const RANGE = { age: [1, 120], height: [50, 250], weight: [10, 400], sys: [50, 300], dia: [30, 200] };
const MAX_PER_COMPANY = 3000;
const hashCode = (c) => createHash("sha256").update("lifecare|" + String(c).trim().toUpperCase()).digest("hex");
const genCode = () => {
  const A = "ABCDEFGHJKMNPQRSTUVWXYZ23456789", b = randomBytes(12);
  let s = "";
  for (let i = 0; i < 12; i++) { s += A[b[i] % A.length]; if (i % 4 === 3 && i < 11) s += "-"; }
  return s;
};
const DEF = { barcode: true, age: true, hw: true, bp: true };
const REQ0 = { barcode: false, age: false, hw: false, bp: false };
const cfgOf = (c) => ({ builtin: { ...DEF, ...(c?.cfg?.builtin || {}) }, req: { ...REQ0, ...(c?.cfg?.req || {}) }, custom: Array.isArray(c?.cfg?.custom) ? c.cfg.custom : [] });
const bn = (s) => String(s || "").trim().toUpperCase().replace(/\s+/g, "");

function clean(b, noName, cfg) {
  const f = cfg || cfgOf(null);
  const on = { age: f.builtin.age, height: f.builtin.hw, weight: f.builtin.hw, sys: f.builtin.bp, dia: f.builtin.bp };
  const name = String(b.name || "").trim().slice(0, 120);
  if (!name && !noName) return { error: "name" };
  const out = { name };
  for (const k in RANGE) {
    if (!on[k]) { out[k] = null; continue; }
    const raw = b[k];
    if (raw === null || raw === undefined || raw === "") { out[k] = null; continue; }
    const n = Number(raw);
    if (!isFinite(n) || n < RANGE[k][0] || n > RANGE[k][1]) return { error: k };
    out[k] = n;
  }
  out.x = {};
  for (const x of f.custom) {
    const raw = b.x && b.x[x.id];
    if (raw === undefined || raw === null || String(raw).trim() === "") { if (x.req) return { error: "req" }; continue; }
    if (x.type === "number") { const n = Number(String(raw).replace(",", ".")); if (!isFinite(n)) return { error: "custom" }; out.x[x.id] = n; }
    else out.x[x.id] = String(raw).trim().slice(0, 100);
  }
  if ((out.height == null) !== (out.weight == null) || (out.sys == null) !== (out.dia == null)) return { error: "pair" };
  if (out.sys && out.dia && out.sys <= out.dia) return { error: "bp" };
  if (on.age && f.req.age && out.age == null) return { error: "req" };
  if (f.builtin.hw && f.req.hw && (out.height == null || out.weight == null)) return { error: "req" };
  if (f.builtin.bp && f.req.bp && (out.sys == null || out.dia == null)) return { error: "req" };
  const groups = {};
  for (const x of f.custom) if (x.group) (groups[x.group] ||= []).push(x);
  for (const g of Object.values(groups)) {
    const filled = g.filter((x) => out.x[x.id] !== undefined).length;
    if (filled && filled < g.length) return { error: "pair" };
  }
  return { rec: out };
}

export default async (req) => {
  const store = getStore({ name: "screening", consistency: "strong" });
  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "";
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const getJ = (key) => store.get(key, { type: "json" });
  const company = (id) => (safe(id) ? getJ("c:" + id) : null);
  const list = async (prefix) => {
    const { blobs } = await store.list({ prefix });
    return (await Promise.all(blobs.map((b) => getJ(b.key)))).filter(Boolean);
  };

  // ---------- public (staff self-entry): can only create / read / update ONE record ----------
  if (action === "company") {
    const c = await company(url.searchParams.get("id"));
    return c ? J({ name: c.name, open: c.open !== false, cfg: cfgOf(c) }) : J({ error: "not found" }, 404);
  }
  if (action === "mine") {
    const cid = url.searchParams.get("c"), id = url.searchParams.get("id");
    const rec = safe(cid) && safe(id) ? await getJ(`r:${cid}:${id}`) : null;
    return rec ? J({ rec }) : J({ error: "not found" }, 404);
  }
  if (action === "lookup") {
    const c = await company(url.searchParams.get("c"));
    if (!c || c.open === false) return J({ found: false }, 404);
    const list = (await getJ("n:" + c.id))?.entries || [];
    if (!list.length) return J({ found: true, nolist: true });
    const e = list.find((x) => bn(x.barcode) === bn(url.searchParams.get("code")));
    if (!e) return J({ found: false });
    const masked = String(e.name).split(/\s+/).map((w) => w.slice(0, 1) + "*".repeat(Math.min(Math.max(w.length - 1, 0), 4))).join(" ");
    return J({ found: true, masked });
  }
  if (action === "submit" || action === "update") {
    const c = await company(body.company);
    if (!c || c.open === false) return J({ error: "closed" }, 403);
    if (body.website) return J({ ok: true }); // honeypot for bots
    if (action === "submit" && cfgOf(c).builtin.barcode && cfgOf(c).req.barcode && !String(body.barcode || "").trim()) return J({ error: "req" }, 400);
    let bc = "", lce = "", nm = body.name;
    if (action === "submit" && body.barcode && cfgOf(c).builtin.barcode) {
      const list = (await getJ("n:" + c.id))?.entries || [];
      if (!list.length) bc = String(body.barcode).trim().slice(0, 60); // no namelist: record barcode as scanned
      else {
        const e = list.find((x) => bn(x.barcode) === bn(body.barcode));
        if (!e) return J({ error: "barcode" }, 400);
        nm = e.name; bc = e.barcode; lce = e.lce || "";
      }
    }
    const { rec, error } = clean({ ...body, name: nm }, !!bc, cfgOf(c));
    if (error) return J({ error }, 400);
    if (action === "submit") {
      if (!body.consent) return J({ error: "consent" }, 400);
      const { blobs } = await store.list({ prefix: `r:${c.id}:` });
      if (blobs.length >= MAX_PER_COMPANY) return J({ error: "full" }, 429);
      const id = uid(), now = Date.now();
      await store.setJSON(`r:${c.id}:${id}`, { ...rec, id, company: c.id, barcode: bc || null, lce: lce || null, created: now, updated: now, consent: now });
      return J({ id });
    }
    if (!safe(body.id)) return J({ error: "bad id" }, 400);
    const key = `r:${c.id}:${body.id}`, old = await getJ(key);
    if (!old) return J({ error: "not found" }, 404);
    await store.setJSON(key, { ...old, ...rec, updated: Date.now() });
    return J({ ok: true });
  }

  // ---------- admin: master (ADMIN_CODE) or sub-admin (code issued by master) ----------
  const code = req.headers.get("x-admin-code") || "";
  let who = null;
  if (process.env.ADMIN_CODE && same(code, process.env.ADMIN_CODE)) who = { role: "master" };
  else if (code) {
    const k = await getJ("ak:" + hashCode(code));
    const a = k ? await getJ("a:" + k.id) : null;
    if (a) who = { role: "sub", admin: a };
  }
  if (!who) return J({ error: "unauthorized" }, 401);
  const master = who.role === "master";
  const allowed = (cid) => master || (who.admin.companies || []).includes(cid);
  const can = (p) => master || !!who.admin.perms?.[p];
  const deny = () => J({ error: "forbidden" }, 403);

  if (action === "me") return J({ role: who.role, name: master ? "Master admin" : who.admin.name, perms: master ? { del: true, cfg: true } : who.admin.perms || {} });

  if (action === "companies") {
    const cs = (await list("c:")).filter((c) => allowed(c.id));
    const ids = new Set(cs.map((c) => c.id)), counts = {};
    const { blobs } = await store.list({ prefix: "r:" });
    for (const b of blobs) { const id = b.key.split(":")[1]; if (ids.has(id)) counts[id] = (counts[id] || 0) + 1; }
    return J({ companies: cs, counts });
  }
  if (action === "records" && safe(body.company)) {
    if (!allowed(body.company)) return deny();
    return J({ records: await list(`r:${body.company}:`) });
  }
  if (action === "all") {
    const cs = (await list("c:")).filter((c) => allowed(c.id));
    return J({ companies: cs, records: (await Promise.all(cs.map((c) => list(`r:${c.id}:`)))).flat() });
  }
  if (action === "company_put") {
    const name = String(body.name || "").trim().slice(0, 120);
    if (!name) return J({ error: "name" }, 400);
    const id = safe(body.id) ? body.id : uid();
    const old = await getJ("c:" + id);
    if (!old && !master) return deny();
    if (old && (!allowed(id) || !can("cfg"))) return deny();
    let cfg = old?.cfg;
    if (body.cfg) {
      const b = body.cfg.builtin || {};
      cfg = {
        builtin: Object.fromEntries(Object.keys(DEF).map((k) => [k, b[k] !== false])),
        req: Object.fromEntries(Object.keys(REQ0).map((k) => [k, !!body.cfg.req?.[k]])),
        custom: (Array.isArray(body.cfg.custom) ? body.cfg.custom : []).slice(0, 20)
          .map((x) => ({ id: safe(x.id) ? x.id : "f" + uid().slice(0, 8), label: String(x.label || "").trim().slice(0, 60), type: x.type === "text" ? "text" : "number", req: !!x.req, group: /^[A-D]$/.test(x.group) ? x.group : "" }))
          .filter((x) => x.label),
      };
    }
    await store.setJSON("c:" + id, { id, name, open: body.open ?? old?.open ?? true, cfg, created: old?.created || Date.now() });
    return J({ ok: true, id });
  }
  if (action === "company_del" && safe(body.id)) {
    if (!master) return deny();
    await store.delete("c:" + body.id);
    await store.delete("n:" + body.id);
    const { blobs } = await store.list({ prefix: `r:${body.id}:` });
    await Promise.all(blobs.map((b) => store.delete(b.key)));
    return J({ ok: true });
  }
  if (action === "rec_del" && safe(body.company) && safe(body.id)) {
    if (!allowed(body.company) || !can("del")) return deny();
    await store.delete(`r:${body.company}:${body.id}`);
    return J({ ok: true });
  }
  if (action === "rec_put" && safe(body.company)) {
    if (!master) return deny();
    const { rec, error } = clean(body, false, cfgOf(await company(body.company)));
    if (error) return J({ error }, 400);
    const id = safe(body.id) ? body.id : uid(), key = `r:${body.company}:${id}`, old = await getJ(key), now = Date.now();
    await store.setJSON(key, { ...old, ...rec, id, company: body.company, created: old?.created || now, updated: now });
    return J({ ok: true, id });
  }
  if (action === "namelist_get" && safe(body.company)) {
    if (!allowed(body.company)) return deny();
    return J({ entries: (await getJ("n:" + body.company))?.entries || [] });
  }
  if (action === "namelist_put" && safe(body.company)) {
    if (!allowed(body.company) || !can("cfg")) return deny();
    if (!(await company(body.company))) return J({ error: "no company" }, 404);
    const seen = new Set(), entries = [];
    for (const e of Array.isArray(body.entries) ? body.entries.slice(0, 5000) : []) {
      const name = String(e.name || "").trim().slice(0, 120), barcode = String(e.barcode || "").trim().slice(0, 60);
      if (!name || !barcode || seen.has(bn(barcode))) continue;
      seen.add(bn(barcode));
      entries.push({ name, barcode, lce: String(e.lce || "").trim().slice(0, 60) });
    }
    if (entries.length === 0) await store.delete("n:" + body.company);
    else await store.setJSON("n:" + body.company, { updated: Date.now(), entries });
    return J({ ok: true, count: entries.length });
  }

  // ---------- master only: manage admins ----------
  if (action.startsWith("admin")) {
    if (!master) return deny();
    if (action === "admins_list") return J({ admins: (await list("a:")).map(({ hash, ...a }) => a) });
    if (action === "admin_put") {
      const name = String(body.name || "").trim().slice(0, 60);
      if (!name) return J({ error: "name" }, 400);
      const id = safe(body.id) ? body.id : uid(), old = await getJ("a:" + id);
      const companies = (Array.isArray(body.companies) ? body.companies : []).filter(safe).slice(0, 200);
      const perms = { del: !!body.perms?.del, cfg: !!body.perms?.cfg };
      let hash = old?.hash, newCode = null;
      if (!old || body.resetCode) {
        newCode = genCode();
        if (old?.hash) await store.delete("ak:" + old.hash);
        hash = hashCode(newCode);
        await store.setJSON("ak:" + hash, { id });
      }
      await store.setJSON("a:" + id, { id, name, companies, perms, hash, created: old?.created || Date.now() });
      return J({ ok: true, id, code: newCode });
    }
    if (action === "admin_del" && safe(body.id)) {
      const a = await getJ("a:" + body.id);
      if (a) { await store.delete("ak:" + a.hash); await store.delete("a:" + body.id); }
      return J({ ok: true });
    }
  }
  return J({ error: "bad action" }, 400);
};

export const config = { path: "/api" };
