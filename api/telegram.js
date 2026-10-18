/**
 * ለ Fantasy — Telegram webhook (Vercel: api/telegram.js)
 *
 * Vercel Environment Variables:
 *   BOT_TOKEN              = your bot token
 *   ADMIN_CHAT_ID          = -1004436177839
 *   SUPABASE_URL           = https://iqbwqywwrqeeycfyuwms.supabase.co
 *   SUPABASE_SERVICE_KEY   = service_role key (secret)
 *
 * Webhook:
 *   https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://YOUR-APP.vercel.app/api/telegram
 */

const crypto = require('crypto');

const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
const ADMIN_CHAT_ID = String(process.env.ADMIN_CHAT_ID || '-1004436177839').trim();
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
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

async function handleBotText(msg) {
  const chatId = msg.chat.id;
  const text = String(msg.text || '').trim();
  const lower = text.toLowerCase();

  if (lower === '/start' || lower.indexOf('/start') === 0) {
    await handleStart(msg);
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

async function joinLeagueServer(user, league, gameweek) {
  const sb = db();
  const lg = String(league || '').toUpperCase();
  if (lg !== 'EPL' && lg !== 'UCL') throw new Error('Invalid league');
  const gw = Number(gameweek) || 1;
  const tid = String(user.id);
  const userName = [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Manager';
  const ENTRY = 100;

  console.log('joinLeagueServer', tid, lg, gw);

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
    throw new Error('Insufficient balance. Need 100 ETB (you have ' + balance + ').');
  }

  const newBalance = balance - ENTRY;
  const { error: wErr } = await sb
    .from('user_wallets')
    .update({ balance: newBalance })
    .eq('telegram_id', tid);
  if (wErr) throw wErr;

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

    // Bot chat: /start + reply keyboard buttons (Hahu-style)
    if (update.message && update.message.text) {
      try {
        await handleBotText(update.message);
      } catch (e) {
        console.error('handleBotText error:', e);
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

    if (update.action === 'join_league') {
      const initData = update.initData || '';
      const user = verifyTelegramInitData(initData);
      if (!user) {
        return res.status(401).json({ ok: false, error: 'Invalid Telegram authentication' });
      }
      try {
        const result = await joinLeagueServer(user, update.league, update.gameweek || 1);
        return res.status(200).json({
          ok: true,
          already: !!result.already,
          league: result.league,
          balance: result.balance,
          charged: result.charged || 0,
          message: result.already
            ? 'Already joined this league this week.'
            : 'Joined ' + result.league + '. 100 ETB deducted.'
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
