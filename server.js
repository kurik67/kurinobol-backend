import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const app = express();
const allowedOrigins = [
  'https://kurinobol.netlify.app',
  ...(process.env.FRONTEND_ORIGIN || '').split(',').map(x => x.trim()).filter(Boolean)
];

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    console.error('CORS blocked origin:', origin);
    return callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({limit:'2mb'}));

const admin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {auth:{persistSession:false}}
);

const YK = 'https://api.yookassa.ru/v3';
const TG = process.env.TELEGRAM_BOT_TOKEN
  ? `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`
  : null;

async function currentUser(req){
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/,'');
  if(!token) return null;

  const {data:{user},error} = await admin.auth.getUser(token);
  if(error || !user){
    console.error('auth.getUser error:', error?.message || 'no user');
    return null;
  }
  return { user, token };
}

async function getProState(userId, accessToken){
  const userClient = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY,
    {
      global:{headers:{Authorization:`Bearer ${accessToken}`}},
      auth:{persistSession:false}
    }
  );

  let {data,error} = await userClient
    .from('profiles')
    .select('id,pro_until,pro_owned')
    .eq('id',userId)
    .maybeSingle();

  if(error || !data){
    const fallback = await admin
      .from('profiles')
      .select('id,pro_until,pro_owned')
      .eq('id',userId)
      .maybeSingle();
    data = fallback.data;
    error = fallback.error;
  }

  if(error){
    console.error('PRO profile lookup error:', error.message, 'user:', userId);
    return {active:false, pro_until:null, reason:'profile_lookup_error'};
  }
  if(!data){
    console.error('PRO profile missing for user:', userId);
    return {active:false, pro_until:null, reason:'profile_missing'};
  }

  const until = data.pro_until ? new Date(data.pro_until) : null;
  const active = !!data.pro_owned || (!!until && !Number.isNaN(until.getTime()) && until.getTime() > Date.now());

  console.log('PRO CHECK', {
    user_id:userId,
    pro_until:data.pro_until,
    pro_owned:!!data.pro_owned,
    now:new Date().toISOString(),
    active
  });

  return {
    active,
    pro_until:data.pro_until || null,
    reason:active ? 'active' : 'expired_or_missing'
  };
}

async function isActiveProServer(userId){
  const {data,error} = await admin
    .from('profiles')
    .select('pro_until,pro_owned')
    .eq('id',userId)
    .maybeSingle();

  if(error){
    console.error('Server PRO lookup error:',error.message,'user:',userId);
    return false;
  }

  const until = data?.pro_until ? new Date(data.pro_until) : null;
  return !!data?.pro_owned || (!!until && !Number.isNaN(until.getTime()) && until.getTime() > Date.now());
}

async function tg(method, body){
  if(!TG) throw new Error('TELEGRAM_BOT_TOKEN не настроен');
  const r = await fetch(`${TG}/${method}`,{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify(body)
  });
  const d = await r.json();
  if(!r.ok || !d.ok) throw new Error(d.description || `Telegram ${method} error`);
  return d.result;
}

function tokenHash(token){
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function getAdmin(){
  const {data} = await admin
    .from('support_admins')
    .select('telegram_user_id,chat_id,username')
    .order('created_at',{ascending:true})
    .limit(1)
    .maybeSingle();
  return data || null;
}

async function sendUserStatus(chatId, userId){
  const [{data:profile},{data:workouts}] = await Promise.all([
    admin.from('profiles').select('one_rm').eq('id',userId).single(),
    admin.from('workouts').select('workout_no,feeling,completed_at')
      .eq('user_id',userId).order('completed_at',{ascending:false}).limit(1)
  ]);
  const last = workouts?.[0];
  await tg('sendMessage',{
    chat_id:chatId,
    text:
`KURINOBOL BOT 🏋️
Аккаунт подключён ✅

1ПМ: ${profile?.one_rm ?? '—'} кг
Последняя тренировка: ${last ? `${last.workout_no}/14` : 'ещё нет'}
Последняя оценка: ${last?.feeling ?? '—'}

Можешь написать вопрос по программе, тренировкам или технике. Фото и видео тоже можно отправлять — сообщение получит автор KURINOBOL.\n\nЛимит: до 5 сообщений в день. Каждое текстовое сообщение, фото или видео считается одним сообщением.`
  });
}

app.get('/health',(req,res)=>res.json({
  ok:true,
  telegram:!!process.env.TELEGRAM_BOT_TOKEN
}));

// New account verification through Telegram. Email confirmation is disabled in Supabase.
// Any signed-in account may request a short-lived one-time verification link.
app.get('/api/account/telegram-link',async(req,res)=>{
  try{
    const authState=await currentUser(req);
    if(!authState) return res.status(401).json({error:'Нужно войти'});
    const user=authState.user;

    const {data:profile,error:profileError}=await admin
      .from('profiles')
      .select('telegram_verified_at')
      .eq('id',user.id)
      .maybeSingle();

    if(profileError) throw profileError;
    if(!profile) return res.status(409).json({error:'Профиль аккаунта ещё не создан'});
    if(profile.telegram_verified_at) return res.json({verified:true});

    const botUsername=(process.env.TELEGRAM_BOT_USERNAME||'').replace(/^@/,'');
    if(!botUsername || !process.env.TELEGRAM_BOT_TOKEN){
      return res.status(503).json({error:'Telegram-бот пока не настроен'});
    }

    await admin.from('telegram_verify_tokens')
      .delete()
      .eq('user_id',user.id)
      .is('used_at',null);

    const raw=crypto.randomBytes(24).toString('base64url');
    const hash=tokenHash(raw);
    const expires=new Date(Date.now()+10*60*1000).toISOString();

    const {error}=await admin.from('telegram_verify_tokens').insert({
      user_id:user.id,
      token_hash:hash,
      expires_at:expires
    });
    if(error) throw error;

    res.json({telegram_url:`https://t.me/${botUsername}?start=verify_${raw}`});
  }catch(e){
    console.error('Telegram account link error:',e);
    res.status(500).json({error:'Не удалось создать ссылку подтверждения'});
  }
});

// Registered user clicks "Написать автору в Telegram".
// Creates a one-time, 10-minute deep link to the bot. No paid access is required.
app.get('/api/pro/support',async(req,res)=>{
  try{
    const authState = await currentUser(req);
    if(!authState) return res.status(401).json({error:'Нужно войти'});

    const {user} = authState;

    const {data:profile,error:profileError} = await admin
      .from('profiles')
      .select('telegram_verified_at')
      .eq('id',user.id)
      .maybeSingle();

    if(profileError) throw profileError;
    if(!profile) return res.status(409).json({error:'Профиль аккаунта ещё не создан'});
    if(!profile.telegram_verified_at){
      return res.status(403).json({error:'Сначала подтверди аккаунт через Telegram'});
    }

    const botUsername = (process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@/,'');
    if(!botUsername || !process.env.TELEGRAM_BOT_TOKEN){
      return res.status(503).json({error:'Telegram-бот пока не настроен'});
    }

    // Remove stale unused tokens for this account.
    await admin.from('support_tokens')
      .delete()
      .eq('user_id',user.id)
      .is('used_at',null)
      .lt('expires_at',new Date().toISOString());

    const raw = crypto.randomBytes(24).toString('base64url');
    const hash = tokenHash(raw);
    const expires = new Date(Date.now()+10*60*1000).toISOString();

    const {error} = await admin.from('support_tokens').insert({
      user_id:user.id,
      token_hash:hash,
      expires_at:expires
    });
    if(error) throw error;

    res.json({
      telegram_url:`https://t.me/${botUsername}?start=${raw}`
    });
  }catch(e){
    console.error(e);
    res.status(500).json({error:'Ошибка PRO-поддержки'});
  }
});

// Telegram webhook.
// Telegram itself sends X-Telegram-Bot-Api-Secret-Token when webhook was registered.
app.post('/api/telegram/webhook',async(req,res)=>{
  try{
    const expected = process.env.TELEGRAM_WEBHOOK_SECRET || '';
    const actual = req.get('x-telegram-bot-api-secret-token') || '';
    if(!expected || actual !== expected) return res.sendStatus(403);

    // Acknowledge quickly; process update asynchronously.
    res.sendStatus(200);
    processTelegramUpdate(req.body).catch(console.error);
  }catch(e){
    console.error(e);
    if(!res.headersSent) res.sendStatus(500);
  }
});


const SUPPORT_DAILY_LIMIT = 5;

function moscowDayBounds(){
  // Daily support quota resets at 00:00 Moscow time (UTC+3).
  const now = new Date();
  const moscowNow = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  const y = moscowNow.getUTCFullYear();
  const m = moscowNow.getUTCMonth();
  const d = moscowNow.getUTCDate();
  const startUtc = new Date(Date.UTC(y, m, d, -3, 0, 0, 0));
  const endUtc = new Date(Date.UTC(y, m, d + 1, -3, 0, 0, 0));
  return {start:startUtc.toISOString(), end:endUtc.toISOString()};
}

async function supportMessagesToday(userId){
  const {start,end}=moscowDayBounds();
  const {count,error}=await admin
    .from('support_messages')
    .select('id',{count:'exact',head:true})
    .eq('user_id',userId)
    .gte('created_at',start)
    .lt('created_at',end);
  if(error) throw error;
  return count || 0;
}

async function processTelegramUpdate(update){
  const m = update.message;
  if(!m?.chat?.id || !m?.from?.id) return;

  const chatId = m.chat.id;
  const tgUserId = m.from.id;
  const username = m.from.username || null;
  const text = (m.text || '').trim();

  // One-time admin setup. The personal @username is never published to customers.
  if(text.startsWith('/admin ')){
    const supplied = text.slice('/admin '.length).trim();
    const expected = process.env.TELEGRAM_ADMIN_SETUP_SECRET || '';
    if(!expected || supplied !== expected){
      await tg('sendMessage',{chat_id:chatId,text:'Неверный код администратора.'});
      return;
    }

    await admin.from('support_admins').upsert({
      telegram_user_id:tgUserId,
      chat_id:chatId,
      username
    },{onConflict:'telegram_user_id'});

    await tg('sendMessage',{
      chat_id:chatId,
      text:'KURINOBOL BOT подключён ✅\nСюда будут приходить вопросы пользователей KURINOBOL. Отвечай через Reply на конкретное сообщение — бот доставит ответ пользователю.'
    });
    return;
  }

  const supportAdmin = await getAdmin();
  const isAdmin = supportAdmin && Number(supportAdmin.telegram_user_id) === Number(tgUserId);

  // Admin replies to a copied customer message -> deliver reply back to that customer.
  if(isAdmin && m.reply_to_message?.message_id){
    const {data:map} = await admin
      .from('support_messages')
      .select('user_id,user_chat_id')
      .eq('admin_message_id',m.reply_to_message.message_id)
      .eq('admin_chat_id',chatId)
      .maybeSingle();

    if(!map){
      await tg('sendMessage',{
        chat_id:chatId,
        text:'Не нашёл клиента для этого Reply. Отвечай именно на сообщение пользователя, которое прислал бот.'
      });
      return;
    }

    await tg('copyMessage',{
      chat_id:map.user_chat_id,
      from_chat_id:chatId,
      message_id:m.message_id
    });
    return;
  }

  // New account confirmation link: /start verify_<token>.
  // This path does NOT require PRO; it only proves control of a Telegram account.
  if(text.startsWith('/start verify_')){
    const startArg=text.split(/\s+/)[1]||'';
    const raw=startArg.startsWith('verify_') ? startArg.slice('verify_'.length) : '';
    if(!raw){
      await tg('sendMessage',{chat_id:chatId,text:'Ссылка подтверждения повреждена. Получи новую на сайте KURINOBOL.'});
      return;
    }

    const hash=tokenHash(raw);
    const {data:ticket,error:ticketError}=await admin
      .from('telegram_verify_tokens')
      .select('id,user_id,expires_at,used_at')
      .eq('token_hash',hash)
      .maybeSingle();

    if(ticketError){
      console.error('Telegram verify token lookup:',ticketError);
      await tg('sendMessage',{chat_id:chatId,text:'Не удалось проверить ссылку. Попробуй получить новую на сайте.'});
      return;
    }

    if(!ticket || ticket.used_at || new Date(ticket.expires_at)<=new Date()){
      await tg('sendMessage',{chat_id:chatId,text:'Эта ссылка уже использована или истекла. Вернись на сайт и получи новую.'});
      return;
    }

    // One Telegram account cannot confirm two different KURINOBOL accounts.
    const {data:otherLink,error:otherLinkError}=await admin
      .from('telegram_links')
      .select('user_id')
      .eq('telegram_user_id',tgUserId)
      .maybeSingle();

    if(otherLinkError){
      console.error('Telegram existing link lookup:',otherLinkError);
      await tg('sendMessage',{chat_id:chatId,text:'Не удалось проверить Telegram-привязку. Попробуй ещё раз.'});
      return;
    }

    if(otherLink && otherLink.user_id!==ticket.user_id){
      await tg('sendMessage',{
        chat_id:chatId,
        text:'Этот Telegram уже привязан к другому аккаунту KURINOBOL. Для другого аккаунта нужен другой Telegram.'
      });
      return;
    }

    const now=new Date().toISOString();
    const {error:linkError}=await admin.from('telegram_links').upsert({
      user_id:ticket.user_id,
      telegram_user_id:tgUserId,
      chat_id:chatId,
      telegram_username:username,
      linked_at:now,
      updated_at:now
    },{onConflict:'user_id'});

    if(linkError){
      console.error('Telegram account link save:',linkError);
      await tg('sendMessage',{chat_id:chatId,text:'Не удалось сохранить привязку Telegram. Попробуй ещё раз позже.'});
      return;
    }

    const {error:profileError}=await admin.from('profiles')
      .update({telegram_verified_at:now})
      .eq('id',ticket.user_id);

    if(profileError){
      console.error('Telegram profile verify:',profileError);
      await tg('sendMessage',{chat_id:chatId,text:'Telegram привязан, но аккаунт не удалось подтвердить. Попробуй ещё раз позже.'});
      return;
    }

    await admin.from('telegram_verify_tokens')
      .update({used_at:now})
      .eq('id',ticket.id);

    const frontend=(process.env.FRONTEND_URL||process.env.FRONTEND_ORIGIN||'https://kurinobol.netlify.app').split(',')[0].replace(/\/$/,'');
    await tg('sendMessage',{
      chat_id:chatId,
      text:'Аккаунт KURINOBOL подтверждён ✅\nВернись на сайт — доступ уже открыт.',
      reply_markup:{inline_keyboard:[[{text:'Вернуться на KURINOBOL →',url:`${frontend}/verify.html?verified=1`}]]}
    });
    return;
  }

  // User arrives from a one-time deep link generated in the PRO cabinet.
  if(text.startsWith('/start')){
    const raw = text.split(/\s+/)[1] || '';
    if(!raw){
      await tg('sendMessage',{
        chat_id:chatId,
        text:'KURINOBOL BOT 🏋️\n\nЗдесь можно подтвердить аккаунт и написать автору по программе, тренировкам или технике.\n\nЧтобы привязать аккаунт, открой KURINOBOL → кабинет → «Написать автору в Telegram».\n\nЛимит общения с автором: 5 сообщений в день. Фото и видео тоже считаются сообщениями.'
      });
      return;
    }

    const hash = tokenHash(raw);
    const {data:ticket} = await admin
      .from('support_tokens')
      .select('id,user_id,expires_at,used_at')
      .eq('token_hash',hash)
      .maybeSingle();

    if(!ticket || ticket.used_at || new Date(ticket.expires_at) <= new Date()){
      await tg('sendMessage',{
        chat_id:chatId,
        text:'Эта ссылка уже использована или истекла. Получи новую ссылку в PRO-кабинете.'
      });
      return;
    }

    // Telegram account is linked only after a valid one-time KURINOBOL support link.
    await admin.from('telegram_links').upsert({
      user_id:ticket.user_id,
      telegram_user_id:tgUserId,
      chat_id:chatId,
      telegram_username:username,
      linked_at:new Date().toISOString(),
      updated_at:new Date().toISOString()
    },{onConflict:'user_id'});

    await admin.from('support_tokens')
      .update({used_at:new Date().toISOString()})
      .eq('id',ticket.id);

    await sendUserStatus(chatId,ticket.user_id);
    return;
  }

  // Normal customer message: account must be linked to KURINOBOL.
  const {data:link} = await admin
    .from('telegram_links')
    .select('user_id,chat_id')
    .eq('telegram_user_id',tgUserId)
    .maybeSingle();

  if(!link){
    await tg('sendMessage',{
      chat_id:chatId,
      text:'Сначала привяжи аккаунт: открой KURINOBOL → кабинет → «Написать автору в Telegram».'
    });
    return;
  }

  // /status is informational and does not consume the daily message quota.
  if(text === '/status'){
    await sendUserStatus(chatId,link.user_id);
    return;
  }

  let usedToday=0;
  try{
    usedToday=await supportMessagesToday(link.user_id);
  }catch(limitError){
    console.error('Support daily limit check:',limitError?.message||limitError);
    await tg('sendMessage',{chat_id:chatId,text:'Не удалось проверить дневной лимит сообщений. Попробуй чуть позже.'});
    return;
  }

  if(usedToday >= SUPPORT_DAILY_LIMIT){
    await tg('sendMessage',{
      chat_id:chatId,
      text:'Лимит на сегодня исчерпан: максимум 5 сообщений в день. Завтра снова будет доступно 5 сообщений.'
    });
    return;
  }

  if(!supportAdmin){
    await tg('sendMessage',{
      chat_id:chatId,
      text:'Поддержка почти настроена, но автор ещё не привязал свой Telegram. Попробуй позже.'
    });
    return;
  }

  const [{data:profile},{data:lastWorkouts}] = await Promise.all([
    admin.from('profiles').select('one_rm').eq('id',link.user_id).single(),
    admin.from('workouts').select('workout_no,feeling,completed_at')
      .eq('user_id',link.user_id).order('completed_at',{ascending:false}).limit(1)
  ]);
  const last = lastWorkouts?.[0];

  const header = await tg('sendMessage',{
    chat_id:supportAdmin.chat_id,
    text:
`💬 KURINOBOL · Новый вопрос
1ПМ: ${profile?.one_rm ?? '—'} кг
Тренировка: ${last ? `${last.workout_no}/14` : '—'}
Последняя оценка: ${last?.feeling ?? '—'}

Ответь через Reply на сообщение пользователя ниже.`
  });

  // copyMessage supports text, photo, video, voice, documents etc.
  const copied = await tg('copyMessage',{
    chat_id:supportAdmin.chat_id,
    from_chat_id:chatId,
    message_id:m.message_id,
    reply_to_message_id:header.message_id
  });

  await admin.from('support_messages').insert({
    user_id:link.user_id,
    user_chat_id:chatId,
    admin_chat_id:supportAdmin.chat_id,
    admin_message_id:copied.message_id
  });

  await tg('sendMessage',{
    chat_id:chatId,
    text:`Передал автору KURINOBOL ✅\nОтвет придёт прямо сюда.\n\nСегодня осталось сообщений: ${Math.max(0,SUPPORT_DAILY_LIMIT-usedToday-1)} из ${SUPPORT_DAILY_LIMIT}.`
  });
}

async function requireSiteAdmin(req,res){
  const authState=await currentUser(req);
  if(!authState){ res.status(401).json({error:'Нужно войти'}); return null; }
  const {data,error}=await admin.from('site_admins').select('user_id').eq('user_id',authState.user.id).maybeSingle();
  if(error){ console.error('site_admins lookup:',error.message); res.status(500).json({error:'Не удалось проверить доступ'}); return null; }
  if(!data){ res.status(403).json({error:'Нет доступа'}); return null; }
  return authState;
}

app.get('/api/admin/me',async(req,res)=>{
  try{
    const authState=await requireSiteAdmin(req,res);
    if(!authState) return;
    res.json({ok:true});
  }catch(e){
    console.error('admin me:',e);
    res.status(500).json({error:'Не удалось проверить доступ'});
  }
});

// KURINOBOL FREE: платёжные маршруты удалены.

async function configureTelegramWebhook(){
  const publicUrl=(process.env.PUBLIC_BACKEND_URL||'').replace(/\/$/,'');
  const secret=process.env.TELEGRAM_WEBHOOK_SECRET;
  if(!TG || !publicUrl || !secret){
    console.log('Telegram webhook: пропущен — не заполнены env');
    return;
  }
  try{
    await tg('setWebhook',{
      url:`${publicUrl}/api/telegram/webhook`,
      secret_token:secret,
      allowed_updates:['message'],
      drop_pending_updates:false
    });
    console.log('Telegram webhook: подключён');
  }catch(e){
    console.error('Telegram webhook setup error:',e.message);
  }
}

const port=process.env.PORT||3000;
app.listen(port,()=>{
  console.log(`KURINOBOL backend on ${port}`);
  configureTelegramWebhook();
});
