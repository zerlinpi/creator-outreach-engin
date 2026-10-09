import { timingSafeEqual } from 'node:crypto';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { AppConfig, MailAccountConfig, MailAdminConfig } from './config.js';
import { runMailDiagnostics } from './diagnostics.js';
import { FailureRateLimiter, applySensitiveHeaders, isSameOriginMutation, requestClientKey } from './http-security.js';
import { createMailAccountRuntime, type MailAccountRegistry } from './mail/accounts.js';
import { EncryptedAccountStore } from './mail/account-store.js';
import { isHostnameOrIpv4 } from './network.js';
import { ConnectorError } from './errors.js';
import { loadOutreachOverview } from './outreach-overview.js';
import { toEmailView } from './mail/presenters.js';

const AccountIdSchema = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
const HostSchema = z.string().trim().min(1).max(253).refine(
  isHostnameOrIpv4,
  'Host must be a valid hostname or IPv4 address without scheme, path, port, or wildcard.'
);

const AccountInput = z.object({
  id: AccountIdSchema,
  username: z.string().max(320).email(),
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

function inboxScript(): string {
  return `const ui=id=>document.getElementById(id);
const inbox=ui('inboxSection'),settings=ui('mailboxesSection'),threadList=ui('threadList'),detail=ui('messageDetail');
let threads=[],scan=null,loaded=false,filter='all';
const stageNames={new_contact:'Just contacted',awaiting_reply:'Awaiting reply',followed_up:'Followed up',creator_replied:'Just replied',replied:'Replied',we_replied:'We replied',possible_reply:'Possible reply',inbound:'Incoming'};
function el(tag,cls,value){const node=document.createElement(tag);if(cls)node.className=cls;if(value!==undefined)node.textContent=String(value);return node}
function switchTab(tab){const showInbox=tab==='inbox';inbox.hidden=!showInbox;settings.hidden=showInbox;ui('viewInbox').className=showInbox?'navitem selected':'navitem';ui('viewMailboxes').className=showInbox?'navitem':'navitem selected';if(showInbox&&!loaded)void loadThreads()}
async function request(path){const r=await fetch('/admin/api'+path);const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||'Request failed');return j}
function stageLabel(t){return t.stage==='awaiting_reply'&&t.needsAttention?'No reply observed':stageNames[t.stage]||'Unknown'}
function applyFilters(){
  const chosen=ui('accountFilter').value,query=ui('threadSearch').value.trim().toLowerCase();
  const shown=threads.filter(t=>(chosen==='all'||t.account===chosen)&&(filter==='all'||(filter==='attention'?t.needsAttention:t.stage===filter))&&(!query||(t.participant+' '+t.subject+' '+t.latest.preview+' '+t.account).toLowerCase().includes(query)));
  threadList.replaceChildren();
  ui('resultCount').textContent=shown.length+' conversations shown';
  if(!shown.length){threadList.append(el('div','empty','No messages in this view. Refresh or change the filters.'));return}
  for(const t of shown){
    const row=el('button','thread '+(t.unread?'is-unread':''));row.type='button';
    const avatar=el('span','avatar',t.participant.charAt(0).toUpperCase());
    const content=el('span','thread-content'),top=el('span','thread-top');
    top.append(el('strong','',t.participant),el('span','date',new Date(t.lastActivity).toLocaleString()));
    const sub=el('span','thread-sub',t.subject);
    const preview=el('span','thread-preview',t.latest.preview||'No text preview');
    const meta=el('span','thread-meta');
    meta.append(el('span','chip account-chip',t.account),el('span','chip stage-'+t.stage,stageLabel(t)));
    if(t.needsAttention)meta.append(el('span','chip warning','Follow-up due'));
    if(t.unread)meta.append(el('span','chip unread','Unread'));
    content.append(top,sub,preview,meta);row.append(avatar,content);
    row.addEventListener('click',()=>void openMessage(t));
    threadList.append(row);
  }
}
async function openMessage(t){
  detail.replaceChildren(el('div','muted','Loading message…'));
  try{
    const j=await request('/messages?account='+encodeURIComponent(t.account)+'&ref='+encodeURIComponent(t.latest.id));
    const m=j.message;
    const header=el('div','detail-head');
    header.append(el('span','chip account-chip',t.account),el('span','chip stage-'+t.stage,stageLabel(t)));
    const content=el('div','detail-content');
    content.append(header,el('h2','',m.subject||'(No subject)'),el('p','detail-meta','From: '+m.from.join(', ')),el('p','detail-meta','To: '+m.to.join(', ')),el('p','detail-meta',new Date(m.date).toLocaleString()));
    content.append(el('pre','email-body',m.text||'(No plain-text content)'));
    detail.replaceChildren(content);
  }catch(e){detail.replaceChildren(el('p','error',e instanceof Error?e.message:'Message unavailable'))}
}
async function loadThreads(){
  ui('refreshThreads').disabled=true;ui('threadStatus').textContent='Reading connected inboxes and Sent folders…';
  try{
    const data=await request('/outreach?account=all&limit=25');
    threads=data.conversations;scan=data;loaded=true;
    const choices=ui('accountFilter'),prior=choices.value;
    choices.replaceChildren();
    const all=el('option','','All accounts');all.value='all';choices.append(all);
    const ids=[...new Set(threads.map(t=>t.account).concat(data.errors.map(e=>e.account)))].sort();
    for(const id of ids){const option=el('option','',id);option.value=id;choices.append(option)}
    choices.value=ids.includes(prior)?prior:'all';
    ui('metricThreads').textContent=String(threads.length);
    ui('metricAttention').textContent=String(threads.filter(t=>t.needsAttention).length);
    ui('metricReplies').textContent=String(threads.filter(t=>t.stage==='creator_replied'||t.stage==='replied').length);
    ui('metricUnread').textContent=String(threads.filter(t=>t.unread).length);
    const warning=data.errors.length?' · '+data.errors.map(e=>e.account+'/'+e.folder+' unavailable').join(', '):'';
    ui('threadStatus').textContent='Updated '+new Date(data.generatedAt).toLocaleTimeString()+' · Latest '+data.perFolderLimit+' messages per folder and account; older history not checked.'+warning;
    ui('threadStatus').className=data.errors.length?'status error':'status muted';
    applyFilters();
  }catch(e){ui('threadStatus').textContent=e instanceof Error?e.message:'Unable to load inbox';ui('threadStatus').className='status error'}
  finally{ui('refreshThreads').disabled=false}
}
ui('viewInbox').addEventListener('click',()=>switchTab('inbox'));
ui('viewMailboxes').addEventListener('click',()=>switchTab('mailboxes'));
ui('refreshThreads').addEventListener('click',()=>void loadThreads());
ui('accountFilter').addEventListener('change',applyFilters);
ui('threadSearch').addEventListener('input',applyFilters);
ui('stageFilter').addEventListener('change',()=>{filter=ui('stageFilter').value;applyFilters()});
switchTab('inbox');`;
}

function html(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mailbox Manager</title>
<style>
:root{color-scheme:light;--bg:#f6f8fc;--panel:#fff;--line:#e5eaf1;--muted:#667085;--nav:#172339;--accent:#396bfa}
*{box-sizing:border-box}body{font-family:Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:var(--bg);color:#202b3f;font-size:14px}
[hidden]{display:none!important}.shell{min-height:100vh;display:grid;grid-template-columns:226px minmax(0,1fr)}.sidebar{background:var(--nav);color:#f5f7fc;padding:28px 14px;position:sticky;top:0;height:100vh}.brand{display:flex;align-items:center;gap:12px;font-size:17px;font-weight:750;padding:4px 12px 30px}.logo{background:#5078ef;border-radius:11px;padding:8px;color:#fff}.navitem{display:block;width:100%;text-align:left;border-radius:10px;background:transparent;color:#b6c4dc;margin:3px 0;padding:12px 14px}.navitem:hover,.navitem.selected{background:#304363;color:#fff}.sidebar-note{margin:26px 12px;color:#a7b6cd;font-size:12px;line-height:1.7}
.wrap{max-width:1560px;width:100%;margin:0 auto;padding:32px clamp(16px,3vw,44px)}h1{margin:0 0 7px;font-size:26px;letter-spacing:-.6px}h2{font-size:18px;margin:0 0 18px}.muted,.small{color:var(--muted)}.small{font-size:12px}.heading{display:flex;justify-content:space-between;align-items:center;margin-bottom:25px;gap:14px}.eyebrow{text-transform:uppercase;letter-spacing:.12em;font-size:11px;color:#7e8ca4;font-weight:800}.bar{display:flex;justify-content:space-between;align-items:center;gap:12px;margin:24px 0}
button{border:0;border-radius:9px;padding:10px 15px;cursor:pointer;font-weight:650;font:inherit}button:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #a4b8ff;outline-offset:2px}
.primary{background:#305fe6;color:#fff}.primary:hover{background:#244fce}.ghost{background:#fff;border:1px solid #cbd5e1}.danger{color:#b42318;background:#fff;border:1px solid #fecdca}
.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-bottom:18px}.metric{background:var(--panel);border:1px solid var(--line);border-radius:13px;padding:18px}.metric strong{display:block;font-size:28px;margin-top:9px}.metric span{color:#667085}
.work-area{display:grid;grid-template-columns:minmax(320px,1.15fr) minmax(300px,.85fr);gap:16px;align-items:start}.panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;min-width:0;overflow:hidden}.panel-title{padding:18px;border-bottom:1px solid var(--line);font-weight:750;display:flex;justify-content:space-between;align-items:center}
.filters{display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:15px;border-bottom:1px solid var(--line)}.filters .search{grid-column:1/-1}
input,select{width:100%;padding:10px 11px;border:1px solid #d4deea;border-radius:9px;background:white;color:#25324b;font:inherit}
.thread-list{max-height:70vh;overflow:auto}.thread{width:100%;border:0;border-bottom:1px solid #edf0f6;border-radius:0;background:white;display:flex;text-align:left;padding:15px;gap:12px}.thread:hover{background:#f5f8ff}.thread.is-unread .thread-sub{font-weight:750}.thread-content{display:block;min-width:0;flex:1}.thread-top{display:flex;justify-content:space-between;gap:8px;font-size:13px}.date{color:var(--muted);font-size:11px;white-space:nowrap}.thread-sub,.thread-preview{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:5px}.thread-preview{font-size:12px;color:#718096}.thread-meta{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}.avatar{border-radius:12px;background:#edf3ff;color:#456ce5;font-weight:800;display:grid;place-items:center;width:38px;height:38px;flex:none}
.chip,.badge{display:inline-flex;align-items:center;background:#f0f3f8;color:#4d617b;padding:4px 8px;border-radius:999px;font-size:11px;font-weight:700}.account-chip{background:#e9efff;color:#315bc7}.warning,.stage-awaiting_reply,.stage-followed_up{background:#fff3d7;color:#93600b}.stage-creator_replied,.stage-replied{background:#dff8ed;color:#08764b}.stage-possible_reply{background:#fff0e8;color:#a54817}.unread{background:#e8eaff;color:#4847bd}
.detail-content{padding:22px}.detail-head{display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap}.detail-meta{color:var(--muted);font-size:12px;overflow-wrap:anywhere}.email-body{font:13px/1.7 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;border-top:1px solid var(--line);padding-top:16px;max-height:60vh;overflow:auto}.empty{padding:32px 20px;color:var(--muted);text-align:center}.error{color:#a52727}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(310px,1fr));gap:14px}.card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:18px}.row{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}.addr{font-weight:700;margin:8px 0;overflow-wrap:anywhere}.notice{background:#f1f6ff;border:1px solid #d6e3ff;padding:12px;border-radius:10px;margin:18px 0;font-size:13px}.status{min-height:22px;margin:10px 0;font-size:12px;line-height:1.6}
dialog{border:0;border-radius:16px;box-shadow:0 20px 70px #0003;width:min(680px,94vw);max-height:88vh;overflow:auto}form{display:grid;grid-template-columns:1fr 1fr;gap:12px}label{font-size:13px;font-weight:650}label span{display:block;margin-bottom:5px}.full{grid-column:1/-1}
@media(max-width:1100px){.work-area{grid-template-columns:1fr}.thread-list{max-height:50vh}.metrics{grid-template-columns:repeat(2,1fr)}}@media(max-width:700px){.shell{display:block}.sidebar{position:static;height:auto;padding:12px;display:flex;align-items:center;gap:8px}.brand{padding:0 10px 0 0;font-size:13px}.sidebar-note{display:none}.navitem{width:auto;font-size:12px}.wrap{padding:20px 12px}.heading{align-items:flex-start;flex-direction:column}form{grid-template-columns:1fr}.full{grid-column:1}.bar{align-items:flex-start;flex-direction:column}.grid{grid-template-columns:1fr}.date{max-width:115px;overflow:hidden;text-overflow:ellipsis}}
</style></head><body><div class="shell"><aside class="sidebar"><div class="brand"><span class="logo">CO</span> Outreach Desk</div><button type="button" id="viewInbox" class="navitem selected">Inbox &amp; Follow-ups</button><button type="button" id="viewMailboxes" class="navitem">Connected mailboxes</button><p class="sidebar-note">A read-only view of recent inbound and sent messages across your connected accounts.</p></aside><main class="wrap">
<section id="inboxSection">
<div class="heading"><div><div class="eyebrow">Creator outreach</div><h1>Unified inbox</h1><div class="muted">Track incoming replies, new contacts, and follow-up needs across brands.</div></div><button id="refreshThreads" class="primary" type="button">Refresh inbox</button></div>
<div class="metrics"><div class="metric"><span>Conversations</span><strong id="metricThreads">—</strong></div><div class="metric"><span>Follow-up due</span><strong id="metricAttention">—</strong></div><div class="metric"><span>Observed replies</span><strong id="metricReplies">—</strong></div><div class="metric"><span>Unread threads</span><strong id="metricUnread">—</strong></div></div>
<div id="threadStatus" class="status muted">Loading recent mail…</div>
<div class="work-area"><section class="panel"><div class="panel-title">Conversations <span id="resultCount" class="small"></span></div><div class="filters"><input id="threadSearch" class="search" aria-label="Search conversations" placeholder="Search contact, subject or preview"><select id="accountFilter" aria-label="Filter by account"><option value="all">All accounts</option></select><select id="stageFilter" aria-label="Filter by status"><option value="all">All statuses</option><option value="attention">Follow-up due</option><option value="new_contact">Just contacted</option><option value="awaiting_reply">Awaiting reply</option><option value="followed_up">Followed up</option><option value="creator_replied">Just replied</option><option value="replied">Replied</option><option value="we_replied">We replied</option><option value="possible_reply">Possible reply</option><option value="inbound">Incoming</option></select></div><div id="threadList" class="thread-list" aria-live="polite"></div></section>
<section class="panel"><div class="panel-title">Message detail</div><div id="messageDetail" class="empty">Select a conversation to view its latest message. Plain text only; external HTML is never rendered.</div></section></div>
<p class="small">Status is inferred from recent mail (subject + correspondent). Only matching In-Reply-To/References headers confirm a reply; other matches require review. Older messages outside the scan are not included. Follow-up due means no later reply was observed in the scanned window after 72 hours, not proof a person never replied.</p>
</section>
<section id="mailboxesSection" hidden><h1>Mailbox Manager</h1><div class="muted">Add and manage sender mailboxes. Passwords are encrypted at rest and never exposed to AI.</div>
<div class="notice">AI reads and sends by <b>account id</b>. Keep each id stable. With multiple mailboxes, AI must select an account explicitly for ambiguous reads/writes.</div>
<div class="bar"><div id="summary" class="muted">Loading…</div><button id="addMailbox" class="primary" type="button">+ Add mailbox</button></div>
<div id="cards" class="grid"></div>
</section></main></div>
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
<script src="/admin/app.js" defer></script><script src="/admin/inbox.js" defer></script></body></html>`;
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
  app.get('/admin/inbox.js', auth, (_req, res) => res.type('application/javascript').send(inboxScript()));
  app.get('/admin', auth, (_req, res) => res.type('html').send(html()));
  app.use('/admin/api', auth, (req, res, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !isSameOriginMutation(req)) {
      return res.status(403).json({ error: 'Cross-origin admin mutation rejected.' });
    }
    next();
  }, express.json({ limit: '64kb' }));

  app.get('/admin/api/outreach', async (req, res) => {
    const query = z.object({
      account: z.union([AccountIdSchema, z.literal('all')]).default('all'),
      limit: z.coerce.number().int().min(1).max(40).default(25)
    }).safeParse(req.query);
    if (!query.success) return res.status(400).json({ error: 'Invalid account or scan limit.' });
    try {
      return res.json(await loadOutreachOverview(registry, query.data.account, query.data.limit));
    } catch (error) {
      return res.status(error instanceof ConnectorError && error.code === 'ACCOUNT_NOT_FOUND' ? 404 : 502)
        .json({ error: 'Unable to scan selected mailboxes.' });
    }
  });

  app.get('/admin/api/messages', async (req, res) => {
    const query = z.object({ account: AccountIdSchema, ref: z.string().min(1).max(8192) }).safeParse(req.query);
    if (!query.success) return res.status(400).json({ error: 'Account and message reference are required.' });
    try {
      const message = await registry.resolve(query.data.account).imap.getEmail(query.data.ref);
      return res.json({ message: toEmailView(message, false, 20_000) });
    } catch (error) {
      const code = error instanceof ConnectorError ? error.code : '';
      return res.status(code === 'ACCOUNT_NOT_FOUND' || code === 'MESSAGE_NOT_FOUND' ? 404 : code === 'ACCOUNT_MISMATCH' ? 400 : 502)
        .json({ error: 'Message unavailable or does not belong to the selected account.' });
    }
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
        const hadDefault = Boolean(registry.defaultAccountId);
        await store.upsert(complete);
        registry.upsert(createMailAccountRuntime(toConfig(complete, baseConfig), 'ui'));
        if (!hadDefault) {
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
      const id = z.object({ id: AccountIdSchema }).parse(req.body).id;
      await mutate(async () => {
        if (!registry.has(id)) throw new ConnectorError('ACCOUNT_NOT_FOUND', 'The requested mail account is not configured.');
        await store.setDefault(id);
        registry.setDefault(id);
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
