require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
// GB v3.0: Shopee queue + configurable batches 10-100 + persistent pagination + mass stock/NF-e + diagnostics
app.use(express.json({limit:"2mb"}));
app.use(express.urlencoded({extended:true}));
app.use(express.static(path.join(__dirname,"public")));

const PORT = Number(process.env.PORT || 3000);
const BLING_BASE = "https://api.bling.com.br/Api/v3";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname,"data");
const DATA_FILE = path.join(DATA_DIR,"store.json");
const CONFIG_FILE = path.join(DATA_DIR,"config.json");
function loadConfig(){
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE,"utf8")); }
  catch { return {}; }
}
function saveConfig(cfg){
  fs.mkdirSync(path.dirname(CONFIG_FILE),{recursive:true});
  fs.writeFileSync(CONFIG_FILE,JSON.stringify(cfg,null,2),"utf8");
}
function cfgValue(key){
  const cfg=loadConfig();
  return process.env[key] || cfg[key] || "";
}
const getClientId = ()=>cfgValue("BLING_CLIENT_ID");
const getClientSecret = ()=>cfgValue("BLING_CLIENT_SECRET");
const getRedirectUri = ()=>cfgValue("BLING_REDIRECT_URI") || `http://localhost:${PORT}/oauth/bling/callback`;
const APP_SECRET = cfgValue("APP_SECRET") || "troque-esta-chave-em-producao";

// Shopee Open Platform (produção)
const SHOPEE_BASE = "https://partner.shopeemobile.com";
const getShopeePartnerId = ()=>String(cfgValue("SHOPEE_PARTNER_ID") || "2042612").trim();
const getShopeePartnerKey = ()=>cfgValue("SHOPEE_PARTNER_KEY");
const getShopeeRedirectUri = ()=>process.env.SHOPEE_REDIRECT_URI || cfgValue("SHOPEE_REDIRECT_URI") || (process.env.RENDER_EXTERNAL_URL ? `${process.env.RENDER_EXTERNAL_URL.replace(/\/+$/, "")}/shopee/callback` : `http://localhost:${PORT}/shopee/callback`);
function shopeeSign(apiPath, timestamp){
  return crypto.createHmac("sha256",getShopeePartnerKey()).update(`${getShopeePartnerId()}${apiPath}${timestamp}`).digest("hex");
}
async function shopeeExchangeCode(code, shopId){
  const apiPath="/api/v2/auth/token/get";
  const timestamp=Math.floor(Date.now()/1000);
  const u=new URL(SHOPEE_BASE+apiPath);
  u.searchParams.set("partner_id",getShopeePartnerId());
  u.searchParams.set("timestamp",String(timestamp));
  u.searchParams.set("sign",shopeeSign(apiPath,timestamp));
  const r=await fetch(u,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code,shop_id:Number(shopId),partner_id:Number(getShopeePartnerId())})});
  const raw=await r.text(); let out; try{out=JSON.parse(raw)}catch{out={raw}};
  if(!r.ok || out.error) throw new Error(`Shopee OAuth ${r.status}: ${out.message||out.error||JSON.stringify(out)}`);
  return out;
}

function shopeeShopSign(apiPath,timestamp,token,shopId){
  const base=`${getShopeePartnerId()}${apiPath}${timestamp}${token}${shopId}`;
  return crypto.createHmac("sha256",getShopeePartnerKey()).update(base).digest("hex");
}
async function shopeePostPublic(apiPath,body){
  const timestamp=Math.floor(Date.now()/1000), u=new URL(SHOPEE_BASE+apiPath);
  u.searchParams.set("partner_id",getShopeePartnerId());
  u.searchParams.set("timestamp",String(timestamp));
  u.searchParams.set("sign",shopeeSign(apiPath,timestamp));
  const r=await fetch(u,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  const raw=await r.text(); let out; try{out=JSON.parse(raw)}catch{out={raw}};
  if(!r.ok || out.error) throw new Error(`Shopee ${r.status}: ${out.message||out.error||JSON.stringify(out)}`);
  return out;
}
async function ensureShopeeAccessToken(){
  const db=load(); let shop=db.shopee;
  if(!shop?.access_token || !shop?.shop_id) throw new Error("Conecte a loja Shopee nas Configurações para identificar a modalidade de entrega.");
  if(Number(shop.expire_at||0)>Date.now()+60000) return shop;
  if(!shop.refresh_token) throw new Error("Token Shopee expirado. Reconecte a loja nas Configurações.");
  const fresh=await shopeePostPublic("/api/v2/auth/access_token/get",{refresh_token:shop.refresh_token,partner_id:Number(getShopeePartnerId()),shop_id:Number(shop.shop_id)});
  shop={...shop,...fresh,shop_id:Number(shop.shop_id),partner_id:Number(getShopeePartnerId()),expire_at:Date.now()+Number(fresh.expire_in||14400)*1000};
  db.shopee=shop; save(db); return shop;
}
async function getShopeeOrderDetails(orderSns){
  const shop=await ensureShopeeAccessToken();
  const apiPath="/api/v2/order/get_order_detail", timestamp=Math.floor(Date.now()/1000);
  const u=new URL(SHOPEE_BASE+apiPath);
  u.searchParams.set("partner_id",getShopeePartnerId());
  u.searchParams.set("timestamp",String(timestamp));
  u.searchParams.set("access_token",shop.access_token);
  u.searchParams.set("shop_id",String(shop.shop_id));
  u.searchParams.set("sign",shopeeShopSign(apiPath,timestamp,shop.access_token,shop.shop_id));
  u.searchParams.set("order_sn_list",orderSns.join(","));
  u.searchParams.set("response_optional_fields","shipping_carrier,package_list");
  const r=await fetch(u); const raw=await r.text(); let out; try{out=JSON.parse(raw)}catch{out={raw}};
  if(!r.ok || out.error) throw new Error(`Shopee pedidos ${r.status}: ${out.message||out.error||JSON.stringify(out)}`);
  return out.response?.order_list||[];
}
async function classifyShopeeDelivery(rawOrders,wrappedOrders){
  const sns=[...new Set(rawOrders.map(o=>String(o.numeroLoja||o.numeroPedidoCompra||"").trim()).filter(x=>x && !/^\d+$/.test(x)))];
  if(!sns.length) return wrappedOrders.map(o=>({...o,deliveryType:"unknown",shippingCarrier:"",deliveryLabel:"Não identificado"}));
  const bySn=new Map();
  try{
    for(let i=0;i<sns.length;i+=50){
      const details=await getShopeeOrderDetails(sns.slice(i,i+50));
      for(const d of details){
        // A Shopee pode devolver nomes diferentes para a logística própria do vendedor.
        // Normalizamos acentos e espaços para evitar classificar Entrega Direta como envio normal.
        const carrier=String(d.shipping_carrier||d.package_list?.[0]?.shipping_carrier||"").trim();
        const carrierNorm=carrier.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/\s+/g," ");
        const direct=/entrega\s*direta|entrega\s*(?:pelo|do)\s*vendedor|logistica\s*(?:do|propria)\s*vendedor|logistica\s*propria|seller\s*(?:own\s*)?(?:fleet|delivery)|own\s*fleet|vendedor\s*(?:entrega|envio)|retirada\s*(?:pelo|no)\s*vendedor/.test(carrierNorm);
        const express=/shopee\s*(?:xpress|express)|spx(?:\s*express)?|spex/.test(carrierNorm);
        // Só marcamos como envio normal quando o nome identifica uma transportadora/modalidade conhecida.
        // Valores vazios ou desconhecidos ficam pendentes, nunca são classificados por suposição.
        const normal=/correios|jadlog|loggi|sequoia|total\s*express|azul\s*cargo|buslog|rede\s*sul|shopee\s*standard|standard\s*delivery|envio\s*normal/.test(carrierNorm);
        const deliveryType=direct?"direct":(express?"express":(normal?"normal":"unknown"));
        const deliveryLabel=direct?"Entrega Direta":(express?"Shopee Express":(normal?(carrier||"Envio normal"):(carrier||"Modalidade não identificada")));
        bySn.set(String(d.order_sn),{deliveryType,shippingCarrier:carrier,deliveryLabel});
      }
    }
  }catch(e){
    return wrappedOrders.map(o=>({...o,deliveryType:"unknown",shippingCarrier:"",deliveryLabel:"Shopee não consultada"}));
  }
  return wrappedOrders.map((o,i)=>{
    const sn=String(rawOrders[i]?.numeroLoja||rawOrders[i]?.numeroPedidoCompra||"").trim();
    const d=bySn.get(sn)||{deliveryType:"unknown",shippingCarrier:"",deliveryLabel:"Não identificado"};
    return {...o,...d};
  });
}


function load(){
  try { return JSON.parse(fs.readFileSync(DATA_FILE,"utf8")); }
  catch { return {tokens:null, alternatives:{}, local:{orders:{}, logs:[]}}; }
}
function save(db){
  fs.mkdirSync(DATA_DIR,{recursive:true});
  fs.writeFileSync(DATA_FILE, JSON.stringify(db,null,2),"utf8");
}
function b64url(v){return Buffer.from(v).toString("base64url")}
function sign(v){return crypto.createHmac("sha256",APP_SECRET).update(v).digest("base64url")}
function safeJson(res,code,obj){res.status(code).json(obj)}

async function blingToken(body){
  const auth = Buffer.from(`${getClientId()}:${getClientSecret()}`).toString("base64");
  const r = await fetch(`${BLING_BASE}/oauth/token`,{
    method:"POST",
    headers:{
      "Authorization":`Basic ${auth}`,
      "Content-Type":"application/x-www-form-urlencoded",
      "Accept":"1.0",
      "enable-jwt":"1"
    },
    body:new URLSearchParams(body)
  });
  const text=await r.text();
  let out; try{out=JSON.parse(text)}catch{out={raw:text}}
  if(!r.ok) throw new Error(`Bling OAuth ${r.status}: ${JSON.stringify(out)}`);
  return out;
}
async function refreshToken(){
  const db=load();
  if(!db.tokens?.refresh_token) throw new Error("Bling ainda nÃ£o foi conectado.");
  const t=await blingToken({grant_type:"refresh_token",refresh_token:db.tokens.refresh_token});
  db.tokens={...db.tokens,...t,updated_at:Date.now()};
  save(db); return db.tokens.access_token;
}
async function getToken(){
  const db=load();
  if(!db.tokens?.access_token) throw new Error("Bling ainda nÃ£o foi conectado.");
  // Refresh proactively when token is near expiry.
  const expires = Number(db.tokens.expires_in||0);
  const age = Date.now()-Number(db.tokens.updated_at||0);
  if(expires && age > (expires-120)*1000) return await refreshToken();
  return db.tokens.access_token;
}
// Bling API limiter: Bling returns 429 when more than 3 requests/second are sent.
let lastBlingRequestAt=0;
let blingQueue=Promise.resolve();
const BLING_MIN_INTERVAL=380;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function waitForBlingSlot(){
  const run=async()=>{
    const wait=Math.max(0, BLING_MIN_INTERVAL-(Date.now()-lastBlingRequestAt));
    if(wait) await sleep(wait);
    lastBlingRequestAt=Date.now();
  };
  const next=blingQueue.then(run,run);
  blingQueue=next.catch(()=>{});
  return next;
}
async function bling(method, endpoint, body, query, retry=true){
  await waitForBlingSlot();
  let token=await getToken();
  const u=new URL(BLING_BASE+endpoint);
  if(query) Object.entries(query).forEach(([k,v])=>{if(v!==undefined&&v!==null&&v!=="")u.searchParams.set(k,String(v))});
  const opts={method,headers:{"Authorization":`Bearer ${token}`,"Content-Type":"application/json","Accept":"1.0","enable-jwt":"1"}};
  if(body!==undefined) opts.body=JSON.stringify(body);
  const r=await fetch(u,opts);
  const text=await r.text(); let out; try{out=JSON.parse(text)}catch{out={raw:text}};
  if(r.status===401 && retry){await refreshToken();return bling(method,endpoint,body,query,false)}
  if(r.status===429 && retry){
    const retryAfter=Number(r.headers.get("retry-after")||0);
    await sleep(Math.max(1200,(retryAfter*1000)||1500));
    return bling(method,endpoint,body,query,false);
  }
  // Bling can occasionally return 502/503/504 while processing a request.
  // Retry a few times so one temporary timeout does not stop a mass operation.
  if([502,503,504].includes(r.status) && retry){
    const delays={502:2000,503:3000,504:4000};
    await sleep(delays[r.status]||3000);
    // One retry per API call is enough to avoid hammering Bling. The bulk
    // endpoint will isolate this order and continue with the next one.
    return bling(method,endpoint,body,query,false);
  }
  if(!r.ok) throw new Error(`Bling ${r.status}: ${JSON.stringify(out)}`);
  return out;
}

// OAuth
app.get("/oauth/bling",(req,res)=>{
  if(!getClientId()) return res.status(500).send("Configure o Bling em Configurações ou no arquivo .env");
  const state=b64url(`${Date.now()}.${sign(String(Date.now()))}`);
  const u=new URL("https://www.bling.com.br/Api/v3/oauth/authorize");
  u.searchParams.set("response_type","code");
  u.searchParams.set("client_id",getClientId());
  u.searchParams.set("state",state);
  u.searchParams.set("redirect_uri",getRedirectUri());
  res.redirect(u.toString());
});
app.get("/oauth/bling/callback",async(req,res)=>{
  try{
    if(!req.query.code) return res.status(400).send("Authorization code nÃ£o recebido.");
    const t=await blingToken({grant_type:"authorization_code",code:req.query.code,redirect_uri:getRedirectUri()});
    const db=load(); db.tokens={...t,updated_at:Date.now()}; save(db);
    res.redirect("/?connected=1");
  }catch(e){res.status(500).send(`<h2>Erro ao conectar Bling</h2><pre>${e.message}</pre>`)}
});
app.get("/api/config/bling",(req,res)=>{
  res.json({configured:Boolean(getClientId()), redirectUri:getRedirectUri(), clientIdMasked:getClientId()?getClientId().slice(0,6)+"••••":""});
});
app.post("/api/config/bling",(req,res)=>{
  const clientId=String(req.body?.clientId||"").trim();
  const clientSecret=String(req.body?.clientSecret||"").trim();
  if(!clientId || !clientSecret) return res.status(400).json({error:"Informe Client ID e Client Secret do Bling."});
  const redirectUri=String(req.body?.redirectUri||getRedirectUri()).trim();
  const cfg=loadConfig();
  cfg.BLING_CLIENT_ID=clientId;
  cfg.BLING_CLIENT_SECRET=clientSecret;
  cfg.BLING_REDIRECT_URI=redirectUri;
  cfg.APP_SECRET=cfg.APP_SECRET || process.env.APP_SECRET || crypto.randomBytes(32).toString("hex");
  try{saveConfig(cfg);}catch(e){return res.status(500).json({error:"Não foi possível salvar a configuração: "+e.message});}
  res.json({ok:true,configured:true,redirectUri,clientIdMasked:clientId.slice(0,6)+"••••"});
});
app.get("/api/config/shopee",(req,res)=>{
  const db=load();
  res.json({configured:Boolean(getShopeePartnerId() && getShopeePartnerKey()),partnerId:getShopeePartnerId(),partnerKeyConfigured:Boolean(getShopeePartnerKey()),redirectUri:getShopeeRedirectUri(),connected:Boolean(db.shopee?.access_token),shopId:db.shopee?.shop_id||null});
});
app.post("/api/config/shopee",(req,res)=>{
  const partnerId=String(req.body?.partnerId||getShopeePartnerId()).trim();
  const partnerKey=String(req.body?.partnerKey||"").trim();
  const redirectUri=String(req.body?.redirectUri||getShopeeRedirectUri()).trim();
  if(!partnerId || !/^\d+$/.test(partnerId)) return res.status(400).json({error:"Informe o Partner ID numérico da Shopee."});
  if(!partnerKey && !getShopeePartnerKey()) return res.status(400).json({error:"Informe a Partner Key Live da Shopee. Ela ficará salva somente no servidor."});
  const cfg=loadConfig(); cfg.SHOPEE_PARTNER_ID=partnerId; if(partnerKey) cfg.SHOPEE_PARTNER_KEY=partnerKey; cfg.SHOPEE_REDIRECT_URI=redirectUri;
  try{saveConfig(cfg)}catch(e){return res.status(500).json({error:"Não foi possível salvar: "+e.message})}
  res.json({ok:true,partnerId,redirectUri,partnerKeyConfigured:true});
});
app.get("/shopee/authorize",(req,res)=>{
  if(!getShopeePartnerId() || !getShopeePartnerKey()) return res.status(400).send("Configure Partner ID e Partner Key Live da Shopee nas Configurações.");
  const state=crypto.randomBytes(24).toString("hex");
  const db=load(); db.shopeeOAuthState=state; save(db);
  const u=new URL("https://open.shopee.com/auth");
  u.searchParams.set("partner_id",getShopeePartnerId());
  u.searchParams.set("auth_type","seller");
  u.searchParams.set("redirect_uri",getShopeeRedirectUri());
  u.searchParams.set("response_type","code");
  u.searchParams.set("state",state);
  res.redirect(u.toString());
});
app.get("/shopee/callback",async(req,res)=>{
  try{
    const code=String(req.query.code||"");
    const dbBefore=load();
    if(!req.query.state || !dbBefore.shopeeOAuthState || String(req.query.state)!==String(dbBefore.shopeeOAuthState)) return res.status(400).send("Estado de autorização inválido ou expirado. Tente conectar novamente.");
    const shopId=String(req.query.shop_id||"");
    if(req.query.error) return res.status(400).send(`<h2>Autorização Shopee não concluída</h2><p>${String(req.query.error)}</p>`);
    if(!code || !shopId) return res.status(400).send("Retorno Shopee incompleto: faltou code ou shop_id.");
    if(!getShopeePartnerKey()) return res.status(500).send("Configure SHOPEE_PARTNER_KEY no sistema antes de autorizar a loja.");
    const token=await shopeeExchangeCode(code,shopId);
    const db=load(); db.shopee={...token,shop_id:Number(shopId),partner_id:Number(getShopeePartnerId()),updated_at:Date.now(),expire_at:Date.now()+Number(token.expire_in||14400)*1000}; delete db.shopeeOAuthState; save(db);
    res.redirect("/?shopee_connected=1");
  }catch(e){res.status(500).send(`<h2>Erro ao conectar Shopee</h2><pre>${String(e.message).replace(/[<>&]/g,c=>({"<":"&lt;",">":"&gt;","&":"&amp;"}[c]))}</pre>`)}
});
app.get("/api/status",(req,res)=>{
  const db=load();
  res.json({blingConnected:Boolean(db.tokens?.access_token),hasRefresh:Boolean(db.tokens?.refresh_token),shopeeConnected:Boolean(db.shopee?.access_token),shopeeShopId:db.shopee?.shop_id||null,channel:"Shopee",rateLimitPerSecond:3});
});

// Cache the Shopee channel/loja IDs so we do not call /canais-venda for every refresh.
let shopeeChannelCache={ids:new Set(),expiresAt:0};
async function getShopeeChannelIds(){
  if(shopeeChannelCache.expiresAt>Date.now() && shopeeChannelCache.ids.size) return shopeeChannelCache.ids;
  const ids=new Set();
  try{
    const r=await bling("GET","/canais-venda",undefined,{pagina:1,limite:100});
    for(const c of (r.data||[])){
      const label=[c.nome,c.descricao,c.tipo,c.nomeIntegracao,c.nomeLoja].filter(Boolean).join(" ").toLowerCase();
      if(label.includes("jb auto peças - shopee") || label.includes("jb auto pecas - shopee")) ids.add(String(c.id));
    }
  }catch(e){
    // Keep old cache if the channel endpoint is temporarily unavailable.
  }
  if(ids.size) shopeeChannelCache={ids,expiresAt:Date.now()+10*60*1000};
  return shopeeChannelCache.ids;
}
function channelLabel(o){
  return [
    o?.loja?.nome,o?.loja?.descricao,o?.loja?.nomeIntegracao,o?.loja?.nomeLoja,
    o?.canalVenda?.nome,o?.canalVenda?.descricao,o?.canalVenda?.nomeIntegracao,
    o?.canalVenda?.nomeLoja,o?.integracao?.nome,o?.integracao?.descricao,
    o?.origem?.nome,o?.origem?.descricao,o?.numeroLoja,o?.numeroPedidoCompra,
    o?.observacao,o?.observacoes,o?.observacaoInterna
  ].filter(Boolean).join(" ").toLowerCase();
}

function isShopeeListedOrder(o, ids){
  const lojaId=o?.loja?.id;
  if(lojaId!=null) return ids.has(String(lojaId));
  const label=channelLabel(o);
  return label.includes("jb auto peças - shopee") || label.includes("jb auto pecas - shopee");
}

function shopeeFilterAllowsInitial(o, ids){
  // A listagem pode omitir a loja; nesse caso ela será validada no detalhe.
  // Se a listagem informar uma loja, só aceitamos JB AUTO PEÇAS - SHOPEE.
  const lojaId=o?.loja?.id;
  if(lojaId!=null) return ids.has(String(lojaId));
  return true;
}

// Cache order details briefly so clicking "Atualizar" does not re-download
// the same 40 orders from Bling every time. New orders still go to Bling.
const salesOrderDetailCache=new Map();
const SALES_ORDER_CACHE_MS=45000;
async function getSalesOrderDetailCached(id){
  const key=String(id);
  const cached=salesOrderDetailCache.get(key);
  if(cached && Date.now()-cached.at<SALES_ORDER_CACHE_MS) return cached.order;
  const raw=await bling("GET",`/pedidos/vendas/${id}`);
  const order=raw?.data || raw;
  salesOrderDetailCache.set(key,{order,at:Date.now()});
  return order;
}

async function mapConcurrent(items, concurrency, fn){
  const out=new Array(items.length);
  let cursor=0;
  async function worker(){
    while(true){
      const i=cursor++;
      if(i>=items.length) return;
      try{out[i]=await fn(items[i],i)}catch(e){out[i]={__error:e};}
    }
  }
  await Promise.all(Array.from({length:Math.min(concurrency,items.length)},worker));
  return out;
}

// Situações que não podem gerar NF-e.
// O Bling pode devolver a situação como objeto ({id, valor, nome/descricao}).
// Não assumimos um ID numérico fixo: usamos os textos quando disponíveis
// e, como última proteção, tratamos explicitamente o erro 74 do Bling.
function orderStatusText(o){
  const s=o?.situacao;
  if(s==null) return "";
  if(typeof s==="string" || typeof s==="number") return String(s).toLowerCase();
  return [
    s.nome, s.descricao, s.valor, s.label, s.name,
    s.situacao, s.status
  ].filter(v=>v!==undefined && v!==null).join(" ").toLowerCase();
}

function isCancelledOrder(o){
  const text=orderStatusText(o);
  return /cancelad|cancelled|cancellation/.test(text);
}

function isCancellationError(err){
  const msg=String(err?.message || err || "").toLowerCase();
  return (
    msg.includes('"code":74') ||
    msg.includes('"code":"74"') ||
    msg.includes("código 74") ||
    msg.includes("codigo 74") ||
    msg.includes("pedido de venda está cancelado") ||
    msg.includes("pedido de venda esta cancelado") ||
    msg.includes("situação personalizada") && msg.includes("cancelamento") ||
    msg.includes("situacao personalizada") && msg.includes("cancelamento")
  );
}

function cancelledReason(o){
  return `Pedido cancelado no Bling${o?.numero ? ` (#${o.numero})` : ""}. Não será enviada NF-e.`;
}

function isOrderAlreadyInvoiced(o){
  const text=[o?.situacao, o?.situacao?.nome, o?.notaFiscal?.situacao, o?.notaFiscal?.numero, o?.nfse?.numero]
    .filter(Boolean).join(" ").toLowerCase();
  return /faturad|emitid|conclu[ií]d|nota fiscal|nfe|nf-e/.test(text);
}

function matchesRequestedSituation(o, requested){
  const text=orderStatusText(o);
  const id=String(o?.situacao?.id ?? "").trim();
  // IDs padrão de situação de pedido de venda do Bling:
  // 6=Em aberto, 9=Atendido, 12=Cancelado, 15=Em andamento.
  // O retorno da API pode trazer somente o ID/valor, por isso não podemos
  // depender apenas do texto "andamento".
  if(requested==="andamento") return id==="15" || /andamento|em andamento|processing|processando/.test(text);
  if(requested==="aberto") return id==="6" || /aberto|em aberto|open/.test(text);
  if(requested==="atendido") return id==="9" || /atendido|faturad|conclu[ií]d|completed/.test(text);
  if(requested==="cancelado") return id==="12" || /cancelad|cancelled|cancellation/.test(text);
  return true;
}

function isAndamentoOrder(o){
  const text=orderStatusText(o);
  if(!text) return false;
  return /(^|\s)(andamento|em andamento|processing|processando)(\s|$)/.test(text);
}

function existingNfeId(o){
  return extractNfeIdFromOrder(o) || null;
}

async function getNfe(id){
  return await bling("GET",`/nfe/${id}`);
}

function nfeStatusText(n){
  const s=n?.situacao;
  if(s==null) return "";
  if(typeof s==="string" || typeof s==="number") return String(s).toLowerCase();
  return [s.nome,s.descricao,s.valor,s.label,s.name,s.situacao,s.status].filter(v=>v!==undefined&&v!==null).join(" ").toLowerCase();
}

function nfeIsAuthorized(n){
  const text=nfeStatusText(n);
  return /autorizad|authorized|aprovad|approved|emitid|emitida/.test(text);
}

function nfeIsRejected(n){
  const text=nfeStatusText(n);
  return /rejeitad|rejected|denegad|cancelad|erro|error/.test(text);
}

async function waitForNfeResult(nfeId, attempts=20){
  let last=null;
  for(let attempt=0; attempt<attempts; attempt++){
    if(attempt>0) await sleep(1000);
    try{
      last=await getNfe(nfeId);
      if(nfeIsAuthorized(last) || nfeIsRejected(last)) return last;
    }catch(e){}
  }
  return last;
}

// Filtros manuais da tela de Pedidos de Vendas.
app.get("/api/sales-filters",async(req,res)=>{
  try{
    const r=await bling("GET","/canais-venda",undefined,{pagina:1,limite:100});
    const canais=(r.data||[]).map(c=>({
      id:c.id,
      nome:c.nome||c.nomeLoja||c.descricao||c.nomeIntegracao||`Canal ${c.id}`
    })).filter(c=>c.id!=null);
    const situacoes=[
      {value:"andamento",label:"Andamento"},
      {value:"aberto",label:"Aberto / Em aberto"},
      {value:"atendido",label:"Atendido"},
      {value:"cancelado",label:"Cancelado"},
      {value:"todos",label:"Todas as situações"}
    ];
    res.json({ok:true,lojas:canais,situacoes});
  }catch(e){safeJson(res,500,{error:e.message})}
});

// Orders from Bling
app.get("/api/orders",async(req,res)=>{
  try{
    const requested=Math.min(Math.max(Number(req.query.limite||40),1),100);
    const lojaId=String(req.query.lojaId||"").trim();
    const situacao=String(req.query.situacao||"andamento").trim().toLowerCase();
    const dataInicial=String(req.query.dataInicial||"").trim();
    const dataFinal=String(req.query.dataFinal||"").trim();
    const manualStore=lojaId && lojaId!=="todas" ? lojaId : null;
    const deliveryMode=String(req.query.entrega||"todas").trim().toLowerCase();
    const validDeliveryModes=new Set(["todas","direta","express","normal"]);
    if(!validDeliveryModes.has(deliveryMode)) return safeJson(res,400,{error:"Filtro de entrega inválido."});
    const db=load();
    const startPage=Math.min(Math.max(Number(req.query.pagina||1),1),100);
    const detailed=[];
    const preclassifiedOrders=[];
    const seen=new Set();
    let pagesScanned=0, candidatesFound=0, detailErrors=0, rejectedChannel=0, skippedLocal=0;
    const clientExclude=new Set(
      String(req.query.exclude||"")
        .split(",")
        .map(v=>v.trim())
        .filter(Boolean)
    );

    // Scan Bling list pages, but fetch order details in small parallel groups.
    // The global Bling limiter still enforces <=3 requests/second.
    for(let page=startPage; page<=100 && detailed.length<requested; page++){
      pagesScanned++;
      const situationIds={andamento:15,aberto:6,atendido:9,cancelado:12};
      const listQuery={pagina:page,limite:100};
      if(dataInicial) listQuery.dataInicial=dataInicial;
      if(dataFinal) listQuery.dataFinal=dataFinal;
      if(situationIds[situacao]) listQuery.idSituacao=situationIds[situacao];
      const r=await bling("GET","/pedidos/vendas",undefined,listQuery);
      const arr=r.data||[];
      if(!arr.length) break;

      const candidates=arr.filter(x=>{
        const id=String(x.id||"");
        if(!id || seen.has(id) || clientExclude.has(id)) return false;
        if(manualStore){
          const listedLoja=String(x?.loja?.id||"");
          if(listedLoja && listedLoja!==manualStore) return false;
        }
        return true;
      });
      candidates.forEach(x=>seen.add(String(x.id)));
      candidatesFound += candidates.length;

      // Process in chunks so we don't launch hundreds of detail requests when
      // the account has many non-Shopee orders.
      for(let pos=0;pos<candidates.length && detailed.length<requested;pos+=6){
        const chunk=candidates.slice(pos,pos+6);
        const results=await mapConcurrent(chunk,3,async x=>{
          try{return await getSalesOrderDetailCached(x.id)}catch(e){detailErrors++; return {...x,__error:true,__detailError:e.message};}
        });
        const accepted=[];
        for(let k=0;k<results.length;k++){
          const detail=results[k];
          if(!detail || detail.__error) continue;
          const id=String(detail.id||chunk[k]?.id||"");
          if(!id || clientExclude.has(id)) continue;
          if(manualStore && String(detail?.loja?.id||"")!==manualStore) { rejectedChannel++; continue; }
          if(situacao!=="todos" && !matchesRequestedSituation(detail,situacao)) { skippedLocal++; continue; }
          const local=db.local.orders[id]||{};
          if(local.nfeGeneratedAt || local.hiddenFromQueueAt){skippedLocal++; continue;}
          if(isOrderAlreadyInvoiced(detail)){skippedLocal++; continue;}
          accepted.push(detail);
        }
        if(deliveryMode==="todas"){
          for(const detail of accepted){
            if(detailed.length>=requested) break;
            detailed.push(detail);
          }
        }else if(accepted.length){
          // Classifica os pedidos antes de preencher o lote, para não devolver
          // menos de N pedidos só porque os tipos de entrega vieram misturados.
          const wrapped=accepted.map(wrapOrder(db));
          let classified;
          if(db.shopee?.access_token){
            classified=await classifyShopeeDelivery(accepted,wrapped);
          }else{
            classified=wrapped.map(o=>({...o,deliveryType:"unknown",shippingCarrier:"",deliveryLabel:"Conecte a Shopee"}));
          }
          const wanted={direta:"direct",express:"express",normal:"normal"}[deliveryMode];
          for(let k=0;k<accepted.length && detailed.length<requested;k++){
            if(classified[k]?.deliveryType===wanted){
              detailed.push(accepted[k]);
              preclassifiedOrders.push(classified[k]);
            }
          }
        }
      }

      if(arr.length<100) break;
    }

    let orders;
    if(deliveryMode!=="todas"){
      orders=preclassifiedOrders.slice(0,requested);
    }else{
      orders=detailed.map(wrapOrder(db)).slice(0,requested);
      if(db.shopee?.access_token){
        orders=await classifyShopeeDelivery(detailed.slice(0,requested),orders);
      }else{
        orders=orders.map(o=>({...o,deliveryType:"unknown",shippingCarrier:"",deliveryLabel:"Conecte a Shopee"}));
      }
    }
    res.json({
      orders,
      rawCount:orders.length,
      shopeeCount:orders.length,
      requested,
      channel:manualStore||"Todas as lojas",
      situation:situacao,
      deliveryMode,
      pagesScanned,
      candidatesFound,
      detailErrors,
      rejectedChannel,
      skippedLocal,
      nextPage: pagesScanned ? Math.min(100,startPage + pagesScanned) : null,
      nextBatchSupported:true,
      serverVersion:"3.11.3"
    });
  }catch(e){safeJson(res,500,{error:e.message})}
});

function wrapOrder(db){
  return o=>{
    const id=o.id;
    const local=db.local.orders[id]||{};
    const items=(o.itens||[]).map(i=>{
      const pid=i.produto?.id;
      const code=i.produto?.codigo || i.codigo || "";
      const qty=Number(i.quantidade||0);
      const stock=Number(i._stock ?? -1);
      const alt=db.alternatives[code]||null;
      return {id:i.id,productId:pid,sku:code,name:i.descricao||i.produto?.nome||"",qty,stock,alternative:alt,confirmed:Boolean(local.confirmed?.[i.id])};
    });
    const hasUnknown=items.some(i=>i.stock<0);
    const cancelled=isCancelledOrder(o);
    const available=!cancelled && items.every(i=>i.stock>=i.qty);
    return {id,number:o.numero,orderSn:o.numeroLoja||o.numeroPedidoCompra||"",channel:o.loja?.nome||"Bling",date:o.data||o.dataSaida||"",client:o.contato?.nome||"",total:o.total||0,situacao:o.situacao,items,available,hasUnknown,cancelled,cancelledReason:cancelled?cancelledReason(o):"",local};
  };
}

// Stock lookup + order details
app.get("/api/orders/:id",async(req,res)=>{
  try{
    const db=load();
    const o=await bling("GET",`/pedidos/vendas/${req.params.id}`);
    for(const i of (o.itens||[])){
      if(i.produto?.id){
        try{
          const s=await bling("GET","/estoques/saldos",undefined,{"idsProdutos[]":i.produto.id});
          i._stock=stockTotal(s);
        }catch{i._stock=-1}
      }else i._stock=-1;
    }
    res.json(wrapOrder(db)(o));
  }catch(e){safeJson(res,500,{error:e.message})}
});
function stockTotal(r){
  const d=r?.data;
  if(Array.isArray(d)){
    return d.reduce((total,x)=>{
      const n=Number(x?.saldoFisicoTotal ?? x?.saldoVirtualTotal ?? x?.saldoFisico ?? 0);
      return total + (Number.isFinite(n)?n:0);
    },0);
  }
  if(d && typeof d==="object"){
    const n=Number(d.saldoFisicoTotal ?? d.saldoVirtualTotal ?? d.saldoFisico ?? 0);
    return Number.isFinite(n)?n:0;
  }
  return 0;
}

// Massa: consulta de estoque com espaÃ§amento para respeitar o limite do Bling.
const stockCache=new Map();
const orderDetailCache=new Map();
async function getStockCached(productId){
  const key=String(productId);
  const cached=stockCache.get(key);
  if(cached && Date.now()-cached.at<30000) return cached.stock;
  const s=await bling("GET","/estoques/saldos",undefined,{"idsProdutos[]":productId});
  const stock=stockTotal(s);
  stockCache.set(key,{stock,at:Date.now()});
  await sleep(350);
  return stock;
}
async function detailWithStock(id){
  const key=String(id);
  const cached=orderDetailCache.get(key);
  if(cached && Date.now()-cached.at<15000) return cached.order;

  const raw=await bling("GET",`/pedidos/vendas/${id}`);
  const o=raw?.data || raw;
  for(const i of (o.itens||[])){
    if(i.produto?.id){
      try{i._stock=await getStockCached(i.produto.id)}catch{i._stock=-1}
    }else i._stock=-1;
  }
  orderDetailCache.set(key,{order:o,at:Date.now()});
  return o;
}

// Confere vÃ¡rios pedidos de uma vez. NÃ£o baixa estoque e nÃ£o altera o pedido.
app.post("/api/orders/check-stock",async(req,res)=>{
  try{
    const ids=Array.isArray(req.body?.ids)?req.body.ids.map(String).filter(id=>id && id!=="undefined" && id!=="null").slice(0,50):[];
    if(!ids.length) return safeJson(res,400,{error:"Selecione pelo menos um pedido."});
    const db=load(); const out=[];
    for(let n=0;n<ids.length;n++){
      const id=ids[n];
      try{
        const o=await detailWithStock(id);
        out.push(wrapOrder(db)(o));
      }catch(e){
        // Keep the original order data on the client. A failed Bling request
        // must never replace a real order with an empty/incomplete object.
        out.push({id:Number(id)||id,__checkError:true,error:e.message});
      }
    }
    const available=out.filter(o=>o.available&&!o.hasUnknown).length;
    const blocked=out.length-available;
    res.json({orders:out,available,blocked,checked:out.length});
  }catch(e){safeJson(res,500,{error:e.message})}
});

// Confirm a picked item locally. Does NOT alter Bling stock.
app.post("/api/orders/:id/confirm-item",async(req,res)=>{
  try{
    const {itemId}=req.body;
    const db=load(); db.local.orders[req.params.id] ||= {}; db.local.orders[req.params.id].confirmed ||= {};
    db.local.orders[req.params.id].confirmed[itemId]=true;
    db.local.orders[req.params.id].updatedAt=Date.now(); save(db);
    res.json({ok:true});
  }catch(e){safeJson(res,500,{error:e.message})}
});

// Alternatives: manually map one SKU to another product ID/code.
app.get("/api/alternatives",(req,res)=>res.json(load().alternatives));
app.post("/api/alternatives",(req,res)=>{
  const {sku,productId,alternativeSku,name}=req.body;
  if(!sku||!productId||!alternativeSku) return safeJson(res,400,{error:"sku, productId e alternativeSku sÃ£o obrigatÃ³rios"});
  const db=load(); db.alternatives[sku]={productId:Number(productId),sku:alternativeSku,name:name||alternativeSku}; save(db);
  res.json({ok:true,alternative:db.alternatives[sku]});
});

// Replace an out-of-stock item in the actual Bling sales order.
// IMPORTANT: this updates the sales order; it does not directly launch stock.
app.post("/api/orders/:id/use-alternative",async(req,res)=>{
  try{
    const {itemId,alternativeProductId}=req.body;
    if(!itemId||!alternativeProductId) return safeJson(res,400,{error:"itemId e alternativeProductId sÃ£o obrigatÃ³rios"});
    const order=await bling("GET",`/pedidos/vendas/${req.params.id}`);
    const item=order.itens?.find(x=>String(x.id)===String(itemId));
    if(!item) return safeJson(res,404,{error:"Item nÃ£o encontrado"});
    const p=await bling("GET",`/produtos/${alternativeProductId}`);
    const newItems=(order.itens||[]).map(x=>String(x.id)===String(itemId)?{
      ...x,
      produto:{id:p.data?.id||p.id},
      descricao:p.data?.nome||p.nome||x.descricao,
      codigo:p.data?.codigo||p.codigo||x.codigo
    }:x);
    const payload={...order,itens:newItems};
    delete payload.id; // PUT expects resource body without path id in many integrations
    const updated=await bling("PUT",`/pedidos/vendas/${req.params.id}`,payload);
    res.json({ok:true,data:updated});
  }catch(e){safeJson(res,500,{error:e.message})}
});

// After creating the NF-e from the sales order, explicitly send it to SEFAZ.
// Bling separates creation of the NF-e from the /nfe/{id}/enviar action.
function extractNfeId(result){
  const candidates=[
    result?.data?.id, result?.id,
    result?.data?.notaFiscal?.id, result?.notaFiscal?.id,
    result?.data?.nfe?.id, result?.nfe?.id,
    result?.data?.nota?.id, result?.nota?.id
  ];
  const id=candidates.find(v=>v!==undefined && v!==null && String(v).trim()!=="");
  return id!=null?String(id):null;
}

// Depois de gerar a NF-e pelo pedido, o Bling pode retornar apenas uma
// confirmação da operação, sem o ID da NF-e no corpo da resposta. Nesse
// cenário, consultamos novamente o pedido até o vínculo da nota aparecer.
function extractNfeIdFromOrder(order){
  const direct=[
    order?.notaFiscal?.id, order?.nota?.id, order?.nfe?.id,
    order?.notasFiscais?.[0]?.id, order?.notas?.[0]?.id,
    order?.documentoFiscal?.id, order?.documento?.id
  ];
  const id=direct.find(v=>v!==undefined && v!==null && String(v).trim()!=="");
  return id!=null?String(id):null;
}

async function waitForNfeIdFromOrder(orderId, attempts=10){
  for(let attempt=0; attempt<attempts; attempt++){
    if(attempt>0) await sleep(900);
    try{
      const order=await bling("GET",`/pedidos/vendas/${orderId}`);
      const id=extractNfeIdFromOrder(order);
      if(id) return id;
    }catch(e){}
  }
  return null;
}

async function generateAndSendNfe(orderId){
  // First check whether Bling already has a note linked to this order.
  const current=await bling("GET",`/pedidos/vendas/${orderId}`);
  const linkedId=existingNfeId(current);
  if(linkedId){
    const existing=await getNfe(linkedId).catch(()=>null);
    if(existing && nfeIsAuthorized(existing)) return {created:existing,nfeId:linkedId,sent:existing,sendError:null,alreadyExists:true};
    try{
      const sent=await bling("POST",`/nfe/${linkedId}/enviar`,undefined,{enviarEmail:false});
      const finalNfe=await waitForNfeResult(linkedId,20);
      if(finalNfe && nfeIsRejected(finalNfe)) return {created:finalNfe,nfeId:linkedId,sent,sendError:`A NF-e existente foi rejeitada/cancelada pelo Bling: ${nfeStatusText(finalNfe)}`};
      return {created:finalNfe||existing||{id:linkedId},nfeId:linkedId,sent,sendError:null,alreadyExists:true};
    }catch(e){
      return {created:existing||{id:linkedId},nfeId:linkedId,sent:null,sendError:e.message,alreadyExists:true};
    }
  }

  const created=await bling("POST",`/pedidos/vendas/${orderId}/gerar-nfe`);
  let nfeId=extractNfeId(created);
  if(!nfeId) nfeId=await waitForNfeIdFromOrder(orderId,15);
  if(!nfeId){
    return {created,nfeId:null,sent:null,sendError:"O Bling confirmou a geração da NF-e, mas o ID da nota ainda não apareceu. A operação não será repetida automaticamente."};
  }
  try{
    const sent=await bling("POST",`/nfe/${nfeId}/enviar`,undefined,{enviarEmail:false});
    const finalNfe=await waitForNfeResult(nfeId,20);
    if(finalNfe && nfeIsRejected(finalNfe)){
      return {created:finalNfe,nfeId,sent,sendError:`A NF-e foi criada, mas o Bling retornou situação de rejeição/cancelamento: ${nfeStatusText(finalNfe)}`};
    }
    return {created:finalNfe||created,nfeId,sent,sendError:null};
  }catch(e){
    return {created,nfeId,sent:null,sendError:e.message};
  }
}

// Final action: validate current stock, then generate NF-e from sales order.
// No stock write is performed by this application.
app.post("/api/orders/:id/generate-nfe",async(req,res)=>{
  try{
    const order=await detailWithStock(req.params.id);

    // Não tentar gerar NF-e para pedido cancelado.
    if(isCancelledOrder(order)){
      const db=load();
      db.local.orders[req.params.id] ||= {};
      db.local.orders[req.params.id].cancelledAt ||= Date.now();
      db.local.orders[req.params.id].cancelledReason=cancelledReason(order);
      save(db);
      return safeJson(res,409,{
        blocked:true,
        cancelled:true,
        reason:cancelledReason(order),
        id:req.params.id,
        number:order.numero
      });
    }

    const checked=[];
    for(const i of (order.itens||[])){
      if(!i.produto?.id) return safeJson(res,409,{error:`Item ${i.descricao||""} sem produto vinculado.`});
      checked.push({itemId:i.id,sku:i.produto.codigo||i.codigo,qty:Number(i.quantidade||0),stock:Number(i._stock||0)});
    }
    const missing=checked.filter(x=>x.stock<x.qty);
    if(missing.length) return safeJson(res,409,{error:"Pedido bloqueado: hÃ¡ item sem estoque.",missing});
    const result=await generateAndSendNfe(req.params.id);
    const db=load(); db.local.orders[req.params.id] ||= {};
    db.local.orders[req.params.id].nfeId=result.nfeId;
    db.local.orders[req.params.id].nfe=result.created;
    if(!result.sendError) db.local.orders[req.params.id].nfeGeneratedAt=Date.now();
    if(result.sent){
      db.local.orders[req.params.id].nfeSentAt=Date.now();
      db.local.orders[req.params.id].nfeSendResult=result.sent;
    }
    save(db);
    if(result.sendError){
      return safeJson(res,502,{ok:false,created:true,nfeId:result.nfeId,error:`NF-e criada no Bling, mas não foi enviada à SEFAZ. ${result.sendError}`,data:result.created});
    }
    res.json({ok:true,message:`NF-e criada e enviada para a SEFAZ no Bling (NF-e ${result.nfeId}).`,data:result});
  }catch(e){
    // Código 74 = pedido cancelado/situação baseada em cancelamento.
    // Não tratar como falha geral nem repetir a tentativa.
    if(isCancellationError(e)){
      const db=load();
      db.local.orders[req.params.id] ||= {};
      db.local.orders[req.params.id].cancelledAt ||= Date.now();
      db.local.orders[req.params.id].cancelledReason="Pedido cancelado no Bling. NF-e não gerada.";
      save(db);
      return safeJson(res,409,{
        blocked:true,
        cancelled:true,
        reason:"Pedido cancelado no Bling. NF-e não gerada.",
        id:req.params.id
      });
    }
    safeJson(res,500,{error:e.message})
  }
});

// GeraÃ§Ã£o em massa: confere novamente cada pedido e sÃ³ envia ao Bling os que tÃªm estoque.
app.post("/api/orders/bulk-generate-nfe",async(req,res)=>{
  try{
    const ids=Array.isArray(req.body?.ids)?req.body.ids.map(String).filter(Boolean).slice(0,50):[];
    if(!ids.length) return safeJson(res,400,{error:"Selecione pelo menos um pedido."});
    const db=load(), generated=[], blocked=[], errors=[];

    // SeguranÃ§a: o lote aceita somente pedidos que o Bling identifica como Shopee.
    for(const id of ids){
      try{
        const o=await detailWithStock(id);

        // Pedido cancelado nunca entra na etapa de estoque/NF-e.
        if(isCancelledOrder(o)){
          db.local.orders[id] ||= {};
          db.local.orders[id].cancelledAt ||= Date.now();
          db.local.orders[id].cancelledReason=cancelledReason(o);
          blocked.push({
            id,
            number:o.numero,
            reason:cancelledReason(o),
            cancelled:true
          });
          continue;
        }

        // A loja deste sistema é exclusivamente Shopee.
        const missing=[];
        for(const i of (o.itens||[])){
          if(!i.produto?.id || Number(i._stock||0)<Number(i.quantidade||0)){
            missing.push({sku:i.produto?.codigo||i.codigo||"",qty:Number(i.quantidade||0),stock:Number(i._stock||0)});
          }
        }
        if(missing.length){blocked.push({id,number:o.numero,missing});continue}

        // Evita repetir a geraÃ§Ã£o dentro do prÃ³prio aplicativo.
        if(db.local.orders[id]?.nfeGeneratedAt){
          blocked.push({id,number:o.numero,reason:"NF-e jÃ¡ processada por este aplicativo."});
          continue;
        }

        const result=await generateAndSendNfe(id);
        db.local.orders[id] ||= {};
        db.local.orders[id].nfeId=result.nfeId;
        db.local.orders[id].nfe=result.created;
        if(!result.sendError) db.local.orders[id].nfeGeneratedAt=Date.now();
        if(result.sent){
          db.local.orders[id].nfeSentAt=Date.now();
          db.local.orders[id].nfeSendResult=result.sent;
        }
        if(result.sendError){
          errors.push(`Pedido #${id}: NF-e ${result.nfeId||"criada"} no Bling, mas não enviada à SEFAZ. ${result.sendError}`);
        }else{
          generated.push({id,number:o.numero,nfeId:result.nfeId});
        }
      }catch(e){
        if(isCancellationError(e)){
          db.local.orders[id] ||= {};
          db.local.orders[id].cancelledAt ||= Date.now();
          db.local.orders[id].cancelledReason="Pedido cancelado no Bling. NF-e não gerada.";
          blocked.push({
            id,
            reason:"Pedido cancelado no Bling. NF-e não gerada.",
            cancelled:true
          });
        }else{
          errors.push(`Pedido #${id}: ${e.message}`);
        }
      }
    }
    save(db);
    res.json({ok:true,generated:generated.length,blocked:blocked.length,generatedOrders:generated,blockedOrders:blocked,errors});
  }catch(e){safeJson(res,500,{error:e.message})}
});

app.post("/api/orders/hide-processed",async(req,res)=>{
  try{
    const ids=Array.isArray(req.body?.ids)?req.body.ids.map(String).filter(Boolean).slice(0,100):[];
    if(!ids.length) return safeJson(res,400,{error:"Nenhum pedido informado."});
    const db=load();
    for(const id of ids){
      db.local.orders[id] ||= {};
      db.local.orders[id].hiddenFromQueueAt=Date.now();
    }
    save(db);
    res.json({ok:true,hidden:ids.length});
  }catch(e){safeJson(res,500,{error:e.message})}
});

app.get("/api/nfe",async(req,res)=>{
  try{
    const r=await bling("GET","/nfe",undefined,{pagina:Number(req.query.pagina||1),limite:100});
    res.json(r);
  }catch(e){safeJson(res,500,{error:e.message})}
});

// Optional explicit SEFAZ send. Disabled unless ENABLE_SEND_NFE=true.
app.post("/api/nfe/:id/send",async(req,res)=>{
  if(process.env.ENABLE_SEND_NFE!=="true") return safeJson(res,403,{error:"Envio Ã  SEFAZ desativado. Defina ENABLE_SEND_NFE=true depois de validar sua operaÃ§Ã£o fiscal."});
  try{
    const r=await bling("POST",`/nfe/${req.params.id}/enviar`,undefined,{enviarEmail:false});
    res.json({ok:true,data:r});
  }catch(e){safeJson(res,500,{error:e.message})}
});

// Webhook receiver. Bling supports order/product/stock/invoice events.
app.post("/webhooks/bling",(req,res)=>{
  const db=load();
  db.local.logs ||= [];
  db.local.logs.unshift({at:new Date().toISOString(),body:req.body});
  db.local.logs=db.local.logs.slice(0,500);
  save(db);
  res.status(200).json({received:true});
});

app.get("/api/diagnostico-pedidos",async(req,res)=>{
  try{
    const shopeeIds=await getShopeeChannelIds();
    const r=await bling("GET","/pedidos/vendas",undefined,{pagina:1,limite:20});
    const data=(r.data||[]).map(o=>({id:o.id,numero:o.numero,numeroLoja:o.numeroLoja,loja:o.loja,canalVenda:o.canalVenda,integracao:o.integracao,origem:o.origem,situacao:o.situacao,label:channelLabel(o)}));
    res.json({ok:true,shopeeChannelIds:[...shopeeIds],total:data.length,pedidos:data});
  }catch(e){safeJson(res,500,{error:e.message})}
});
app.get("/api/health",(req,res)=>res.json({ok:true,time:new Date().toISOString(),version:"3.11.2"}));
app.get("/",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html"))); app.listen(PORT,()=>console.log("GB Gestao de Pedidos: http://localhost:"+PORT));


