// api/telegram.js — tiny wrapper: loads ../bot.js and shows the real error if it fails to load
let handler = null;
let loadError = null;
try {
  handler = require('../bot.js');
} catch (e) {
  loadError = e;
}

module.exports = async function (req, res) {
  if (loadError) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).send(JSON.stringify({
      ok: false,
      wrapper: 'load-failed',
      node: process.version,
      error: String(loadError && loadError.message),
      stack: String(loadError && loadError.stack).split('\n').slice(0, 8)
    }, null, 2));
  }
  try {
    return await handler(req, res);
  } catch (e) {
    console.error('handler crash', e);
    if (!res.headersSent) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.status(200).json({ ok: false, wrapper: 'handler-threw', node: process.version, error: String(e && e.message), stack: String(e && e.stack).split('\n').slice(0, 8) });
    }
  }
};
