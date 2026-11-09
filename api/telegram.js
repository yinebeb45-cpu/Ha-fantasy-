/**
 * ለ Fantasy — Telegram webhook (Vercel: api/telegram.js)
 *
 * Vercel Environment Variables:
 *   BOT_TOKEN              = your bot token
 *   ADMIN_CHAT_ID          = -1004436177839
 *   CHANNEL_ID             = @lefantasychannel  (bot must be channel admin)
 *   BOT_USERNAME           = Lefantasy_bot
 *   PUBLISH_SECRET         = random string for auto-post URL
 *   MINI_APP_URL           = https://la-fantasy-1.onrender.com
 *   SUPABASE_URL           = https://iqbwqywwrqeeycfyuwms.supabase.co
 *   SUPABASE_SERVICE_KEY   = service_role key (secret)
 *
 * Webhook:
 *   https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://YOUR-APP.vercel.app/api/telegram
 */

const crypto = require('crypto');

const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
const ADMIN_CHAT_ID = String(process.env.ADMIN_CHAT_ID || '-1004436177839').trim();
// Public channel where ads are posted (bot must be admin)
const CHANNEL_ID = String(process.env.CHANNEL_ID || process.env.LE_CHANNEL_ID || '@lefantasychannel').trim();
const BOT_USERNAME = String(process.env.BOT_USERNAME || 'Lefantasy1_bot').replace(/^@/, '').trim();
// Optional secret so only you can trigger auto-publish via HTTP
const PUBLISH_SECRET = String(process.env.PUBLISH_SECRET || '').trim();
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';


const WALLET_CREDIT_PROMOS = {
  ABUCHUFREE: { amount: 100, maxUses: 1 },
  ANDYFREE: { amount: 100, maxUses: 1 },
  ESTARFREE: { amount: 100, maxUses: 1 }
};

async function redeemWalletPromoCode(user, code) {
  const sb = db();
  const c = String(code || '').toUpperCase().trim();
  const def = WALLET_CREDIT_PROMOS[c];
  if (!def) throw new Error('Invalid promo code');

  const tid = String(user.id);
  const userName = [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Manager';
  const amount = Number(def.amount || 100);
  const maxUses = Number(def.maxUses || 3);

  // Ensure wallet row
  let wallet = await getWallet(tid, userName);
  const bal0 = Number(wallet.balance || 0);

  // Track redemptions in promo_redemptions (create-friendly)
  let useCount = 0;
  let already = false;
  try {
    const { data: rows, error } = await sb
      .from('promo_redemptions')
      .select('id, telegram_id, code')
      .eq('code', c);
    if (error) {
      console.warn('promo_redemptions select:', error.message);
      // table may not exist — fall through with soft limits only in logs
    } else {
      const list = rows || [];
      useCount = list.length;
      already = list.some(function (r) { return String(r.telegram_id) === tid; });
    }
  } catch (e) {
    console.warn('promo lookup', e.message || e);
  }

  if (already) throw new Error('You already redeemed this code');
  if (useCount >= maxUses) throw new Error(maxUses <= 1 ? 'This code was already used by someone else' : ('This code has expired (max ' + maxUses + ' people)'));

  // Also block if this user redeemed ANY wallet-credit promo
  try {
    const { data: mine } = await sb
      .from('promo_redemptions')
      .select('id')
      .eq('telegram_id', tid)
      .in('code', Object.keys(WALLET_CREDIT_PROMOS))
      .limit(1);
    if (mine && mine.length) throw new Error('You already used a free wallet promo');
  } catch (e) {
    if (/already used a free/i.test(e.message || '')) throw e;
  }

  // Insert redemption first (unique code+telegram_id)
  try {
    const { error: insErr } = await sb.from('promo_redemptions').insert({
      code: c,
      telegram_id: tid,
      user_name: userName,
      amount: amount
    });
    if (insErr) {
      if (/duplicate|unique/i.test(insErr.message || '')) {
        throw new Error('You already redeemed this code');
      }
      // If table missing, still credit once per server-less best effort
      console.warn('promo insert:', insErr.message);
      if (/does not exist|schema cache/i.test(insErr.message || '')) {
        console.warn('Run SQL to create promo_redemptions table for hard 3-person limit');
      } else {
        throw new Error(insErr.message || 'Redeem failed');
      }
    }
  } catch (e) {
    if (/already redeemed|already used/i.test(e.message || '')) throw e;
    if (!/does not exist|schema cache/i.test(e.message || '')) {
      // rethrow unknown
      if (/Redeem failed|duplicate/i.test(e.message || '')) throw e;
    }
  }

  const newBal = bal0 + amount;
  const { error: wErr } = await sb
    .from('user_wallets')
    .update({
      balance: newBal,
      total_deposits: Number(wallet.total_deposits || 0) + amount
    })
    .eq('telegram_id', tid);
  if (wErr) throw wErr;

  try {
    await tg('sendMessage', {
      chat_id: tid,
      text: '🎁 Promo *' + c + '* redeemed!\n+' + amount + ' ETB added to your wallet.\nBalance: ' + newBal + ' ETB',
      parse_mode: 'Markdown'
    });
  } catch (e) {}

  return { balance: newBal, amount: amount, code: c };
}


const INFLUENCER_PROMOS = {
  ELA11: { discount: 10, share: 7, house: 3, telegramId: process.env.INFLUENCER_ELA_ID || '' },
  JONI11: { discount: 10, share: 7, house: 3, telegramId: process.env.INFLUENCER_JONI_ID || '' }
};


function assertDepositReceipt(receipt, amount) {
  const text = String(receipt || '');
  if (!text.trim()) throw new Error('Receipt required');
  if (/COMMERCIAL BANK|CBE ACCOUNT|BANK TRANSACTION NUMBER|ACCOUNT NUMBER\s*\d{8,}/i.test(text)) {
    throw new Error('Bank transfer receipts are not accepted. Send Telebirr to Dawit Gebremicael 251996465640.');
  }
  if (!/transferred\s+etb/i.test(text)) {
    throw new Error('Invalid Telebirr SMS format');
  }
  if (!/to\s+dawit(\s+gebremicael)?/i.test(text) && !/to\s+gebremicael/i.test(text)) {
    throw new Error('Receipt must show transfer TO Dawit Gebremicael (not only Dear Dawit)');
  }
  const fromOur = /from your telebirr account\s*251?9?996465640/i.test(text);
  const toOur =
    /to\s+[^\n]{0,60}(251996465640|0996465640|996465640|2519\*+[0-9]*5640)/i.test(text);
  if (fromOur && !toOur) {
    throw new Error('SMS shows money sent FROM our number, not a deposit TO us');
  }
  const m = text.match(/ETB\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (m) {
    const smsAmt = parseFloat(m[1]);
    if (Number.isFinite(amount) && Math.abs(smsAmt - Number(amount)) > 0.05) {
      throw new Error('Receipt amount does not match');
    }
    if (smsAmt > 200) throw new Error('Max deposit 200 ETB');
  }
  return true;
}

const TG_BASE = 'https://api.telegram.org/bot' + BOT_TOKEN;

/* Minimal Supabase REST client — no @supabase/supabase-js needed */
function db() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env');
  }
  const base = SUPABASE_URL + '/rest/v1';
  const headers = function (extra) {
    const h = {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: 'Bearer ' + SUPABASE_SERVICE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    };
    if (extra) Object.assign(h, extra);
    return h;
  };

  function from(table) {
    const st = {
      table: table,
      sel: '*',
      filters: [],
      method: 'GET',
      body: null,
      limit: null,
      order: null,
      wantSingle: false,
      wantMaybe: false,
      isUpsert: false,
      onConflict: null,
      doSelectAfter: false
    };

    function qs() {
      const p = [];
      if (st.method === 'GET' || st.doSelectAfter) p.push('select=' + encodeURIComponent(st.sel));
      st.filters.forEach(function (f) { p.push(f); });
      if (st.order) p.push('order=' + st.order);
      if (st.limit != null) p.push('limit=' + st.limit);
      if (st.isUpsert && st.onConflict) p.push('on_conflict=' + encodeURIComponent(st.onConflict));
      return p.length ? ('?' + p.join('&')) : '';
    }

    function run() {
      return (async function () {
        let url = base + '/' + st.table + qs();
        const extra = {};
        // Never use application/vnd.pgrst.object+json — causes
        // "Cannot coerce the result to a single JSON object" when 0/2+ rows.
        if (st.isUpsert) {
          extra['Prefer'] = 'resolution=merge-duplicates,return=representation';
        } else if (st.method === 'PATCH' || st.method === 'DELETE') {
          extra['Prefer'] = 'return=minimal';
        } else if (st.method === 'POST' && st.doSelectAfter) {
          extra['Prefer'] = 'return=representation';
        } else if (st.method === 'POST') {
          extra['Prefer'] = 'return=representation';
        }
        try {
          const res = await fetch(url, {
            method: st.method,
            headers: headers(extra),
            body: st.body != null ? JSON.stringify(st.body) : undefined
          });
          const text = await res.text();
          let data = null;
          try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
          if (!res.ok) {
            const msg = (data && (data.message || data.error || data.hint)) || text || res.statusText;
            // Coerce errors: treat as empty result for maybeSingle paths
            if (String(msg).toLowerCase().indexOf('coerce') >= 0) {
              if (st.wantMaybe) return { data: null, error: null };
              if (st.method === 'PATCH') return { data: null, error: null };
            }
            return { data: null, error: { message: String(msg), code: data && data.code, status: res.status } };
          }
          if (st.wantMaybe) {
            if (Array.isArray(data)) data = data.length ? data[0] : null;
            return { data: data, error: null };
          }
          if (st.wantSingle) {
            if (Array.isArray(data)) data = data[0] || null;
            if (data == null) {
              return { data: null, error: { message: 'No rows returned', code: 'PGRST116' } };
            }
            return { data: data, error: null };
          }
          return { data: data, error: null };
        } catch (e) {
          return { data: null, error: { message: e.message || String(e) } };
        }
      })();
    }

    const api = {
      select: function (cols) {
        st.sel = cols || '*';
        st.doSelectAfter = true;
        return api;
      },
      eq: function (col, val) {
        st.filters.push(encodeURIComponent(col) + '=eq.' + encodeURIComponent(val == null ? '' : val));
        return api;
      },
      ilike: function (col, val) {
        st.filters.push(encodeURIComponent(col) + '=ilike.' + encodeURIComponent(val == null ? '' : val));
        return api;
      },
      order: function (col, opts) {
        const dir = (opts && opts.ascending === false) ? 'desc' : 'asc';
        st.order = encodeURIComponent(col) + '.' + dir;
        return api;
      },
      limit: function (n) {
        st.limit = n;
        return api;
      },
      maybeSingle: function () {
        st.wantMaybe = true;
        return run();
      },
      single: function () {
        st.wantSingle = true;
        return run();
      },
      update: function (body) {
        st.method = 'PATCH';
        st.body = body;
        return api;
      },
      insert: function (body) {
        st.method = 'POST';
        st.body = body;
        return api;
      },
      upsert: function (body, opts) {
        st.method = 'POST';
        st.body = body;
        st.isUpsert = true;
        st.onConflict = opts && opts.onConflict;
        return api;
      },
      then: function (resolve, reject) {
        return run().then(resolve, reject);
      }
    };
    return api;
  }

  return { from: from };
}

// Mini App URL (Menu Button + keyboard web_app)
const MINI_APP_URL = (
  process.env.MINI_APP_URL ||
  process.env.WEBAPP_URL ||
  'https://la-fantasy-1.onrender.com'
).trim().replace(/\/+$/, '');

const SUPPORT_USERNAME = (process.env.SUPPORT_USERNAME || '@Adimn67').trim();
const SUPPORT_USERNAME_2 = (process.env.SUPPORT_USERNAME_2 || '@Adimn67').trim();
const CHANNEL_USERNAME = (process.env.CHANNEL_USERNAME || '@lefantasychannel').trim();
const CHANNEL_URL = (process.env.CHANNEL_URL || 'https://t.me/lefantasychannel').trim();

async function tg(method, body) {
  body = body || {};
  const response = await fetch(TG_BASE + '/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!data.ok) console.error('Telegram API error (' + method + '):', data);
  return data;
}

function verifyTelegramInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;
  try {
    const params = new URLSearchParams(initData);
    const receivedHash = params.get('hash');
    if (!receivedHash) return null;
    params.delete('hash');
    const dataCheckString = [...params.entries()]
      .sort(function (a, b) { return a[0].localeCompare(b[0]); })
      .map(function (entry) { return entry[0] + '=' + entry[1]; })
      .join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (
      calculatedHash.length !== receivedHash.length ||
      !crypto.timingSafeEqual(Buffer.from(calculatedHash), Buffer.from(receivedHash))
    ) {
      return null;
    }
    const userRaw = params.get('user');
    if (!userRaw) return null;
    return JSON.parse(userRaw);
  } catch (error) {
    console.error('Telegram auth error:', error);
    return null;
  }
}

function userLabel(user) {
  if (!user) return 'Unknown';
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ');
  const username = user.username ? '@' + user.username : 'No username';
  return (name || 'Unknown') + ' (' + username + ')';
}

function mainReplyKeyboard() {
  return {
    keyboard: [
      [
        {
          text: '⚽ Open ለ Fantasy',
          web_app: { url: MINI_APP_URL }
        }
      ],
      [
        { text: '📜 Rules' },
        { text: '🏆 Contests' }
      ],
      [
        { text: '💬 Support' },
        { text: '📢 Channel' }
      ]
    ],
    resize_keyboard: true,
    is_persistent: true
  };
}

async function ensureMenuButton() {
  // Blue "Play" button bottom-left (same idea as Hahu)
  try {
    await tg('setChatMenuButton', {
      menu_button: {
        type: 'web_app',
        text: 'Play',
        web_app: { url: MINI_APP_URL }
      }
    });
  } catch (e) {
    console.warn('setChatMenuButton failed', e && e.message);
  }
}


/* =========================================================
   CHANNEL PUBLISH — posts with Play button → opens Le Fantasy bot
   (Channels cannot use web_app buttons; URL opens the bot / Mini App)
========================================================= */

function playButtonKeyboard() {
  // Always open the live bot
  const botUrl = 'https://t.me/Lefantasy1_bot';
  const startAppUrl = 'https://t.me/Lefantasy1_bot?startapp=play';
  return {
    inline_keyboard: [
      [
        { text: '⚽ Play Le Fantasy', url: startAppUrl }
      ],
      [
        { text: '📱 Open Bot', url: botUrl },
        { text: '📢 Channel', url: 'https://t.me/lefantasychannel' }
      ]
    ]
  };
}

function defaultAdCaption() {
  return (
    '⚽ *LE FANTASY* — Weekly EPL Fantasy\n\n' +
    'Entry: *100 ETB*\n' +
    'Real prizes · Live points · Fair ranking\n\n' +
    '1. Deposit\n' +
    '2. Build your 15-man squad\n' +
    '3. Join the contest\n\n' +
    'Tap *Play Le Fantasy* below 👇'
  );
}

/**
 * Publish a text (and optional photo URL) to the channel with Play buttons.
 * @param {{ caption?: string, photoUrl?: string, chatId?: string }} opts
 */
async function publishChannelPost(opts) {
  opts = opts || {};
  const chatId = opts.chatId || CHANNEL_ID;
  const caption = opts.caption || defaultAdCaption();
  const photoUrl = opts.photoUrl || opts.photo || '';
  const keyboard = playButtonKeyboard();

  if (photoUrl) {
    const result = await tg('sendPhoto', {
      chat_id: chatId,
      photo: photoUrl,
      caption: String(caption || '').slice(0, 1024),
      reply_markup: keyboard
    });
    return result;
  }

  const result = await tg('sendMessage', {
    chat_id: chatId,
    text: String(caption || ''),
    reply_markup: keyboard,
    disable_web_page_preview: true
  });
  return result;
}

function isAdminUser(msg) {
  if (!msg || !msg.from) return false;
  // Allow from admin group, or private chat with known admin patterns
  const chatId = String(msg.chat && msg.chat.id);
  if (chatId === String(ADMIN_CHAT_ID)) return true;
  // Optional: ADMIN_USER_IDS=123,456
  const admins = String(process.env.ADMIN_USER_IDS || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  if (admins.length && admins.indexOf(String(msg.from.id)) >= 0) return true;
  return false;
}


async function handleStart(msg) {
  const chatId = msg.chat.id;
  const first = (msg.from && msg.from.first_name) || 'Manager';

  await ensureMenuButton();

  await tg('sendMessage', {
    chat_id: chatId,
    text:
      '⚽ *Welcome to ለ Fantasy!*\n\n' +
      'Build your Premier League squad and compete for real ETB prizes.\n\n' +
      '✅ EPL live now\n' +
      '🚧 UCL — Coming Soon\n\n' +
      '• Entry: *100 ETB*\n' +
      '• Deadline: *Sat 25 Oct, 14:30 EAT*\n' +
      '• Max 3 players per club · 15-man squad\n\n' +
      'Tap *Open ለ Fantasy* or the *Play* button below.',
    parse_mode: 'Markdown',
    reply_markup: mainReplyKeyboard()
  });

  await tg('sendMessage', {
    chat_id: chatId,
    text: '🎮 Good luck, ' + first + '! Play bold.'
  });
}


/**
 * Admin uploads a photo from their phone → publish to channel with Play buttons.
 * Caption on the photo is used as the post text (or default ad caption).
 * Works in private chat with bot (if ADMIN_USER_IDS set) or in ADMIN_CHAT_ID group.
 */

async function handleAdminVideo(msg) {
  const chatId = msg.chat.id;
  if (!isAdminUser(msg)) {
    return false;
  }
  const vid = msg.video || (msg.video_note ? null : null);
  const fileId = (msg.video && msg.video.file_id) || (msg.document && msg.document.mime_type && String(msg.document.mime_type).indexOf('video') >= 0 && msg.document.file_id);
  if (!fileId) {
    await tg('sendMessage', { chat_id: chatId, text: '❌ Could not read video. Send as a video (not file) if possible.' });
    return true;
  }
  const caption = (msg.caption && String(msg.caption).trim()) || defaultAdCaption();
  const result = await tg('sendVideo', {
    chat_id: CHANNEL_ID,
    video: fileId,
    caption: String(caption).slice(0, 1024),
    reply_markup: playButtonKeyboard()
  });
  if (result && result.ok) {
    await tg('sendMessage', {
      chat_id: chatId,
      text: '✅ Video posted to channel with Play button.\nChannel: ' + CHANNEL_ID
    });
  } else {
    const errDesc = (result && result.description) ? String(result.description) : JSON.stringify(result || 'unknown');
    await tg('sendMessage', {
      chat_id: chatId,
      text: '❌ Failed to post video.\nMake sure the bot is admin in the channel.\nError: ' + errDesc
    });
  }
  return true;
}

async function handleAdminPhoto(msg) {
  const chatId = msg.chat.id;
  if (!isAdminUser(msg)) {
    // Ignore photos from normal users
    return false;
  }

  const photos = msg.photo || [];
  // Highest resolution is last
  const best = photos[photos.length - 1];
  if (!best || !best.file_id) {
    await tg('sendMessage', { chat_id: chatId, text: '❌ Could not read photo.' });
    return true;
  }

  const caption = (msg.caption && String(msg.caption).trim()) || defaultAdCaption();
  // Do NOT use parse_mode on user captions — underscores/asterisks break Markdown entities
  const result = await tg('sendPhoto', {
    chat_id: CHANNEL_ID,
    photo: best.file_id,
    caption: String(caption).slice(0, 1024),
    reply_markup: playButtonKeyboard()
  });

  if (result && result.ok) {
    await tg('sendMessage', {
      chat_id: chatId,
      text: '✅ Photo posted to channel with Play button.\nChannel: ' + CHANNEL_ID
    });
  } else {
    const errDesc = (result && result.description) ? String(result.description) : JSON.stringify(result || 'unknown');
    await tg('sendMessage', {
      chat_id: chatId,
      text: '❌ Failed to post photo.\nMake sure the bot is admin in the channel.\nError: ' + errDesc
    });
  }
  return true;
}

async function handleBotText(msg) {
  const chatId = msg.chat.id;
  const text = String(msg.text || '').trim();
  const lower = text.toLowerCase();

  if (lower === '/start' || lower.indexOf('/start') === 0) {
    await handleStart(msg);
    return true;
  }

  // Admin: publish ad to channel with Play button
  // /post  or  /post Your custom caption here
  // /postphoto https://example.com/image.jpg Caption text
  if (lower === '/post' || lower.indexOf('/post ') === 0 || lower.indexOf('/postphoto') === 0) {
    if (!isAdminUser(msg)) {
      await tg('sendMessage', { chat_id: chatId, text: '⛔ Admin only.' });
      return true;
    }
    try {
      let caption = defaultAdCaption();
      let photoUrl = '';
      let photoFileId = '';

      // Reply to a photo on your phone: reply with /post
      const reply = msg.reply_to_message;
      if (reply && reply.photo && reply.photo.length) {
        photoFileId = reply.photo[reply.photo.length - 1].file_id;
        if (reply.caption) caption = String(reply.caption).trim();
      }

      if (lower.indexOf('/postphoto') === 0) {
        const rest = text.replace(/^\/postphoto\s*/i, '').trim();
        const sp = rest.indexOf(' ');
        if (sp > 0) {
          photoUrl = rest.slice(0, sp).trim();
          caption = rest.slice(sp + 1).trim() || caption;
        } else if (rest) {
          photoUrl = rest;
        }
      } else if (lower.indexOf('/post ') === 0) {
        caption = text.replace(/^\/post\s*/i, '').trim() || caption;
      }

      let result;
      if (photoFileId) {
        result = await tg('sendPhoto', {
          chat_id: CHANNEL_ID,
          photo: photoFileId,
          caption: caption,
          parse_mode: 'Markdown',
          reply_markup: playButtonKeyboard()
        });
      } else {
        result = await publishChannelPost({ caption: caption, photoUrl: photoUrl });
      }

      if (result && result.ok) {
        await tg('sendMessage', {
          chat_id: chatId,
          text: '✅ Posted to channel with Play button.\nChannel: ' + CHANNEL_ID
        });
      } else {
        await tg('sendMessage', {
          chat_id: chatId,
          text: '❌ Post failed: ' + JSON.stringify((result && result.description) || result || 'unknown')
        });
      }
    } catch (e) {
      await tg('sendMessage', { chat_id: chatId, text: '❌ ' + (e.message || String(e)) });
    }
    return true;
  }

  if (text === '📜 Rules' || lower === '/rules' || lower === 'rules') {
    await tg('sendMessage', {
      chat_id: chatId,
      text:
        '📋 *ለ Fantasy scoring (FPL-style)*\n\n' +
        '• Play under 60 min → 1 pt · 60+ → 2 pts\n' +
        '• Goals: GK 10 · DEF 6 · MID 5 · FWD 4\n' +
        '• Assists → 3 pts\n' +
        '• Clean sheet: GK/DEF 4 · MID 1\n' +
        '• Captain ×2 · Triple Captain ×3\n' +
        '• Max 3 from same club\n\n' +
        'Full rules are inside the app: *Profile → Scoring Rules*',
      parse_mode: 'Markdown',
      reply_markup: mainReplyKeyboard()
    });
    return true;
  }

  if (text === '🏆 Contests' || lower === '/contests') {
    await tg('sendMessage', {
      chat_id: chatId,
      text:
        '🏆 *This week*\n\n' +
        'Premier League — *100 ETB* entry\n' +
        'Lock: Sat 25 Oct, 14:30 EAT\n\n' +
        'Open the app → *Contest* to join and see live rankings.',
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '⚽ Open Contest', web_app: { url: MINI_APP_URL } }]
        ]
      }
    });
    return true;
  }

  if (text === '💬 Support' || lower === '/support' || lower === 'support') {
    await tg('sendMessage', {
      chat_id: chatId,
      text:
        '💬 *Support*\n\n' +
        '• ' + SUPPORT_USERNAME + '\n' +
        '• ' + SUPPORT_USERNAME_2 + '\n\n' +
        'We usually reply within a few hours.\n' +
        'For deposit issues, include your Telebirr SMS / receipt.',
      parse_mode: 'Markdown',
      reply_markup: mainReplyKeyboard()
    });
    return true;
  }

  if (text === '📢 Channel' || lower === '/channel') {
    await tg('sendMessage', {
      chat_id: chatId,
      text: '📢 Join the channel for deadlines & winners:\n' + CHANNEL_URL,
      reply_markup: {
        inline_keyboard: [
          [{ text: '📢 Open @lefantasychannel', url: CHANNEL_URL }]
        ]
      }
    });
    return true;
  }

  if (lower === '/play' || lower === 'play') {
    await tg('sendMessage', {
      chat_id: chatId,
      text: 'Open ለ Fantasy:',
      reply_markup: {
        inline_keyboard: [
          [{ text: '⚽ Launch App', web_app: { url: MINI_APP_URL } }]
        ]
      }
    });
    return true;
  }

  // Unknown text in private chat — gentle nudge
  if (msg.chat && msg.chat.type === 'private') {
    await tg('sendMessage', {
      chat_id: chatId,
      text: 'Use the buttons below or tap *Play* to open the app.',
      parse_mode: 'Markdown',
      reply_markup: mainReplyKeyboard()
    });
    return true;
  }

  return false;
}


async function getWallet(telegramId, userName) {
  const sb = db();
  const tid = String(telegramId);
  let { data: wallet, error } = await sb
    .from('user_wallets')
    .select('*')
    .eq('telegram_id', tid)
    .maybeSingle();
  if (error) throw new Error(error.message || String(error));
  if (wallet) return wallet;

  const result = await sb
    .from('user_wallets')
    .upsert({
      telegram_id: tid,
      user_name: userName || 'Manager',
      balance: 0,
      total_deposits: 0,
      total_withdrawals: 0,
          }, { onConflict: 'telegram_id' })
    .select()
    .single();
  if (result.error) {
    console.warn('upsert wallet', result.error);
    const again = await sb.from('user_wallets').select('*').eq('telegram_id', tid).limit(1);
    if (again.data && again.data[0]) return again.data[0];
    throw new Error(result.error.message || 'Could not create wallet');
  }
  const row = Array.isArray(result.data) ? result.data[0] : result.data;
  return row;
}

async function isAdmin(userId) {
  try {
    const result = await tg('getChatMember', { chat_id: ADMIN_CHAT_ID, user_id: userId });
    if (!result.ok) return false;
    const status = result.result.status;
    return status === 'creator' || status === 'administrator';
  } catch (error) {
    console.error('Admin check failed:', error);
    return false;
  }
}

function extractTxnId(receipt) {
  if (!receipt) return null;
  const text = String(receipt);
  let m = text.match(/transaction number is\s*[:\s]*([A-Za-z0-9]+)/i);
  if (m) return m[1].toUpperCase();
  m = text.match(/txn(?:\s*id|\s*no|#)?\s*[:\s]*([A-Za-z0-9]+)/i);
  if (m) return m[1].toUpperCase();
  m = text.match(/receipt\/([A-Za-z0-9]+)/i);
  if (m) return m[1].toUpperCase();
  m = text.match(/\b([A-Z]{2,}\d{2,}[A-Z0-9]{2,})\b/i);
  if (m) return m[1].toUpperCase();
  return null;
}

async function assertNoDuplicateReceipt(receipt, telegramId) {
  const txn = extractTxnId(receipt);
  const sb = db();

  if (!txn) {
    console.warn('No txn id parsed from receipt for', telegramId);
    const trimmed = String(receipt || '').trim();
    if (trimmed.length > 40) {
      const { data: same } = await sb
        .from('wallet_requests')
        .select('id, telegram_id, status')
        .ilike('receipt', trimmed.slice(0, 80) + '%')
        .limit(5);
      if (same && same.length) {
        throw new Error('This receipt text was already submitted (request #' + same[0].id + ').');
      }
    }
    return { txn: null };
  }

  const { data: rows, error } = await sb
    .from('wallet_requests')
    .select('id, telegram_id, status, receipt')
    .ilike('receipt', '%' + txn + '%')
    .limit(20);

  if (error) {
    console.warn('duplicate check error:', error.message);
    const { data: recent } = await sb
      .from('wallet_requests')
      .select('id, telegram_id, status, receipt')
      .order('id', { ascending: false })
      .limit(100);
    const hit = (recent || []).find(function (r) {
      return String(r.receipt || '').toUpperCase().indexOf(txn) !== -1;
    });
    if (hit) {
      throw new Error('Duplicate Telebirr receipt (txn ' + txn + '). Already used on request #' + hit.id + '.');
    }
    return { txn: txn };
  }

  if (rows && rows.length > 0) {
    throw new Error('Duplicate Telebirr receipt (txn ' + txn + '). Already used on request #' + rows[0].id + '.');
  }
  return { txn: txn };
}

async function joinLeagueServer(user, league, gameweek, opts) {
  const sb = db();
  const lg = String(league || '').toUpperCase();
  if (lg !== 'EPL' && lg !== 'UCL') throw new Error('Invalid league');
  const gw = Number(gameweek) || 1;
  const tid = String(user.id);
  const userName = [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Manager';
  opts = opts || {};
  let ENTRY = 100;
  const rawAmt = Number(opts.amount);
  if (!isNaN(rawAmt) && rawAmt >= 0 && rawAmt <= 100) ENTRY = Math.round(rawAmt);
  // Promo codes: never charge more than 100; floor at 0
  const promo = opts.promo_code ? String(opts.promo_code).toUpperCase() : '';
  console.log('joinLeagueServer', tid, lg, gw, 'charge', ENTRY, 'promo', promo);

  // Prefer dedicated contest_entries table if it exists
  let useEntriesTable = true;
  const { data: entryRows, error: entryLookErr } = await sb
    .from('contest_entries')
    .select('*')
    .eq('telegram_id', tid)
    .eq('league', lg)
    .eq('gameweek', gw)
    .limit(1);

  if (entryLookErr) {
    // table may not exist yet
    useEntriesTable = false;
    console.warn('contest_entries lookup:', entryLookErr.message);
  } else if (entryRows && entryRows.length) {
    const wallet = await getWallet(tid, userName);
    return { already: true, league: lg, balance: Number(wallet.balance || 0) };
  }

  // Also check user_squads.paid for backwards compatibility
  const { data: existingRows } = await sb
    .from('user_squads')
    .select('*')
    .eq('telegram_id', tid)
    .eq('league', lg)
    .eq('gameweek', gw);

  const existing = (existingRows && existingRows[0]) || null;
  if (existing && (existing.paid === true || existing.paid === 'true' || existing.paid === 1)) {
    const wallet = await getWallet(tid, userName);
    return { already: true, league: lg, balance: Number(wallet.balance || 0) };
  }

  const wallet = await getWallet(tid, userName);
  const balance = Number(wallet.balance || 0);
  if (balance < ENTRY) {
    throw new Error('Insufficient balance. Need ' + ENTRY + ' ETB (you have ' + balance + ').');
  }

  const newBalance = balance - ENTRY;
  const { error: wErr } = await sb
    .from('user_wallets')
    .update({ balance: newBalance })
    .eq('telegram_id', tid);
  if (wErr) throw wErr;

  // Influencer promo: credit 7 ETB to tiktoker wallet when code used
  try {
    const pcode = String((opts && opts.promo_code) || '').toUpperCase();
    const ip = INFLUENCER_PROMOS[pcode];
    if (ip && ip.telegramId && ENTRY < 100) {
      const infId = String(ip.telegramId).trim();
      if (infId) {
        const { data: infRows } = await sb.from('user_wallets').select('*').eq('telegram_id', infId).limit(1);
        let infBal = 0;
        if (infRows && infRows[0]) {
          infBal = Number(infRows[0].balance || 0) + Number(ip.share || 7);
          await sb.from('user_wallets').update({ balance: infBal }).eq('telegram_id', infId);
        } else {
          await sb.from('user_wallets').insert({
            telegram_id: infId,
            user_name: pcode + ' influencer',
            balance: Number(ip.share || 7),
            total_deposits: 0,
            total_winnings: Number(ip.share || 7)
          });
          infBal = Number(ip.share || 7);
        }
        console.log('Influencer credit', pcode, infId, '+', ip.share, 'bal', infBal);
        try {
          await tg('sendMessage', {
            chat_id: infId,
            text: '🎁 Promo *' + pcode + '* used!\n+' + (ip.share || 7) + ' ETB added to your Le Fantasy wallet.\nNew balance: ' + infBal + ' ETB',
            parse_mode: 'Markdown'
          });
        } catch (e) {}
      }
    }
  } catch (e) {
    console.warn('influencer credit failed', e.message || e);
  }

  async function refund() {
    await sb.from('user_wallets').update({ balance: balance }).eq('telegram_id', tid);
  }

  // 1) contest_entries (preferred)
  if (useEntriesTable) {
    const { error: eIns } = await sb.from('contest_entries').insert({
      telegram_id: tid,
      user_name: userName,
      league: lg,
      gameweek: gw,
      paid: true,
      amount: ENTRY
    });
    if (eIns) {
      // unique violation = already joined
      if (/duplicate|unique/i.test(eIns.message || '')) {
        await refund();
        return { already: true, league: lg, balance: balance };
      }
      console.warn('contest_entries insert failed, falling back to user_squads:', eIns.message);
      useEntriesTable = false;
    } else {
      // Also mark user_squads.paid if a squad row exists / create minimal row
      try {
        await markUserSquadPaid(sb, tid, userName, lg, gw, existing);
      } catch (e) {
        console.warn('mark user_squads paid after contest_entries:', e.message || e);
      }
      return { already: false, league: lg, balance: newBalance, charged: ENTRY };
    }
  }

  // 2) Fallback: user_squads only (must satisfy active_chip check)
  try {
    await markUserSquadPaid(sb, tid, userName, lg, gw, existing);
  } catch (e) {
    await refund();
    throw e;
  }

  return { already: false, league: lg, balance: newBalance, charged: ENTRY };
}

async function markUserSquadPaid(sb, tid, userName, lg, gw, existing) {
  // active_chip must pass user_squads_active_chip_check — use null or allowed chip values only
  if (existing) {
    const { error: uErr } = await sb
      .from('user_squads')
      .update({ paid: true, user_name: userName })
      .eq('telegram_id', tid)
      .eq('league', lg)
      .eq('gameweek', gw);
    if (uErr) throw new Error('Could not mark paid: ' + uErr.message);
    return;
  }

  // Insert minimal valid row — include fields the check constraint expects
  const attempts = [
    {
      telegram_id: tid,
      user_name: userName,
      league: lg,
      gameweek: gw,
      paid: true,
      total_points: 0,
      formation: '4-3-3',
      active_chip: null
    },
    {
      telegram_id: tid,
      user_name: userName,
      league: lg,
      gameweek: gw,
      paid: true,
      total_points: 0,
      formation: '4-3-3'
      // omit active_chip
    },
    {
      telegram_id: tid,
      user_name: userName,
      league: lg,
      gameweek: gw,
      paid: true,
      total_points: 0,
      formation: '4-3-3',
      active_chip: 'none'
    }
  ];

  let lastErr = null;
  for (let i = 0; i < attempts.length; i++) {
    const { error } = await sb.from('user_squads').insert(attempts[i]);
    if (!error) return;
    lastErr = error;
    console.warn('user_squads insert attempt', i, error.message);
    // try upsert
    const { error: upErr } = await sb
      .from('user_squads')
      .upsert(attempts[i], { onConflict: 'telegram_id,league,gameweek' });
    if (!upErr) return;
    lastErr = upErr;
  }
  throw new Error('Could not mark paid: ' + (lastErr && lastErr.message ? lastErr.message : 'unknown'));
}

async function createWalletRequest(data) {
  const sb = db();
  const amount = Number(data.amount);
  const reqType = String(data.type || '').toLowerCase();

  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Invalid amount');
  if (reqType !== 'deposit' && reqType !== 'withdrawal') throw new Error('Invalid wallet request type');

  let details = data.receipt || null;
  if (reqType === 'withdrawal') {
    details = [
      'Method: ' + (data.method || 'telebirr'),
      data.accountName ? 'Account name: ' + data.accountName : null,
      data.accountNo ? 'Account / phone: ' + data.accountNo : null
    ].filter(Boolean).join('\n');
  }

  const row = {
    telegram_id: String(data.telegramId),
    user_name: data.userName || 'Manager',
    amount: amount,
    method: data.method || 'telebirr',
    receipt: details,
    status: 'pending',
    type: reqType,
    request_type: reqType,
    account_name: data.accountName || null,
    account_no: data.accountNo || null
  };

  console.log('Inserting wallet_requests row:', JSON.stringify(row));
  let result = await sb.from('wallet_requests').insert(row).select().single();

  if (result.error) {
    console.warn('insert error, retrying stripped:', result.error.message);
    const attempts = [
      function (r) { const x = Object.assign({}, r); delete x.account_name; delete x.account_no; return x; },
      function (r) { const x = Object.assign({}, r); delete x.account_name; delete x.account_no; delete x.request_type; return x; },
      function (r) { const x = Object.assign({}, r); delete x.account_name; delete x.account_no; delete x.user_name; return x; }
    ];
    for (let i = 0; i < attempts.length; i++) {
      const payload = attempts[i](row);
      payload.type = reqType;
      result = await sb.from('wallet_requests').insert(payload).select().single();
      if (!result.error) break;
    }
  }
  if (result.error) throw result.error;

  const created = result.data || {};
  created.account_name = created.account_name || data.accountName || null;
  created.account_no = created.account_no || data.accountNo || null;
  created.method = created.method || data.method || 'telebirr';
  created.type = created.type || reqType;
  created.request_type = created.request_type || reqType;
  return created;
}

async function sendDepositRequest(request) {
  const text =
    '🚨 NEW DEPOSIT REQUEST\n\n' +
    '👤 User: ' + request.user_name + '\n' +
    '🆔 Telegram ID: ' + request.telegram_id + '\n\n' +
    '💵 Amount: ' + request.amount + ' ETB\n\n' +
    '📜 Telebirr Receipt:\n' +
    String(request.receipt || 'No receipt provided').slice(0, 1500) + '\n\n' +
    '🆔 Request ID:\n' + request.id + '\n\n' +
    '⏳ STATUS: PENDING';

  const data = await tg('sendMessage', {
    chat_id: ADMIN_CHAT_ID,
    text: text,
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ APPROVE DEPOSIT', callback_data: 'approve_dep_' + request.id }],
        [{ text: '❌ REJECT DEPOSIT', callback_data: 'reject_dep_' + request.id }]
      ]
    }
  });
  if (!data || !data.ok) {
    console.error('sendDepositRequest failed', ADMIN_CHAT_ID, data);
    return {
      ok: false,
      description: (data && (data.description || data.error)) ||
        ('Telegram send failed. Add the bot to group ' + ADMIN_CHAT_ID + ' as admin.')
    };
  }
  return data;
}

async function sendWithdrawalRequest(request) {
  const text =
    '💸 NEW WITHDRAWAL REQUEST\n\n' +
    '👤 User: ' + request.user_name + '\n' +
    '🆔 Telegram ID: ' + request.telegram_id + '\n\n' +
    '💵 Amount: ' + request.amount + ' ETB\n\n' +
    '🏦 Method: ' + String(request.method || 'telebirr').toUpperCase() + '\n\n' +
    '👤 Account Name:\n' + (request.account_name || '—') + '\n\n' +
    '📱 Account / Phone:\n' + (request.account_no || '—') + '\n\n' +
    '🆔 Request ID:\n' + request.id + '\n\n' +
    '⏳ STATUS: PENDING';

  return tg('sendMessage', {
    chat_id: ADMIN_CHAT_ID,
    text: text,
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ MARK PAID', callback_data: 'paid_wit_' + request.id }],
        [{ text: '❌ REJECT WITHDRAWAL', callback_data: 'reject_wit_' + request.id }]
      ]
    }
  });
}

async function processRequest(requestId) {
  const sb = db();
  const idRaw = String(requestId).trim();
  console.log('processRequest v5 id=', idRaw);

  let request = null;

  const { data: pending, error: pErr } = await sb
    .from('wallet_requests')
    .select('*')
    .eq('status', 'pending')
    .limit(100);
  if (pErr) console.warn('pending load', pErr.message);

  request = (pending || []).find(function (r) { return String(r.id) === idRaw; });

  if (!request) {
    const { data: recent, error: rErr } = await sb
      .from('wallet_requests')
      .select('*')
      .order('id', { ascending: false })
      .limit(50);
    if (rErr) throw new Error(rErr.message);
    request = (recent || []).find(function (r) { return String(r.id) === idRaw; });
  }
  if (!request) throw new Error('Request not found: ' + idRaw);

  if (String(request.status || '').toLowerCase() !== 'pending') {
    throw new Error('Request already processed: ' + request.status);
  }

  const amount = Number(request.amount || 0);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Invalid amount');

  const telegramId = String(request.telegram_id);
  const reqType = String(request.type || request.request_type || '').toLowerCase();
  const wallet = await getWallet(telegramId, request.user_name || 'Manager');
  const balance = Number(wallet.balance || 0);

  let newBalance = balance;
  let totalDeposits = Number(wallet.total_deposits || 0);
  let totalWithdrawals = Number(wallet.total_withdrawals || 0);

  if (reqType === 'deposit') {
    newBalance = balance + amount;
    totalDeposits += amount;
  } else if (reqType === 'withdrawal') {
    if (balance < amount) throw new Error('Insufficient balance for withdrawal');
    newBalance = balance - amount;
    totalWithdrawals += amount;
  } else {
    throw new Error('Unknown request type: ' + reqType);
  }

  const { error: walletErr } = await sb
    .from('user_wallets')
    .update({
      balance: newBalance,
      total_deposits: totalDeposits,
      total_withdrawals: totalWithdrawals
    })
    .eq('telegram_id', telegramId);
  if (walletErr) {
    console.error('wallet update error', walletErr);
    throw new Error(walletErr.message || walletErr || 'Wallet update failed');
  }

  const newStatus = reqType === 'withdrawal' ? 'paid' : 'approved';
  const { error: reqErr } = await sb
    .from('wallet_requests')
    .update({ status: newStatus, processed_at: new Date().toISOString() })
    .eq('id', request.id)
    .eq('status', 'pending');

  if (reqErr) {
    console.warn('status update by id failed:', reqErr.message);
    const { error: reqErr2 } = await sb
      .from('wallet_requests')
      .update({ status: newStatus, processed_at: new Date().toISOString() })
      .eq('telegram_id', telegramId)
      .eq('status', 'pending')
      .eq('amount', amount);
    if (reqErr2) throw reqErr2;
  }

  return {
    telegram_id: telegramId,
    amount: amount,
    new_balance: newBalance,
    type: reqType,
    status: newStatus
  };
}

async function rejectRequest(requestId) {
  const sb = db();
  const idRaw = String(requestId).trim();

  const { data: pending } = await sb
    .from('wallet_requests')
    .select('*')
    .eq('status', 'pending')
    .limit(100);

  let request = (pending || []).find(function (r) { return String(r.id) === idRaw; });
  if (!request) {
    const { data: recent } = await sb
      .from('wallet_requests')
      .select('*')
      .order('id', { ascending: false })
      .limit(50);
    request = (recent || []).find(function (r) { return String(r.id) === idRaw; });
  }
  if (!request) throw new Error('Request not found: ' + idRaw);
  if (String(request.status || '').toLowerCase() !== 'pending') {
    throw new Error('Request already processed: ' + request.status);
  }

  const { error: updateError } = await sb
    .from('wallet_requests')
    .update({ status: 'rejected', processed_at: new Date().toISOString() })
    .eq('id', request.id)
    .eq('status', 'pending');
  if (updateError) throw updateError;
  return request;
}

async function updateAdminMessage(query, statusText) {
  if (!query.message) return;
  const oldText = query.message.text || '';
  await tg('editMessageText', {
    chat_id: query.message.chat.id,
    message_id: query.message.message_id,
    text: oldText + '\n\n' + statusText,
    reply_markup: { inline_keyboard: [] }
  });
}

async function handleCallback(query) {
  if (!query.message || String(query.message.chat.id) !== ADMIN_CHAT_ID) {
    await tg('answerCallbackQuery', {
      callback_query_id: query.id,
      text: 'Unauthorized',
      show_alert: true
    });
    return;
  }

  const admin = await isAdmin(query.from.id);
  if (!admin) {
    await tg('answerCallbackQuery', {
      callback_query_id: query.id,
      text: 'Only group admins can process wallet requests.',
      show_alert: true
    });
    return;
  }

  const parts = String(query.data || '').split('_');
  const action = parts[0];
  const type = parts[1];
  const requestId = parts.slice(2).join('_');

  if (!requestId) {
    await tg('answerCallbackQuery', {
      callback_query_id: query.id,
      text: 'Invalid request.',
      show_alert: true
    });
    return;
  }

  if (action === 'approve' && type === 'dep') {
    try {
      const result = await processRequest(requestId);
      await tg('answerCallbackQuery', { callback_query_id: query.id, text: 'Deposit approved ✅' });
      await tg('sendMessage', {
        chat_id: result.telegram_id,
        text: '🎉 DEPOSIT APPROVED\n\n💵 Amount: ' + result.amount + ' ETB\n\n💰 New wallet balance:\n' + result.new_balance + ' ETB'
      });
      await updateAdminMessage(query, '✅ STATUS: APPROVED (+' + result.amount + ' ETB)');
    } catch (error) {
      console.error('Deposit approval error:', error);
      await tg('answerCallbackQuery', {
        callback_query_id: query.id,
        text: error.message || 'Could not approve.',
        show_alert: true
      });
    }
    return;
  }

  if (action === 'reject' && type === 'dep') {
    try {
      const request = await rejectRequest(requestId);
      await tg('answerCallbackQuery', { callback_query_id: query.id, text: 'Deposit rejected ❌' });
      await tg('sendMessage', {
        chat_id: request.telegram_id,
        text: '❌ DEPOSIT REJECTED\n\nYour ' + request.amount + ' ETB deposit could not be verified.'
      });
      await updateAdminMessage(query, '❌ STATUS: REJECTED');
    } catch (error) {
      console.error('Deposit rejection error:', error);
      await tg('answerCallbackQuery', {
        callback_query_id: query.id,
        text: error.message || 'Could not reject.',
        show_alert: true
      });
    }
    return;
  }

  if (action === 'paid' && type === 'wit') {
    try {
      const result = await processRequest(requestId);
      await tg('answerCallbackQuery', { callback_query_id: query.id, text: 'Withdrawal marked as paid ✅' });
      await tg('sendMessage', {
        chat_id: result.telegram_id,
        text: '💸 WITHDRAWAL COMPLETED\n\n💵 Amount: ' + result.amount + ' ETB\n\n💰 Remaining balance:\n' + result.new_balance + ' ETB'
      });
      await updateAdminMessage(query, '✅ STATUS: PAID OUT (-' + result.amount + ' ETB)');
    } catch (error) {
      console.error('Withdrawal payment error:', error);
      await tg('answerCallbackQuery', {
        callback_query_id: query.id,
        text: error.message || 'Could not process withdrawal.',
        show_alert: true
      });
    }
    return;
  }

  if (action === 'reject' && type === 'wit') {
    try {
      const request = await rejectRequest(requestId);
      await tg('answerCallbackQuery', { callback_query_id: query.id, text: 'Withdrawal rejected ❌' });
      await tg('sendMessage', {
        chat_id: request.telegram_id,
        text: '❌ WITHDRAWAL REJECTED\n\nYour ' + request.amount + ' ETB withdrawal was rejected.\nBalance unchanged.'
      });
      await updateAdminMessage(query, '❌ STATUS: REJECTED — BALANCE UNCHANGED');
    } catch (error) {
      console.error('Withdrawal rejection error:', error);
      await tg('answerCallbackQuery', {
        callback_query_id: query.id,
        text: error.message || 'Could not reject.',
        show_alert: true
      });
    }
    return;
  }

  await tg('answerCallbackQuery', { callback_query_id: query.id, text: 'Unknown action.' });
}

function adminAuthorized(update, req) {
  const key = String(process.env.SETTLE_SECRET || PUBLISH_SECRET || '').trim();
  const given = String((update && update.secret) || (req && req.headers && req.headers['x-admin-secret']) || '').trim();
  if (!key || !given || key.length !== given.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(key), Buffer.from(given)); } catch (e) { return false; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  console.log('ለ Fantasy API version: 2026-10-04-v6-bot-menu');

  if (req.method === 'GET') {
    // Health check for browser / Vercel — never throw
    const action = req.query && req.query.action;
    if (!action) {
      return res.status(200).json({
        ok: true,
        service: 'le-fantasy-telegram',
        bot: BOT_TOKEN ? 'token_set' : 'token_missing',
        supabase: (SUPABASE_URL && SUPABASE_SERVICE_KEY) ? 'env_set' : 'env_missing',
        mini_app: MINI_APP_URL
      });
    }
    if (action === 'auto_settle') {
      // Automatic prize payout. Called by a scheduler (Vercel cron sends "Authorization: Bearer CRON_SECRET",
      // or send x-admin-secret / ?secret=). Pays ONCE per gameweek, only when FPL says the GW is finished AND
      // data_checked, and only if nothing was paid for that GW yet. Anything unusual is HELD and reported to the admin chat.
      const cronKey = String(process.env.CRON_SECRET || '').trim();
      const bearer = String((req.headers && req.headers.authorization) || '').replace(/^Bearer\s+/i, '').trim();
      let okCron = false;
      try { okCron = !!(cronKey && bearer && cronKey.length === bearer.length && crypto.timingSafeEqual(Buffer.from(cronKey), Buffer.from(bearer))); } catch (e) {}
      const okAdmin = adminAuthorized({ secret: req.query && req.query.secret }, req);
      if (!okCron && !okAdmin) return res.status(401).json({ ok: false, error: 'Unauthorized' });
      const notifyAdmin = async function (text) { try { await tg('sendMessage', { chat_id: ADMIN_CHAT_ID, text: text }); } catch (e) {} };
      try {
        const settleKey = String(process.env.SETTLE_SECRET || PUBLISH_SECRET || '').trim();
        if (!settleKey) return res.status(500).json({ ok: false, error: 'SETTLE_SECRET not set' });
        const fromGw = Number(process.env.AUTO_SETTLE_FROM_GW || 10);
        const br = await fetch('https://fantasy.premierleague.com/api/bootstrap-static/', {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeFantasy/1.0)', 'Accept': 'application/json' }
        });
        if (!br.ok) return res.status(502).json({ ok: false, error: 'FPL responded ' + br.status });
        const boot = await br.json();
        const forcedGw = Number(req.query && req.query.gameweek);
        const done = (boot.events || []).filter(function (e) {
          if (!e || !e.finished || !e.data_checked) return false;
          return Number.isFinite(forcedGw) && forcedGw > 0 ? Number(e.id) === forcedGw : Number(e.id) >= fromGw;
        });
        if (!done.length) return res.status(200).json({ ok: true, skipped: 'no finished + data_checked gameweek yet' });
        const gw = Math.max.apply(null, done.map(function (e) { return Number(e.id); }));

        const sbA = db();
        const prev = await sbA.from('prize_settlements').select('telegram_id').eq('league', 'EPL').eq('gameweek', gw).limit(1);
        if (prev.error) return res.status(500).json({ ok: false, error: 'prize_settlements lookup failed' });
        if (prev.data && prev.data.length) return res.status(200).json({ ok: true, skipped: 'GW' + gw + ' already settled' });

        // Re-use the tested settle_gw_all action: dry run first, then confirm
        const callSettle = async function (body) {
          let out = { code: 0, body: null };
          const fres = {
            setHeader: function () {}, end: function () { return fres; },
            status: function (c) { out.code = c; return fres; },
            json: function (b) { out.body = b; return fres; },
            send: function (b) { out.body = b; return fres; }
          };
          await module.exports({ method: 'POST', body: body, headers: {}, query: {} }, fres);
          return out;
        };
        const base = { action: 'settle_gw_all', secret: settleKey, league: 'EPL', gameweek: gw };
        const dry = await callSettle(base);
        const sm = dry.body && dry.body.summary;
        if (!dry.body || !dry.body.ok || !sm) {
          await notifyAdmin('⚠️ Auto payout HELD for GW' + gw + ': dry run failed (' + ((dry.body && dry.body.error) || dry.code) + '). Run settle_gw_all manually.');
          return res.status(200).json({ ok: false, held: true, gameweek: gw, reason: 'dry run failed' });
        }
        if (!sm.managers || sm.unmatched_managers > 0) {
          await notifyAdmin('⚠️ Auto payout HELD for GW' + gw + ': ' + (sm.managers ? (sm.unmatched_managers + ' manager(s) have unmatched players') : 'no joined managers') + '. Review with a dry run, then pay manually.');
          return res.status(200).json({ ok: false, held: true, gameweek: gw, summary: sm });
        }
        const paidRes = await callSettle(Object.assign({}, base, { confirm: true }));
        const pb = paidRes.body || {};
        await notifyAdmin(pb.ok
          ? ('✅ Auto payout done for GW' + gw + '\nManagers: ' + sm.managers + '\nPool: ' + sm.playerPool + ' ETB\nPaid winners: ' + (pb.paidOut != null ? pb.paidOut : '?'))
          : ('⚠️ Auto payout for GW' + gw + ' stopped: ' + (pb.error || paidRes.code) + '. Check prize_settlements and run settle_gw_all again (already-paid users are skipped).'));
        return res.status(pb.ok ? 200 : 500).json({ ok: !!pb.ok, gameweek: gw, result: pb });
      } catch (e) {
        console.error('auto_settle', e);
        await notifyAdmin('⚠️ Auto payout error: ' + (e.message || e));
        return res.status(500).json({ ok: false, error: e.message || 'auto_settle failed' });
      }
    }
    if (action === 'fpl') {
      // Read-only FPL proxy (replaces the missing /api/fpl): ?action=fpl&path=/bootstrap-static/
      let fp = String((req.query && req.query.path) || '');
      if (fp && fp[0] !== '/') fp = '/' + fp;
      const fplOk = fp === '/bootstrap-static/' ||
        /^\/fixtures\/(\?event=\d{1,2})?$/.test(fp) ||
        /^\/event\/\d{1,2}\/live\/$/.test(fp);
      if (!fplOk) return res.status(400).json({ error: 'path not allowed' });
      try {
        const fr = await fetch('https://fantasy.premierleague.com/api' + fp, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeFantasy/1.0)', 'Accept': 'application/json' }
        });
        const ft = await fr.text();
        if (!fr.ok) return res.status(fr.status).json({ error: 'FPL responded ' + fr.status });
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
        return res.status(200).send(ft);
      } catch (e) {
        return res.status(502).json({ error: (e && e.message) || 'proxy failed' });
      }
    }
    if (action === 'publish') {
      const secret = (req.query && req.query.secret) || (req.headers['x-publish-secret']) || '';
      if (PUBLISH_SECRET && String(secret) !== PUBLISH_SECRET) {
        return res.status(401).json({ ok: false, error: 'Unauthorized' });
      }
      if (!PUBLISH_SECRET) {
        console.warn('PUBLISH_SECRET not set — publish endpoint is open; set it in Vercel env');
      }
      try {
        const caption = (req.query && req.query.caption) || (req.body && req.body.caption) || defaultAdCaption();
        const photoUrl = (req.query && req.query.photo) || (req.body && req.body.photo) || '';
        const result = await publishChannelPost({ caption: caption, photoUrl: photoUrl });
        return res.status(200).json({ ok: !!(result && result.ok), result: result });
      } catch (e) {
        console.error('publish error', e);
        return res.status(500).json({ ok: false, error: e.message || String(e) });
      }
    }

    if (action === 'wallet') {
      try {
        const initData = req.headers.authorization || '';
        const user = verifyTelegramInitData(initData);
        if (!user) {
          return res.status(401).json({ ok: false, error: 'Invalid Telegram authentication' });
        }
        const wallet = await getWallet(
          user.id,
          [user.first_name, user.last_name].filter(Boolean).join(' ')
        );
        return res.status(200).json({
          ok: true,
          wallet: {
            balance: Number(wallet.balance || 0),
            total_deposits: Number(wallet.total_deposits || 0),
            total_withdrawals: Number(wallet.total_withdrawals || 0),
            total_winnings: Number(wallet.total_winnings || 0)
          }
        });
      } catch (error) {
        console.error('GET wallet error:', error);
        return res.status(500).json({ ok: false, error: error.message });
      }
    }
    return res.status(200).send('ለ Fantasy wallet API OK — v5');
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const update = req.body || {};

    if (update.callback_query) {
      await handleCallback(update.callback_query);
      return res.status(200).json({ ok: true });
    }

    // Bot chat: text commands + photo publish from phone
    if (update.message) {
      try {
        // Admin sent a photo from device → post to channel with Play button
        if (update.message.photo && update.message.photo.length) {
          await handleAdminPhoto(update.message);
          return res.status(200).json({ ok: true });
        }
        if (update.message.video || (update.message.document && update.message.document.mime_type && String(update.message.document.mime_type).indexOf('video') >= 0)) {
          await handleAdminVideo(update.message);
          return res.status(200).json({ ok: true });
        }
        if (update.message.text) {
          await handleBotText(update.message);
        }
      } catch (e) {
        console.error('handleBot message error:', e);
      }
      return res.status(200).json({ ok: true });
    }

    if (update.message && update.message.web_app_data) {
      const message = update.message;
      const user = message.from;
      let data;
      try {
        data = JSON.parse(message.web_app_data.data);
      } catch (e) {
        return res.status(200).json({ ok: true });
      }

      if (data.type === 'DEPOSIT_SUBMISSION') {
        await assertNoDuplicateReceipt(data.receipt || '', user.id);
        const request = await createWalletRequest({
          telegramId: user.id,
          userName: userLabel(user),
          type: 'deposit',
          amount: data.amount,
          receipt: data.receipt || ''
        });
        await sendDepositRequest(request);
      }

      if (data.type === 'WITHDRAWAL_REQUEST') {
        const request = await createWalletRequest({
          telegramId: user.id,
          userName: userLabel(user),
          type: 'withdrawal',
          amount: data.amount,
          method: data.method,
          accountName: data.accountName,
          accountNo: data.accountNo
        });
        await sendWithdrawalRequest(request);
      }

      return res.status(200).json({ ok: true });
    }

    if (update.action === 'get_wallet') {
      const initData = update.initData || req.headers.authorization || '';
      const user = verifyTelegramInitData(initData);
      if (!user) {
        return res.status(401).json({ ok: false, error: 'Invalid Telegram authentication' });
      }
      const wallet = await getWallet(
        user.id,
        [user.first_name, user.last_name].filter(Boolean).join(' ')
      );
      return res.status(200).json({
        ok: true,
        wallet: {
          balance: Number(wallet.balance || 0),
          total_deposits: Number(wallet.total_deposits || 0),
          total_withdrawals: Number(wallet.total_withdrawals || 0),
          total_winnings: Number(wallet.total_winnings || 0)
        }
      });
    }

    if (update.action === 'wallet_request') {
      const initData = update.initData || '';
      const user = verifyTelegramInitData(initData);
      if (!user) {
        return res.status(401).json({ ok: false, error: 'Invalid Telegram authentication' });
      }

      const type = update.type;
      if (type !== 'deposit' && type !== 'withdrawal') {
        return res.status(400).json({ ok: false, error: 'Invalid wallet request type' });
      }

      const amount = Number(update.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ ok: false, error: 'Invalid amount' });
      }

      if (type === 'deposit') {
        try { assertDepositReceipt(update.receipt || update.sms || '', amount); } catch (e) {
          return res.status(400).json({ ok: false, error: e.message });
        }
      }
      if (type === 'deposit') {
        await assertNoDuplicateReceipt(update.receipt || '', user.id);
      }

      if (type === 'withdrawal') {
        const wallet = await getWallet(
          user.id,
          [user.first_name, user.last_name].filter(Boolean).join(' ')
        );
        if (Number(wallet.balance || 0) < amount) {
          return res.status(400).json({ ok: false, error: 'Insufficient balance' });
        }
      }

      const request = await createWalletRequest({
        telegramId: user.id,
        userName: [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Manager',
        type: type,
        amount: amount,
        method: update.method || 'telebirr',
        accountName: update.accountName,
        accountNo: update.accountNo,
        receipt: update.receipt
      });

      if (type === 'deposit') {
        const result = await sendDepositRequest(request);
        if (!result.ok) throw new Error((result && result.description) || 'Could not send deposit request to admin group. Add @Lefantasy_bot to the admin group as administrator.');
      } else {
        const result = await sendWithdrawalRequest(request);
        if (!result.ok) throw new Error('Could not send withdrawal request to admin group');
      }

      return res.status(200).json({
        ok: true,
        request_id: request.id,
        message: type === 'deposit'
          ? 'Deposit request sent for approval.'
          : 'Withdrawal request sent for processing.'
      });
    }

    
    
    if (update.action === 'get_leaderboard') {
      try {
        const league = String(update.league || 'EPL').toUpperCase();
        const gw = Number(update.gameweek || 0) || null;
        const sb = db();
        let q = sb.from('user_squads')
          .select('user_name, total_points, paid, telegram_id, players, formation, captain_id, active_chip, gameweek, joined_at, created_at, league')
          .order('total_points', { ascending: false })
          .limit(400);
        if (gw) q = q.eq('gameweek', gw);
        let { data, error } = await q;
        if (error) {
          console.warn('get_leaderboard squads', error.message);
          const r2 = await sb.from('user_squads').select('*').limit(400);
          data = r2.data || [];
          error = r2.error;
        }
        let rows = data || [];
        // filter league loosely
        rows = rows.filter(function (r) {
          var lg = String((r && r.league) || league).toUpperCase();
          if (league === 'EPL') return lg.indexOf('UCL') < 0 && lg.indexOf('CHAMPIONS') < 0;
          return lg.indexOf('UCL') >= 0 || lg.indexOf('CHAMPIONS') >= 0 || lg === league;
        });
        // Only this gameweek's contest (also guards the select('*') fallback above)
        if (gw) rows = rows.filter(function (r) { return Number(r && r.gameweek || 0) === gw; });

        // Merge contest_entries
        try {
          const ce = await sb.from('contest_entries').select('*').limit(500);
          if (ce.data) {
            const byId = {};
            rows.forEach(function (r) { byId[String(r.telegram_id)] = r; });
            ce.data.forEach(function (r) {
              if (!r) return;
              if (gw && Number(r.gameweek || 0) !== gw) return;
              var lg = String(r.league || 'EPL').toUpperCase();
              if (league === 'EPL' && (lg.indexOf('UCL') >= 0 || lg.indexOf('CHAMPIONS') >= 0)) return;
              var id = String(r.telegram_id || '');
              if (!id) return;
              var paid = r.paid === true || r.paid === 't' || r.paid === 1 || r.paid === '1' || r.paid === 'true'; 
              if (!paid) return;
              if (!byId[id]) {
                byId[id] = {
                  telegram_id: id,
                  user_name: r.user_name || ('Manager ' + id.slice(-4)),
                  total_points: Number(r.total_points || 0),
                  paid: true,
                  players: r.players,
                  gameweek: r.gameweek,
                  created_at: r.created_at,
                  league: league
                };
              } else {
                byId[id].paid = true;
                if (!byId[id].user_name && r.user_name) byId[id].user_name = r.user_name;
              }
            });
            rows = Object.keys(byId).map(function (k) { return byId[k]; });
          }
        } catch (e) { console.warn('ce merge', e.message || e); }

        // Prefer paid or has players
        function hasPlayers(m) {
          var p = m && m.players;
          if (!p) return false;
          if (typeof p === 'string') {
            try { p = JSON.parse(p); } catch (e) { return p.length > 10; }
          }
          if (Array.isArray(p)) return p.filter(Boolean).length >= 8;
          if (typeof p === 'object') return Object.keys(p).length >= 8;
          return false;
        }
        var filtered = rows.filter(function (m) {
          return m && (m.paid === true || m.paid === 't' || m.paid === 1 || m.paid === '1' || m.paid === 'true' || (!gw && hasPlayers(m)));
        });
        if (!filtered.length && !gw) filtered = rows;

        filtered.sort(function (a, b) {
          return Number(b.total_points || 0) - Number(a.total_points || 0);
        });

        return res.status(200).json({
          ok: true,
          league: league,
          count: filtered.length,
          managers: filtered.slice(0, 100)
        });
      } catch (e) {
        console.error('get_leaderboard', e);
        return res.status(500).json({ ok: false, error: e.message || 'leaderboard failed' });
      }
    }

    
    if (update.action === 'revoke_settlements') {
      // Reverse incorrect prize credits for a GW (ADMIN ONLY)
      if (!adminAuthorized(update, req)) return res.status(401).json({ ok: false, error: 'Admin secret required' });
      try {
        const league = String(update.league || 'EPL').toUpperCase();
        const gw = Number(update.gameweek || 10);
        const sb = db();
        const { data: rows, error } = await sb.from('prize_settlements')
          .select('*')
          .eq('league', league)
          .eq('gameweek', gw);
        if (error) {
          return res.status(500).json({ ok: false, error: error.message });
        }
        let reversed = 0;
        let total = 0;
        for (const row of (rows || [])) {
          const tid = String(row.telegram_id);
          const amt = Number(row.amount || 0);
          if (!tid || amt <= 0) continue;
          try {
            const wallet = await getWallet(tid, row.user_name || 'Manager');
            const newBal = Math.max(0, Number(wallet.balance || 0) - amt);
            const newWin = Math.max(0, Number(wallet.total_winnings || 0) - amt);
            await sb.from('user_wallets').update({
              balance: newBal,
              total_winnings: newWin
            }).eq('telegram_id', tid);
            total += amt;
            reversed++;
            try {
              await tg('sendMessage', {
                chat_id: tid,
                text: '⚠️ Prize correction\nThe GW' + gw + ' payout of ' + amt + ' ETB was sent by mistake.\nIt has been removed from your wallet.\nNew balance: ' + newBal + ' ETB\nSorry for the confusion.'
              });
            } catch (e) {}
          } catch (e) {
            console.error('revoke one', tid, e);
          }
        }
        // delete settlement records
        try {
          await sb.from('prize_settlements').delete().eq('league', league).eq('gameweek', gw);
        } catch (e) {
          console.warn('delete settlements', e.message || e);
        }
        return res.status(200).json({
          ok: true,
          league: league,
          gameweek: gw,
          reversed: reversed,
          total_etb: total
        });
      } catch (e) {
        console.error('revoke_settlements', e);
        return res.status(500).json({ ok: false, error: e.message || 'revoke failed' });
      }
    }


    if (update.action === 'settle_gw_all') {
      // ADMIN ONLY. Without confirm:true this is a DRY RUN: pays nothing, returns the full ranking + prizes.
      if (!adminAuthorized(update, req)) {
        return res.status(401).json({ ok: false, error: 'Admin secret required. Set SETTLE_SECRET in Vercel and send it as "secret".' });
      }
      try {
        const league = String(update.league || 'EPL').toUpperCase();
        const gw = Number(update.gameweek);
        if (!Number.isFinite(gw) || gw < 1) return res.status(400).json({ ok: false, error: 'gameweek is required' });
        if (league !== 'EPL') return res.status(400).json({ ok: false, error: 'Only EPL settlement is supported' });
        const confirm = update.confirm === true || update.confirm === 'true';
        const entry = 100;
        const sb = db();
        const isPaid = function (v) { return v === true || v === 't' || v === 1 || v === '1' || v === 'true'; };
        const notUcl = function (r) {
          const lg = String((r && r.league) || 'EPL').toUpperCase();
          return lg.indexOf('UCL') < 0 && lg.indexOf('CHAMPIONS') < 0;
        };

        // 1) Managers who JOINED this gameweek (paid squad rows + paid contest entries) — nobody else
        const sq = await sb.from('user_squads').select('*').eq('gameweek', gw).limit(2000);
        if (sq.error) throw new Error('user_squads: ' + (sq.error.message || sq.error));
        const byId = {};
        (sq.data || []).forEach(function (r) {
          if (!r || !r.telegram_id || !notUcl(r)) return;
          byId[String(r.telegram_id)] = r;
        });
        const ce = await sb.from('contest_entries').select('*').eq('gameweek', gw).limit(2000);
        if (ce.error) throw new Error('contest_entries: ' + (ce.error.message || ce.error));
        (ce.data || []).forEach(function (r) {
          if (!r || !r.telegram_id || !notUcl(r) || !isPaid(r.paid)) return;
          const id = String(r.telegram_id);
          if (!byId[id]) byId[id] = { telegram_id: id, user_name: r.user_name, players: [], paid: true, created_at: r.created_at };
          else byId[id].paid = true;
        });
        let rows = Object.keys(byId).map(function (k) { return byId[k]; }).filter(function (m) { return isPaid(m.paid); });

        // 2) Final FPL points of this gameweek (server-side, not the stale stored totals)
        const fplGet = async function (path) {
          const r = await fetch('https://fantasy.premierleague.com/api' + path, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeFantasy/1.0)', 'Accept': 'application/json' }
          });
          if (!r.ok) throw new Error('FPL ' + path + ' responded ' + r.status);
          return r.json();
        };
        const boot = await fplGet('/bootstrap-static/');
        const ev = (boot.events || []).find(function (e) { return Number(e.id) === gw; });
        if (!ev) throw new Error('GW' + gw + ' not found in FPL data');
        const live = await fplGet('/event/' + gw + '/live/');
        const livePts = {};
        (live.elements || []).forEach(function (row) {
          livePts[Number(row.id)] = Number((row.stats && row.stats.total_points) != null ? row.stats.total_points : 0);
        });
        const elementIds = {};
        (boot.elements || []).forEach(function (el) { elementIds[Number(el.id)] = true; });
        const plRes = await sb.from('players').select('id, fpl_id').limit(5000);
        const fplIdOf = {};
        ((plRes && plRes.data) || []).forEach(function (p) { if (p.fpl_id != null) fplIdOf[String(p.id)] = Number(p.fpl_id); });

        const FORMS = {
          '4-3-3': { def: 4, mid: 3, fwd: 3 }, '3-4-3': { def: 3, mid: 4, fwd: 3 }, '3-5-2': { def: 3, mid: 5, fwd: 2 },
          '4-4-2': { def: 4, mid: 4, fwd: 2 }, '4-5-1': { def: 4, mid: 5, fwd: 1 }, '5-3-2': { def: 5, mid: 3, fwd: 2 }
        };
        const posOf = function (p) { const x = String((p && (p.pos || p.position)) || '').toUpperCase(); return x === 'GK' ? 'GKP' : x; };
        const chipOf = function (v) {
          const c = String(v || '').toLowerCase();
          if (c === 'tc' || c === 'triple_captain' || c === 'triple captain') return 'TC';
          if (c === 'bb' || c === 'bench_boost' || c === 'bench boost') return 'BB';
          return null;
        };

        // Same rule as the leaderboard: 1 GK + formation outfield; captain x2 (x3 Triple Captain); Bench Boost adds the bench
        rows.forEach(function (m) {
          let players = m.players;
          if (typeof players === 'string') { try { players = JSON.parse(players); } catch (e) { players = []; } }
          players = Array.isArray(players) ? players : [];
          let unmatched = 0;
          const ptsOf = function (p) {
            let raw = p.fpl_id != null ? p.fpl_id : (fplIdOf[String(p.id)] != null ? fplIdOf[String(p.id)] : p.id);
            const eid = Number(raw);
            if (!Number.isFinite(eid) || !elementIds[eid]) { unmatched++; return 0; }
            return livePts[eid] != null ? livePts[eid] : 0;
          };
          const form = FORMS[m.formation] || FORMS['4-3-3'];
          const byPos = function (k) { return players.filter(function (p) { return posOf(p) === k; }); };
          let xi = [].concat(byPos('GKP').slice(0, 1), byPos('DEF').slice(0, form.def), byPos('MID').slice(0, form.mid), byPos('FWD').slice(0, form.fwd));
          let bench;
          if (xi.length === 11) bench = players.filter(function (p) { return xi.indexOf(p) < 0; });
          else { xi = players.slice(0, 11); bench = players.slice(11); }
          const chip = chipOf(m.active_chip);
          const mult = chip === 'TC' ? 3 : 2;
          let total = 0;
          xi.forEach(function (p) {
            let pts = ptsOf(p);
            if (m.captain_id != null && String(p.id) === String(m.captain_id)) pts = pts * mult;
            total += pts;
          });
          if (chip === 'BB') bench.forEach(function (p) { total += ptsOf(p); });
          m._final = total;
          m._chip = chip;
          m._unmatched = unmatched;
          m._empty = players.length === 0;
        });

        // Ranking: points, then earlier entry, then name (same tie-break as the leaderboard)
        rows.sort(function (a, b) {
          if (b._final !== a._final) return b._final - a._final;
          const ta = Date.parse(a.joined_at || a.created_at || 0) || 0;
          const tb = Date.parse(b.joined_at || b.created_at || 0) || 0;
          if (ta && tb && ta !== tb) return ta - tb;
          const na = String(a.user_name || '').toLowerCase(), nb = String(b.user_name || '').toLowerCase();
          return na < nb ? -1 : (na > nb ? 1 : 0);
        });

        const n = rows.length;
        const totalCollected = n * entry;
        const playerPool = Math.round(totalCollected * 0.75);
        // prize distribution same spirit as client: top heavy + last 2 min 100
        const prizes = new Array(n).fill(0);
        if (n > 0) {
          let lastCount = n >= 12 ? 2 : (n === 11 ? 1 : 0);
          let lastEach = lastCount ? Math.max(100, Math.round(playerPool * 0.035)) : 0;
          let lastTotal = lastEach * lastCount;
          let remaining = Math.max(0, playerPool - lastTotal);
          const topN = n - lastCount;
          let weights = [];
          for (let i = 0; i < topN; i++) {
            weights.push(Math.max(1, topN - i));
          }
          if (weights.length > 0) weights[0] *= 3;
          if (weights.length > 1) weights[1] *= 2;
          const wsum = weights.reduce(function (a, b) { return a + b; }, 0) || 1;
          for (let i = 0; i < topN; i++) {
            prizes[i] = Math.round(remaining * (weights[i] / wsum));
          }
          for (let i = 0; i < lastCount; i++) {
            prizes[n - lastCount + i] = lastEach;
          }
          const sumP = prizes.reduce(function (a, b) { return a + b; }, 0);
          if (sumP !== playerPool && prizes.length) prizes[0] += (playerPool - sumP);
        }

        // Already settled? (if this lookup fails we STOP rather than risk paying twice)
        const ps = await sb.from('prize_settlements').select('telegram_id').eq('league', league).eq('gameweek', gw).limit(5000);
        if (ps.error) throw new Error('prize_settlements lookup failed: ' + (ps.error.message || ps.error));
        const settled = {};
        (ps.data || []).forEach(function (r) { settled[String(r.telegram_id)] = true; });

        const unmatchedManagers = rows.filter(function (m) { return m._unmatched > 0; }).length;
        const ranking = rows.map(function (m, i) {
          return {
            rank: i + 1, telegram_id: String(m.telegram_id), user_name: m.user_name || 'Manager',
            points: m._final, chip: m._chip || 'none', formation: m.formation || '4-3-3',
            unmatched_players: m._unmatched, no_squad: m._empty, prize: prizes[i] || 0,
            already_paid: !!settled[String(m.telegram_id)]
          };
        });
        const summary = {
          league: league, gameweek: gw, fpl_finished: !!ev.finished, fpl_data_checked: !!ev.data_checked,
          managers: n, totalCollected: totalCollected, playerPool: playerPool,
          unmatched_managers: unmatchedManagers, already_paid: ranking.filter(function (r) { return r.already_paid; }).length
        };

        if (!confirm) {
          return res.status(200).json({ ok: true, dryRun: true, paid: false, summary: summary, ranking: ranking });
        }

        // ---- REAL PAYOUT: safety checks ----
        if (!n) return res.status(409).json({ ok: false, error: 'No joined managers for this gameweek', summary: summary });
        if (!ev.finished) return res.status(409).json({ ok: false, error: 'FPL has not marked GW' + gw + ' as finished yet', summary: summary });
        if (unmatchedManagers > 0 && update.allowUnmatched !== true) {
          return res.status(409).json({ ok: false, error: unmatchedManagers + ' manager(s) have players that could not be matched to FPL. Run the dry run, review, or pass allowUnmatched:true.', summary: summary });
        }

        let paidOut = 0;
        let skipped = 0;
        for (let i = 0; i < rows.length; i++) {
          const m = rows[i];
          const tid = String(m.telegram_id);
          const prize = Number(prizes[i] || 0);
          if (prize <= 0 || settled[tid]) { skipped++; continue; }
          const userName = m.user_name || 'Manager';
          // 1) record first (prevents double pay on re-run); 2) credit wallet; if crediting fails, undo the record and stop
          const ins = await sb.from('prize_settlements').insert({
            telegram_id: tid, user_name: userName, league: league, gameweek: gw, rank: i + 1, amount: prize
          });
          if (ins && ins.error) {
            return res.status(500).json({ ok: false, error: 'Could not record settlement for ' + tid + ': ' + (ins.error.message || ins.error), paidOut: paidOut, stoppedAtRank: i + 1 });
          }
          let newBal;
          try {
            const wallet = await getWallet(tid, userName);
            newBal = Number(wallet.balance || 0) + prize;
            const up = await sb.from('user_wallets').update({
              balance: newBal,
              total_winnings: Number(wallet.total_winnings || 0) + prize
            }).eq('telegram_id', tid);
            if (up && up.error) throw new Error(up.error.message || String(up.error));
          } catch (e) {
            try { await sb.from('prize_settlements').delete().eq('telegram_id', tid).eq('league', league).eq('gameweek', gw); } catch (e2) {}
            return res.status(500).json({ ok: false, error: 'Wallet credit failed for ' + tid + ': ' + (e.message || e), paidOut: paidOut, stoppedAtRank: i + 1 });
          }
          try {
            await tg('sendMessage', {
              chat_id: tid,
              text: '🏆 GW' + gw + ' finished!\nYour rank: #' + (i + 1) + '\nPrize: +' + prize + ' ETB\nNew balance: ' + newBal + ' ETB'
            });
          } catch (e) {}
          paidOut++;
        }

        return res.status(200).json({ ok: true, dryRun: false, paid: true, paidOut: paidOut, skipped: skipped, summary: summary });
      } catch (e) {
        console.error('settle_gw_all', e);
        return res.status(500).json({ ok: false, error: e.message || 'settle failed' });
      }
    }

if (update.action === 'settle_gw_prize') {
      // Prize amount comes from the caller, so this is ADMIN ONLY (users must never set their own prize)
      if (!adminAuthorized(update, req)) return res.status(401).json({ ok: false, error: 'Admin secret required' });
      if (update.confirm !== true && update.confirm !== 'true') {
        return res.status(200).json({ ok: false, error: 'Settlement disabled until GW fully ends. Pass confirm:true.' });
      }
      const initData = update.initData || '';
      const user = verifyTelegramInitData(initData);
      if (!user) {
        return res.status(401).json({ ok: false, error: 'Invalid Telegram authentication' });
      }
      try {
        const league = String(update.league || 'EPL').toUpperCase();
        const gw = Number(update.gameweek || 1);
        const prize = Math.max(0, Math.round(Number(update.prize || 0)));
        const rank = Number(update.rank || 0);
        const tid = String(user.id);
        if (prize <= 0) {
          return res.status(200).json({ ok: true, balance: null, skipped: true, message: 'No prize for this rank' });
        }
        const sb = db();
        // Idempotent: prize_settlements table or unique key in wallet_requests note
        try {
          const { data: existing } = await sb
            .from('prize_settlements')
            .select('id')
            .eq('telegram_id', tid)
            .eq('league', league)
            .eq('gameweek', gw)
            .maybeSingle();
          if (existing) {
            const w = await getWallet(tid, [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Manager');
            return res.status(200).json({ ok: true, balance: Number(w.balance || 0), already: true });
          }
        } catch (e) {
          console.warn('prize_settlements lookup', e.message || e);
        }

        const userName = [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Manager';
        let wallet = await getWallet(tid, userName);
        const newBal = Number(wallet.balance || 0) + prize;
        const { error: wErr } = await sb.from('user_wallets').update({
          balance: newBal,
          total_winnings: Number(wallet.total_winnings || 0) + prize
        }).eq('telegram_id', tid);
        if (wErr) throw wErr;

        try {
          await sb.from('prize_settlements').insert({
            telegram_id: tid,
            user_name: userName,
            league: league,
            gameweek: gw,
            rank: rank,
            amount: prize
          });
        } catch (e) {
          console.warn('prize_settlements insert', e.message || e);
        }

        try {
          await tg('sendMessage', {
            chat_id: tid,
            text: '🏆 GW' + gw + ' ' + league + ' prize!\nRank #' + rank + '\n+' + prize + ' ETB added to your wallet.\nBalance: ' + newBal + ' ETB'
          });
        } catch (e) {}

        return res.status(200).json({ ok: true, balance: newBal, amount: prize, rank: rank });
      } catch (e) {
        console.error('settle_gw_prize', e);
        return res.status(400).json({ ok: false, error: e.message || 'Settle failed' });
      }
    }

if (update.action === 'redeem_promo') {
      const initData = update.initData || '';
      const user = verifyTelegramInitData(initData);
      if (!user) {
        return res.status(401).json({ ok: false, error: 'Invalid Telegram authentication' });
      }
      try {
        const result = await redeemWalletPromoCode(user, update.code);
        return res.status(200).json({
          ok: true,
          balance: result.balance,
          amount: result.amount,
          code: result.code,
          message: '+' + result.amount + ' ETB credited'
        });
      } catch (e) {
        console.error('redeem_promo:', e);
        return res.status(400).json({ ok: false, error: e.message || 'Redeem failed' });
      }
    }

    if (update.action === 'join_league') {
      const initData = update.initData || '';
      const user = verifyTelegramInitData(initData);
      if (!user) {
        return res.status(401).json({ ok: false, error: 'Invalid Telegram authentication' });
      }
      try {
        const result = await joinLeagueServer(user, update.league, update.gameweek || 1, { amount: update.amount, promo_code: update.promo_code });
        return res.status(200).json({
          ok: true,
          already: !!result.already,
          league: result.league,
          balance: result.balance,
          charged: result.charged || 0,
          message: result.already
            ? 'Already joined this league this week.'
            : 'Joined ' + result.league + '. ' + (result.charged || 0) + ' ETB deducted.'
        });
      } catch (e) {
        console.error('join_league error:', e);
        return res.status(400).json({ ok: false, error: e.message || 'Join failed' });
      }
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('ለ Fantasy API error:', error);
    return res.status(500).json({ ok: false, error: error.message || 'Server error' });
  }
};
