import { timingSafeEqual } from 'node:crypto';
import type { Express, NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import type { AppConfig, MailAccountConfig, MailAdminConfig } from './config.js';
import { runMailDiagnostics } from './diagnostics.js';
import { FailureRateLimiter, applySensitiveHeaders, isSameOriginMutation, requestClientKey } from './http-security.js';
import { createMailAccountRuntime, type MailAccountRegistry } from './mail/accounts.js';
import { EncryptedAccountStore } from './mail/account-store.js';
import { isHostnameOrIpv4 } from './network.js';

const HostSchema = z.string().trim().min(1).max(253).refine(
  isHostnameOrIpv4,
  'Host must be a valid hostname or IPv4 address without scheme, path, port, or wildcard.'
);

const AccountInput = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  username: z.string().email(),
  appPassword: z.string().max(4096).optional(),
  fromName: z.string().trim().min(1).max(120).refine((value) => !/[\r\n]/.test(value), 'From name must not contain CR or LF characters.'),
  imapHost: HostSchema,
  imapPort: z.number().int().min(1).max(65535),
  smtpHost: HostSchema,
  smtpPort: z.number().int().min(1).max(65535),
  smtpSecurity: z.enum(['tls', 'starttls']).default('tls')
});

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function adminAuth(password: string) {
  const limiter = new FailureRateLimiter(10, 5 * 60 * 1000, 15 * 60 * 1000);

  return (req: Request, res: Response, next: NextFunction) => {
    applySensitiveHeaders(res);
    const key = requestClientKey(req);
    const allowed = limiter.check(key);
    if (!allowed.allowed) {
      res.setHeader('Retry-After', String(allowed.retryAfterSeconds ?? 900));
      return res.status(429).send('Too many failed admin authentication attempts.');
    }

    const header = req.header('authorization') ?? '';
    if (header.startsWith('Basic ')) {
      try {
        const credentials = Buffer.from(header.slice(6), 'base64').toString('utf8');
        const separator = credentials.indexOf(':');
        const username = separator >= 0 ? credentials.slice(0, separator) : credentials;
        const supplied = separator >= 0 ? credentials.slice(separator + 1) : '';
        if (username === 'admin' && safeEqual(supplied, password)) {
          limiter.success(key);
          return next();
        }
      } catch {}
    }

    limiter.failure(key);
    res.setHeader('WWW-Authenticate', 'Basic realm="Mailbox Manager", charset="UTF-8"');
    return res.status(401).send('Authentication required.');
  };
}

function toConfig(input: z.infer<typeof AccountInput> & { appPassword: string }, base: AppConfig): MailAccountConfig {
  const smtpSecurity = input.smtpSecurity === 'starttls'
    ? { secure: false, requireTLS: true }
    : { secure: true, requireTLS: undefined };

  return {
    id: input.id,
    username: input.username.toLowerCase(),
    appPassword: input.appPassword,
    fromName: input.fromName,
    maxMessageBytes: base.maxMessageBytes,
    searchSourceBytes: base.searchSourceBytes,
    messageRefSecret: base.messageRefSecret,
    imap: { ...base.imap, host: input.imapHost, port: input.imapPort },
    smtp: { ...base.smtp, ...smtpSecurity, host: input.smtpHost, port: input.smtpPort }
  };
}

function clientScript(): string {
  return `const must=id=>{const el=document.getElementById(id);if(!el)throw new Error('Missing admin UI element: '+id);return el};
const dlg=must('dlg');
const dlgTitle=must('dlgTitle');
const form=must('form');
const accountId=must('id');
const providerSelect=must('provider');
const usernameInput=must('username');
const passwordInput=must('password');
const fromNameInput=must('fromName');
const imapHostInput=must('imapHost');
const imapPortInput=must('imapPort');
const smtpHostInput=must('smtpHost');
const smtpPortInput=must('smtpPort');
const smtpSecuritySelect=must('smtpSecurity');
const formStatus=must('formStatus');
const summary=must('summary');
const cards=must('cards');
const addMailboxButton=must('addMailbox');
const cancelDialogButton=must('cancelDialog');
let state=null;
const presets={aliyun:['imap.qiye.aliyun.com',993,'smtp.qiye.aliyun.com',465,'tls'],gmail:['imap.gmail.com',993,'smtp.gmail.com',465,'tls'],outlook:['outlook.office365.com',993,'smtp.office365.com',587,'starttls']};
function preset(){const p=presets[providerSelect.value];if(!p)return;[imapHostInput.value,imapPortInput.value,smtpHostInput.value,smtpPortInput.value,smtpSecuritySelect.value]=p}
async function api(path,opt={}){const r=await fetch('/admin/api'+path,{headers:{'content-type':'application/json'},...opt});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||'Request failed');return j}
function textEl(tag,className,text){const el=document.createElement(tag);if(className)el.className=className;el.textContent=String(text??'');return el}
function actionButton(label,action,id,className){const button=document.createElement('button');button.type='button';button.className=className;button.textContent=label;button.dataset.action=action;button.dataset.id=id;return button}
function accountCard(a){const card=textEl('div','card','');const top=textEl('div','','');top.append(textEl('span','badge',a.source));card.append(top);card.append(textEl('div','addr',a.id+' · '+a.username));card.append(textEl('div','',a.fromName));card.append(textEl('div','small',(a.imapHost||'')+' '+(a.imapPort||'')+' → '+(a.smtpHost||'')+' '+(a.smtpPort||'')+' · '+(a.smtpSecurity||'tls')));const row=textEl('div','row','');row.append(actionButton('Test','test',a.id,'ghost'));if(a.source==='ui'){row.append(actionButton('Edit','edit',a.id,'ghost'));row.append(actionButton('Delete','delete',a.id,'danger'))}card.append(row);const status=textEl('div','status','');status.id='s-'+a.id;card.append(status);return card}
async function load(){state=await api('/accounts');summary.textContent=state.accounts.length+' configured mailbox(es)'+(state.accounts.length>1?' · explicit account required for AI reads/sends':'');cards.replaceChildren(...state.accounts.map(accountCard))}
function openAdd(){formStatus.textContent='';dlgTitle.textContent='Add mailbox';form.reset();accountId.disabled=false;providerSelect.value='aliyun';preset();dlg.showModal()}
function editBox(i){const a=state?.accounts?.find(x=>x.id===i);if(!a)return;formStatus.textContent='';dlgTitle.textContent='Edit '+i;accountId.value=a.id;accountId.disabled=true;usernameInput.value=a.username;fromNameInput.value=a.fromName;imapHostInput.value=a.imapHost;smtpHostInput.value=a.smtpHost;imapPortInput.value=a.imapPort;smtpPortInput.value=a.smtpPort;smtpSecuritySelect.value=a.smtpSecurity||'tls';providerSelect.value='custom';passwordInput.value='';dlg.showModal()}
async function testBox(i){const el=document.getElementById('s-'+i);if(!el)return;el.textContent='Testing IMAP + SMTP…';try{const r=await api('/accounts/'+i+'/test',{method:'POST'});el.textContent=r.ok?'✓ IMAP and SMTP ready':'Check failed: '+JSON.stringify(r)}catch(x){el.textContent=x instanceof Error?x.message:'Mailbox test failed'}}
async function delBox(i){if(!confirm('Delete '+i+'?'))return;const el=document.getElementById('s-'+i);try{await api('/accounts/'+i,{method:'DELETE'});await load()}catch(x){if(el)el.textContent=x instanceof Error?x.message:'Delete failed'}}
providerSelect.addEventListener('change',preset);
addMailboxButton.addEventListener('click',openAdd);
cancelDialogButton.addEventListener('click',()=>dlg.close());
cards.addEventListener('click',e=>{const target=e.target instanceof Element?e.target.closest('button[data-action][data-id]'):null;if(!target)return;const i=target.getAttribute('data-id');const action=target.getAttribute('data-action');if(!i||!action)return;if(action==='test')void testBox(i);else if(action==='edit')editBox(i);else if(action==='delete')void delBox(i)});
form.addEventListener('submit',async e=>{e.preventDefault();formStatus.textContent='Saving…';try{await api('/accounts',{method:'POST',body:JSON.stringify({id:accountId.value,username:usernameInput.value,appPassword:passwordInput.value||undefined,fromName:fromNameInput.value,imapHost:imapHostInput.value,imapPort:+imapPortInput.value,smtpHost:smtpHostInput.value,smtpPort:+smtpPortInput.value,smtpSecurity:smtpSecuritySelect.value})});dlg.close();await load()}catch(x){formStatus.textContent=x instanceof Error?x.message:'Save failed'}});
load().catch(e=>{summary.textContent=e instanceof Error?e.message:'Mailbox list failed'});`;
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
<div class="notice">AI reads and sends by <b>account id</b>. Keep each id stable. With multiple mailboxes, AI must select an account explicitly for ambiguous reads/writes.</div>
<div class="bar"><div id="summary" class="muted">Loading…</div><button id="addMailbox" class="primary" type="button">+ Add mailbox</button></div>
<div id="cards" class="grid"></div>
</div>
<dialog id="dlg"><h2 id="dlgTitle">Add mailbox</h2><form id="form">
<label><span>Account ID</span><input id="id" required pattern="[a-z][a-z0-9_]{0,31}" placeholder="geteen_us"></label>
<label><span>Provider</span><select id="provider"><option value="aliyun">Alibaba Mail</option><option value="gmail">Gmail</option><option value="outlook">Microsoft 365 / Outlook</option><option value="custom">Custom</option></select></label>
<label class="full"><span>Email address</span><input id="username" type="email" required></label>
<label class="full"><span>App password / mailbox password</span><input id="password" type="password" placeholder="Leave blank when editing to keep current password"></label>
<label class="full"><span>From name</span><input id="fromName" required placeholder="GETEEN"></label>
<label><span>IMAP host</span><input id="imapHost" required></label><label><span>IMAP port</span><input id="imapPort" type="number" required></label>
<label><span>SMTP host</span><input id="smtpHost" required></label><label><span>SMTP port</span><input id="smtpPort" type="number" required></label>
<label class="full"><span>SMTP security</span><select id="smtpSecurity"><option value="tls">Implicit TLS (usually 465)</option><option value="starttls">STARTTLS (usually 587)</option></select></label>
<div class="full row"><button id="cancelDialog" type="button" class="ghost">Cancel</button><button class="primary" type="submit">Save mailbox</button></div>
</form><div id="formStatus" class="status"></div></dialog>
<script src="/admin/app.js" defer></script></body></html>`;
}

export function registerMailboxAdmin(
  app: Express,
  registry: MailAccountRegistry,
  store: EncryptedAccountStore,
  admin: MailAdminConfig,
  baseConfig: AppConfig
): void {
  const auth = adminAuth(admin.password);
  let mutationTail: Promise<void> = Promise.resolve();
  const mutate = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = mutationTail.then(operation, operation);
    mutationTail = run.then(() => undefined, () => undefined);
    return run;
  };

  app.get('/admin/app.js', auth, (_req, res) => res.type('application/javascript').send(clientScript()));
  app.get('/admin', auth, (_req, res) => res.type('html').send(html()));
  app.use('/admin/api', auth, (req, res, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !isSameOriginMutation(req)) {
      return res.status(403).json({ error: 'Cross-origin admin mutation rejected.' });
    }
    next();
  });

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
      const outcome = await mutate(async () => {
        const existingRuntime = registry.list().find((account) => account.id === input.id);
        if (existingRuntime?.source === 'environment') return { status: 409, body: { error: 'Environment-managed accounts are read-only in the UI.' } };

        const existing = await store.get(input.id);
        const appPassword = input.appPassword || existing?.appPassword;
        if (!appPassword) return { status: 400, body: { error: 'Password is required for a new mailbox.' } };

        const complete = { ...input, appPassword };
        await store.upsert(complete);
        registry.upsert(createMailAccountRuntime(toConfig(complete, baseConfig), 'ui'));
        if (!registry.defaultAccountId) {
          registry.setDefault(input.id);
          await store.setDefault(input.id);
        }
        return { status: existing ? 200 : 201, body: { ok: true, account: input.id } };
      });
      res.status(outcome.status).json(outcome.body);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid mailbox configuration.' });
    }
  });

  app.delete('/admin/api/accounts/:id', async (req, res) => {
    try {
      const id = req.params.id;
      const outcome = await mutate(async () => {
        const runtime = registry.list().find((account) => account.id === id);
        if (!runtime) return { status: 404, body: { error: 'Mailbox not found.' } };
        if (runtime.source === 'environment') return { status: 409, body: { error: 'Environment-managed accounts are read-only in the UI.' } };
        await store.remove(id);
        registry.remove(id);
        if (registry.defaultAccountId) await store.setDefault(registry.defaultAccountId);
        return { status: 200, body: { ok: true } };
      });
      res.status(outcome.status).json(outcome.body);
    } catch {
      res.status(500).json({ error: 'Mailbox configuration could not be deleted.' });
    }
  });

  app.post('/admin/api/default', async (req, res) => {
    try {
      const id = z.object({ id: z.string() }).parse(req.body).id;
      await mutate(async () => {
        registry.setDefault(id);
        await store.setDefault(id);
      });
      res.json({ ok: true, defaultAccount: id });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid default account.' });
    }
  });

  app.post('/admin/api/accounts/:id/test', async (req, res) => {
    try {
      const runtime = registry.resolve(req.params.id);
      res.json(await runMailDiagnostics(runtime.imap, runtime.smtp));
    } catch {
      res.status(404).json({ error: 'Mailbox not found or diagnostics failed.' });
    }
  });
}
