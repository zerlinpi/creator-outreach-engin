import { timingSafeEqual } from 'node:crypto';
import type { Express, NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import type { AppConfig, MailAccountConfig, MailAdminConfig } from './config.js';
import { runMailDiagnostics } from './diagnostics.js';
import { createMailAccountRuntime, type MailAccountRegistry } from './mail/accounts.js';
import { EncryptedAccountStore } from './mail/account-store.js';

const AccountInput = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  username: z.string().email(),
  appPassword: z.string().optional(),
  fromName: z.string().min(1).max(120),
  imapHost: z.string().min(1).max(253),
  imapPort: z.number().int().min(1).max(65535),
  smtpHost: z.string().min(1).max(253),
  smtpPort: z.number().int().min(1).max(65535)
});

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function adminAuth(password: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.header('authorization') ?? '';
    if (header.startsWith('Basic ')) {
      try {
        const [username, supplied = ''] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':', 2);
        if (username === 'admin' && safeEqual(supplied, password)) return next();
      } catch {}
    }
    res.setHeader('WWW-Authenticate', 'Basic realm="Mailbox Manager", charset="UTF-8"');
    return res.status(401).send('Authentication required.');
  };
}

function toConfig(input: z.infer<typeof AccountInput> & { appPassword: string }, base: AppConfig): MailAccountConfig {
  return {
    id: input.id,
    username: input.username.toLowerCase(),
    appPassword: input.appPassword,
    fromName: input.fromName,
    maxMessageBytes: base.maxMessageBytes,
    searchSourceBytes: base.searchSourceBytes,
    imap: { ...base.imap, host: input.imapHost, port: input.imapPort },
    smtp: { ...base.smtp, host: input.smtpHost, port: input.smtpPort }
  };
}

function html(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mailbox Manager</title>
<style>
body{font-family:Inter,system-ui,sans-serif;margin:0;background:#f6f7f9;color:#1d2329}.wrap{max-width:1180px;margin:40px auto;padding:0 20px}
h1{margin:0 0 8px;font-size:30px}.muted{color:#667085}.bar{display:flex;justify-content:space-between;align-items:center;margin:24px 0}
button{border:0;border-radius:9px;padding:10px 15px;cursor:pointer;font-weight:650}.primary{background:#111827;color:#fff}.ghost{background:#fff;border:1px solid #d0d5dd}.danger{color:#b42318;background:#fff;border:1px solid #fecdca}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(310px,1fr));gap:14px}.card{background:#fff;border:1px solid #e4e7ec;border-radius:14px;padding:18px}
.badge{display:inline-block;font-size:12px;background:#f2f4f7;border-radius:999px;padding:4px 8px;margin-right:6px}.default{background:#ecfdf3;color:#027a48}
.row{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}.addr{font-weight:700;margin:8px 0}.small{font-size:13px;color:#667085}
dialog{border:0;border-radius:16px;box-shadow:0 20px 70px #0003;width:min(680px,94vw)}form{display:grid;grid-template-columns:1fr 1fr;gap:12px}label{font-size:13px;font-weight:650}
label span{display:block;margin-bottom:5px}input,select{width:100%;box-sizing:border-box;padding:10px;border:1px solid #d0d5dd;border-radius:8px}.full{grid-column:1/-1}
.notice{background:#fffaeb;border:1px solid #fedf89;padding:12px;border-radius:10px;margin:18px 0;font-size:13px}
.status{min-height:22px;margin-top:10px;font-size:13px}
@media(max-width:640px){.wrap{margin:22px auto}form{grid-template-columns:1fr}.full{grid-column:1}.bar{align-items:flex-start;gap:12px;flex-direction:column}}
</style></head><body><div class="wrap">
<h1>Mailbox Manager</h1><div class="muted">Add and manage sender mailboxes. Passwords are encrypted at rest and never exposed to AI.</div>
<div class="notice">AI reads and sends by <b>account id</b>. Keep each id stable (for example: campx, hassky, geteen_us). Environment-managed accounts are read-only here.</div>
<div class="bar"><div id="summary" class="muted">Loading…</div><button class="primary" onclick="openAdd()">+ Add mailbox</button></div>
<div id="cards" class="grid"></div>
</div>
<dialog id="dlg"><h2 id="dlgTitle">Add mailbox</h2><form id="form">
<label><span>Account ID</span><input id="id" required pattern="[a-z][a-z0-9_]{0,31}" placeholder="geteen_us"></label>
<label><span>Provider</span><select id="provider" onchange="preset()"><option value="aliyun">Alibaba Mail</option><option value="gmail">Gmail</option><option value="outlook">Outlook / Microsoft 365</option><option value="custom">Custom</option></select></label>
<label class="full"><span>Email address</span><input id="username" type="email" required></label>
<label class="full"><span>App password / mailbox password</span><input id="password" type="password" placeholder="Leave blank when editing to keep current password"></label>
<label class="full"><span>From name</span><input id="fromName" required placeholder="GETEEN"></label>
<label><span>IMAP host</span><input id="imapHost" required></label><label><span>IMAP port</span><input id="imapPort" type="number" required></label>
<label><span>SMTP host</span><input id="smtpHost" required></label><label><span>SMTP port</span><input id="smtpPort" type="number" required></label>
<div class="full row"><button type="button" class="ghost" onclick="dlg.close()">Cancel</button><button class="primary" type="submit">Save mailbox</button></div>
</form><div id="formStatus" class="status"></div></dialog>
<script>
const dlg=document.getElementById('dlg'); let editing=null; let state=null;
const presets={aliyun:['imap.qiye.aliyun.com',993,'smtp.qiye.aliyun.com',465],gmail:['imap.gmail.com',993,'smtp.gmail.com',465],outlook:['outlook.office365.com',993,'smtp.office365.com',587]};
function preset(){const p=presets[provider.value];if(!p)return;[imapHost.value,imapPort.value,smtpHost.value,smtpPort.value]=p}
function esc(v){return String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
async function api(path,opt={}){const r=await fetch('/admin/api'+path,{headers:{'content-type':'application/json'},...opt});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||'Request failed');return j}
async function load(){state=await api('/accounts');summary.textContent=state.accounts.length+' configured mailbox(es) · default: '+(state.defaultAccount||'none');
cards.innerHTML=state.accounts.map(a=>`<div class="card"><div><span class="badge">${esc(a.source)}</span>${a.id===state.defaultAccount?'<span class="badge default">default</span>':''}</div><div class="addr">${esc(a.id)} · ${esc(a.username)}</div><div>${esc(a.fromName)}</div><div class="small">${esc(a.imapHost||'')} ${a.imapPort||''} → ${esc(a.smtpHost||'')} ${a.smtpPort||''}</div><div class="row"><button class="ghost" onclick="testBox('${a.id}')">Test</button><button class="ghost" onclick="makeDefault('${a.id}')">Set default</button>${a.source==='ui'?'<button class="ghost" onclick="editBox(\''+a.id+'\')">Edit</button><button class="danger" onclick="delBox(\''+a.id+'\')">Delete</button>':''}</div><div id="s-${a.id}" class="status"></div></div>`).join('')}
function openAdd(){editing=null;dlgTitle.textContent='Add mailbox';form.reset();id.disabled=false;provider.value='aliyun';preset();dlg.showModal()}
function editBox(i){const a=state.accounts.find(x=>x.id===i);editing=i;dlgTitle.textContent='Edit '+i;id.value=a.id;id.disabled=true;username.value=a.username;fromName.value=a.fromName;imapHost.value=a.imapHost;smtpHost.value=a.smtpHost;imapPort.value=a.imapPort;smtpPort.value=a.smtpPort;provider.value='custom';password.value='';dlg.showModal()}
form.onsubmit=async e=>{e.preventDefault();formStatus.textContent='Saving…';try{await api('/accounts',{method:'POST',body:JSON.stringify({id:id.value,username:username.value,appPassword:password.value||undefined,fromName:fromName.value,imapHost:imapHost.value,imapPort:+imapPort.value,smtpHost:smtpHost.value,smtpPort:+smtpPort.value})});dlg.close();await load()}catch(x){formStatus.textContent=x.message}}
async function testBox(i){const el=document.getElementById('s-'+i);el.textContent='Testing IMAP + SMTP…';try{const r=await api('/accounts/'+i+'/test',{method:'POST'});el.textContent=r.ok?'✓ IMAP and SMTP ready':'Check failed: '+JSON.stringify(r)}catch(x){el.textContent=x.message}}
async function makeDefault(i){await api('/default',{method:'POST',body:JSON.stringify({id:i})});await load()}
async function delBox(i){if(!confirm('Delete '+i+'?'))return;await api('/accounts/'+i,{method:'DELETE'});await load()}
load().catch(e=>summary.textContent=e.message);
</script></body></html>`;
}

export function registerMailboxAdmin(
  app: Express,
  registry: MailAccountRegistry,
  store: EncryptedAccountStore,
  admin: MailAdminConfig,
  baseConfig: AppConfig
): void {
  const auth = adminAuth(admin.password);
  app.get('/admin', auth, (_req, res) => res.type('html').send(html()));
  app.use('/admin/api', auth);

  app.get('/admin/api/accounts', async (_req, res) => {
    const managed = new Map((await store.list()).map((item) => [item.id, item]));
    const accounts = registry.list().map((runtime) => ({
      id: runtime.id,
      username: runtime.address,
      fromName: runtime.fromName,
      source: runtime.source ?? 'environment',
      ...(managed.get(runtime.id) ?? {})
    }));
    res.json({ defaultAccount: registry.defaultAccountId ?? null, accounts });
  });

  app.post('/admin/api/accounts', async (req, res) => {
    try {
      const input = AccountInput.parse(req.body);
      const existingRuntime = registry.list().find((account) => account.id === input.id);
      if (existingRuntime?.source === 'environment') return res.status(409).json({ error: 'Environment-managed accounts are read-only in the UI.' });

      const existing = await store.get(input.id);
      const appPassword = input.appPassword || existing?.appPassword;
      if (!appPassword) return res.status(400).json({ error: 'Password is required for a new mailbox.' });

      const complete = { ...input, appPassword };
      await store.upsert(complete);
      registry.upsert(createMailAccountRuntime(toConfig(complete, baseConfig), 'ui'));
      if (!registry.defaultAccountId) {
        registry.setDefault(input.id);
        await store.setDefault(input.id);
      }
      res.status(existing ? 200 : 201).json({ ok: true, account: input.id });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid mailbox configuration.' });
    }
  });

  app.delete('/admin/api/accounts/:id', async (req, res) => {
    const id = req.params.id;
    const runtime = registry.list().find((account) => account.id === id);
    if (!runtime) return res.status(404).json({ error: 'Mailbox not found.' });
    if (runtime.source === 'environment') return res.status(409).json({ error: 'Environment-managed accounts are read-only in the UI.' });
    await store.remove(id);
    registry.remove(id);
    if (registry.defaultAccountId) await store.setDefault(registry.defaultAccountId);
    res.json({ ok: true });
  });

  app.post('/admin/api/default', async (req, res) => {
    try {
      const id = z.object({ id: z.string() }).parse(req.body).id;
      registry.setDefault(id);
      await store.setDefault(id);
      res.json({ ok: true, defaultAccount: id });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid default account.' });
    }
  });

  app.post('/admin/api/accounts/:id/test', async (req, res) => {
    try {
      const runtime = registry.resolve(req.params.id);
      res.json(await runMailDiagnostics(runtime.imap, runtime.smtp));
    } catch (error) {
      res.status(404).json({ error: error instanceof Error ? error.message : 'Mailbox not found.' });
    }
  });
}
