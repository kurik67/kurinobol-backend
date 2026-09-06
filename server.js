import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const app = express();
app.use(cors({origin:(process.env.FRONTEND_ORIGIN||'').split(',').filter(Boolean)}));
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
    .select('id,pro_until')
    .eq('id',userId)
    .maybeSingle();

  if(error || !data){
    const fallback = await admin
      .from('profiles')
      .select('id,pro_until')
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
  const active = !!until && !Number.isNaN(until.getTime()) && until.getTime() > Date.now();

  console.log('PRO CHECK', {
    user_id:userId,
    pro_until:data.pro_until,
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
    .select('pro_until')
    .eq('id',userId)
    .maybeSingle();

  if(error){
    console.error('Server PRO lookup error:',error.message,'user:',userId);
    return false;
  }

  const until = data?.pro_until ? new Date(data.pro_until) : null;
  return !!until && !Number.isNaN(until.getTime()) && until.getTime() > Date.now();
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
    admin.from('profiles').select('one_rm,pro_until').eq('id',userId).single(),
    admin.from('workouts').select('workout_no,feeling,completed_at')
      .eq('user_id',userId).order('completed_at',{ascending:false}).limit(1)
  ]);
  const last = workouts?.[0];
  const proText = profile?.pro_until
    ? new Date(profile.pro_until).toLocaleDateString('ru-RU',{timeZone:'Europe/Moscow'})
    : '—';
  await tg('sendMessage',{
    chat_id:chatId,
    text:
`KURINOBOL PRO ✅
1ПМ: ${profile?.one_rm ?? '—'} кг
Последняя тренировка: ${last ? `${last.workout_no}/14` : 'ещё нет'}
Последняя оценка: ${last?.feeling ?? '—'}
PRO до: ${proText}

Напиши вопрос одним сообщением или отправь фото/видео. Я передам его автору.`,
  });
}

app.get('/health',(req,res)=>res.json({
  ok:true,
  telegram:!!process.env.TELEGRAM_BOT_TOKEN
}));

// PRO user clicks "Написать в Telegram".
// Backend verifies PRO and creates a one-time, 10-minute deep link to the bot.
app.get('/api/pro/support',async(req,res)=>{
  try{
    const authState = await currentUser(req);
    if(!authState) return res.status(401).json({error:'Нужно войти'});

    const {user,token} = authState;
    const proState = await getProState(user.id, token);

    if(!proState.active){
      return res.status(403).json({
        error:'Поддержка доступна только с активным PRO',
        code:proState.reason
      });
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
      text:'KURINOBOL Support подключён ✅\nТеперь сюда будут приходить сообщения активных PRO-пользователей. Отвечай через Reply на конкретное сообщение клиента.'
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

    if(!(await isActiveProServer(map.user_id))){
      await tg('sendMessage',{
        chat_id:chatId,
        text:'У этого пользователя PRO уже закончился. Сообщение не отправлено.'
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

  // User arrives from a one-time deep link generated in the PRO cabinet.
  if(text.startsWith('/start')){
    const raw = text.split(/\s+/)[1] || '';
    if(!raw){
      await tg('sendMessage',{
        chat_id:chatId,
        text:'Доступ к поддержке открывается из кабинета KURINOBOL PRO.\nЗайди на сайт → PRO-центр → «Написать в Telegram».'
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

    if(!(await isActiveProServer(ticket.user_id))){
      await tg('sendMessage',{chat_id:chatId,text:'PRO уже не активен. Поддержка недоступна.'});
      return;
    }

    // Telegram account can be linked only after valid KURINOBOL PRO verification.
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

  // Normal customer message: must be linked AND must still have active PRO.
  const {data:link} = await admin
    .from('telegram_links')
    .select('user_id,chat_id')
    .eq('telegram_user_id',tgUserId)
    .maybeSingle();

  if(!link){
    await tg('sendMessage',{
      chat_id:chatId,
      text:'Сначала открой поддержку через свой KURINOBOL PRO-кабинет.'
    });
    return;
  }

  if(!(await isActiveProServer(link.user_id))){
    await tg('sendMessage',{
      chat_id:chatId,
      text:'Твой KURINOBOL PRO закончился. После продления поддержка снова откроется автоматически.'
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

  // Commands that should not be forwarded.
  if(text === '/status'){
    await sendUserStatus(chatId,link.user_id);
    return;
  }

  const [{data:profile},{data:lastWorkouts}] = await Promise.all([
    admin.from('profiles').select('one_rm,pro_until').eq('id',link.user_id).single(),
    admin.from('workouts').select('workout_no,feeling,completed_at')
      .eq('user_id',link.user_id).order('completed_at',{ascending:false}).limit(1)
  ]);
  const last = lastWorkouts?.[0];

  const header = await tg('sendMessage',{
    chat_id:supportAdmin.chat_id,
    text:
`KURINOBOL PRO ✅
1ПМ: ${profile?.one_rm ?? '—'} кг
Тренировка: ${last ? `${last.workout_no}/14` : '—'}
Последняя оценка: ${last?.feeling ?? '—'}
PRO до: ${profile?.pro_until ? new Date(profile.pro_until).toLocaleDateString('ru-RU',{timeZone:'Europe/Moscow'}) : '—'}`
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
    text:'Отправлено автору ✅ Ответ придёт сюда.'
  });
}

app.post('/api/payments/create',async(req,res)=>{
  try{
    const authState=await currentUser(req);
    if(!authState) return res.status(401).json({error:'Нужно войти'});
    const user=authState.user;
    if(req.body.plan!=='pro_month') return res.status(400).json({error:'Неизвестный тариф'});

    const idempotence=crypto.randomUUID();
    const auth=Buffer.from(`${process.env.YOOKASSA_SHOP_ID}:${process.env.YOOKASSA_SECRET_KEY}`).toString('base64');
    const response=await fetch(`${YK}/payments`,{
      method:'POST',
      headers:{
        'Authorization':`Basic ${auth}`,
        'Idempotence-Key':idempotence,
        'Content-Type':'application/json'
      },
      body:JSON.stringify({
        amount:{value:'149.00',currency:'RUB'},
        capture:true,
        confirmation:{
          type:'redirect',
          return_url:`${process.env.FRONTEND_URL}/payment-success.html`
        },
        description:'KURINOBOL PRO — 1 месяц',
        metadata:{user_id:user.id,plan:'pro_month'}
      })
    });

    const payment=await response.json();
    if(!response.ok){
      return res.status(response.status).json({
        error:payment.description||'ЮKassa: ошибка создания платежа'
      });
    }

    await admin.from('payments').insert({
      user_id:user.id,
      yookassa_payment_id:payment.id,
      amount:149,
      status:payment.status
    });

    res.json({confirmation_url:payment.confirmation?.confirmation_url});
  }catch(e){
    res.status(500).json({error:e.message});
  }
});

app.post('/api/yookassa/webhook',async(req,res)=>{
  try{
    const event=req.body;
    if(event.event!=='payment.succeeded') return res.sendStatus(200);
    const paymentId=event.object?.id;
    if(!paymentId) return res.sendStatus(200);

    const auth=Buffer.from(`${process.env.YOOKASSA_SHOP_ID}:${process.env.YOOKASSA_SECRET_KEY}`).toString('base64');
    const verify=await fetch(`${YK}/payments/${paymentId}`,{
      headers:{'Authorization':`Basic ${auth}`}
    });
    const payment=await verify.json();

    if(!verify.ok || payment.status!=='succeeded') return res.sendStatus(400);

    const userId=payment.metadata?.user_id;
    const validPlan=payment.metadata?.plan==='pro_month';
    const validAmount=payment.amount?.value==='149.00' && payment.amount?.currency==='RUB';
    if(!userId || !validPlan || !validAmount) return res.sendStatus(400);

    const {data:profile}=await admin
      .from('profiles')
      .select('pro_until')
      .eq('id',userId)
      .single();

    const base=profile?.pro_until && new Date(profile.pro_until)>new Date()
      ? new Date(profile.pro_until)
      : new Date();

    base.setDate(base.getDate()+30);

    await admin.from('profiles')
      .update({pro_until:base.toISOString()})
      .eq('id',userId);

    await admin.from('payments')
      .update({status:'succeeded'})
      .eq('yookassa_payment_id',paymentId);

    res.sendStatus(200);
  }catch(e){
    console.error(e);
    res.sendStatus(500);
  }
});

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
