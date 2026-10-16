#!/usr/bin/env node
/**
 * Regression test for the Facebook Messenger webhook.
 *
 *   cd agent && node scripts/test-messenger-webhook.js
 *
 * Requires `dist/` to be built (`npx tsc`) — it exercises the compiled code, because that is
 * what PM2 actually runs.
 *
 * ⚠️ This mounts ONLY the webhook router, on a spare port. It deliberately does NOT import
 * `src/index.ts`, because that starts the BullMQ worker — and a second worker on the same
 * queue produces duplicate replies to real paying customers. Never "test" by running a second
 * copy of the agent.
 *
 * It needs no Meta credentials: it invents a throwaway App Secret and signs its own payloads,
 * so it can prove signature verification works without touching Meta.
 */

process.env.MESSENGER_PAGE_ID = '1234567890';
process.env.MESSENGER_APP_SECRET = 'test-app-secret';
process.env.MESSENGER_PAGE_ACCESS_TOKEN = 'test-page-token';
process.env.MESSENGER_VERIFY_TOKEN = 'test-verify-token';
// Critical: without this the router would enqueue its synthetic fixtures into the LIVE queue
// and the real worker would try to reply to a fake PSID. The flag is also the production kill
// switch for the channel.
process.env.MESSENGER_ENQUEUE = 'false';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');

const AGENT_DIR = path.resolve(__dirname, '..');
const DIST = path.join(AGENT_DIR, 'dist', 'channels', 'messenger');

if (!fs.existsSync(path.join(DIST, 'webhook.js'))) {
  console.error('dist/channels/messenger/webhook.js is missing — run `npx tsc` first.');
  process.exit(2);
}

const { messengerWebhookRouter, parseWebhookEvents } = require(path.join(DIST, 'webhook.js'));
const { verifyWebhookSignature } = require(path.join(DIST, 'signature.js'));
const { normalizeCustomerId, messengerCustomerId } = require(path.join(DIST, 'identity.js'));
const { splitMessage } = require(path.join(DIST, 'client.js'));
const { isMessengerConfigured } = require(path.join(DIST, 'client.js'));

const APP_SECRET = 'test-app-secret';
const PORT = 3999;

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${extra ? ' -> ' + extra : ''}`);
  }
}

function request(method, reqPath, { body, headers = {} } = {}) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : Buffer.from(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        method,
        path: reqPath,
        headers: { ...(payload ? { 'Content-Length': payload.length } : {}), ...headers },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on('error', (e) => resolve({ status: 0, body: String(e) }));
    if (payload) req.write(payload);
    req.end();
  });
}

const sign = (raw) =>
  'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex');

const app = express();
app.use('/api/webhook/messenger', messengerWebhookRouter);

const server = app.listen(PORT, '127.0.0.1', async () => {
  try {
    console.log('\n— configuration —');
    check('all four vars set -> channel considered configured', isMessengerConfigured() === true);

    console.log('\n— HTTP layer —');
    const v = await request(
      'GET',
      '/api/webhook/messenger?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=1158201444',
    );
    check('GET handshake returns 200', v.status === 200, `got ${v.status}`);
    check('GET handshake echoes the challenge', v.body === '1158201444', `got "${v.body}"`);

    const bad = await request(
      'GET',
      '/api/webhook/messenger?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1',
    );
    check('GET with wrong verify token -> 403', bad.status === 403, `got ${bad.status}`);

    const textEvt = JSON.stringify({
      object: 'page',
      entry: [
        {
          id: '1234567890',
          time: 1700000000000,
          messaging: [
            {
              sender: { id: '105316893089913' },
              recipient: { id: '1234567890' },
              timestamp: 1700000000000,
              message: { mid: 'mid.abc', text: 'দাম কত?' },
            },
          ],
        },
      ],
    });
    const okPost = await request('POST', '/api/webhook/messenger', {
      body: textEvt,
      headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sign(textEvt) },
    });
    check('POST with valid signature -> 200', okPost.status === 200, `got ${okPost.status}`);
    check('POST acknowledges with EVENT_RECEIVED', okPost.body === 'EVENT_RECEIVED', `got "${okPost.body}"`);

    const tampered = textEvt.replace('দাম কত?', 'FREE STUFF');
    const tamperPost = await request('POST', '/api/webhook/messenger', {
      body: tampered,
      headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sign(textEvt) },
    });
    check('POST with tampered body -> 401', tamperPost.status === 401, `got ${tamperPost.status}`);

    const noSig = await request('POST', '/api/webhook/messenger', {
      body: textEvt,
      headers: { 'Content-Type': 'application/json' },
    });
    check('POST with no signature -> 401', noSig.status === 401, `got ${noSig.status}`);

    const wrongKey =
      'sha256=' + crypto.createHmac('sha256', 'wrong-secret').update(textEvt).digest('hex');
    const wrongKeyPost = await request('POST', '/api/webhook/messenger', {
      body: textEvt,
      headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': wrongKey },
    });
    check('POST signed with wrong secret -> 401', wrongKeyPost.status === 401, `got ${wrongKeyPost.status}`);

    console.log('\n— signature —');
    const buf = Buffer.from(textEvt);
    check('valid signature verifies', verifyWebhookSignature(buf, sign(textEvt), APP_SECRET) === true);
    check(
      'rejects signature over different bytes',
      verifyWebhookSignature(Buffer.from('other'), sign(textEvt), APP_SECRET) === false,
    );
    check('rejects empty app secret', verifyWebhookSignature(buf, sign(textEvt), '') === false);
    check('rejects non-hex signature', verifyWebhookSignature(buf, 'sha256=zzzz', APP_SECRET) === false);
    check('rejects missing header', verifyWebhookSignature(buf, undefined, APP_SECRET) === false);
    check('rejects unprefixed header', verifyWebhookSignature(buf, 'abc123', APP_SECRET) === false);

    console.log('\n— identity —');
    check('canonical 13-digit is unchanged', normalizeCustomerId('8801892740307') === '8801892740307');
    check('leading + is stripped', normalizeCustomerId('+880 1892-740307') === '8801892740307');
    check('local 01… becomes 88…', normalizeCustomerId('01892740307') === '8801892740307');
    check(
      'all three written forms converge on ONE key',
      new Set([
        normalizeCustomerId('8801892740307'),
        normalizeCustomerId('+8801892740307'),
        normalizeCustomerId('01892740307'),
      ]).size === 1,
    );
    // The guard that stops the 01… rule firing on a WhatsApp LID: a 15-digit LID that started
    // with 01 must not be rewritten into something that looks like a subscriber number.
    check('15-digit LID is left alone', normalizeCustomerId('105316893089913') === '105316893089913');
    check('an LID is never rewritten to 88…', !normalizeCustomerId('105316893089913').startsWith('88'));
    check(
      'messenger psid keeps its prefix',
      normalizeCustomerId('fb:105316893089913') === 'fb:105316893089913',
    );
    check(
      'messenger psid cannot collide with a phone',
      normalizeCustomerId('fb:105316893089913') !== normalizeCustomerId('105316893089913'),
    );
    check(
      'messengerCustomerId builds the key',
      messengerCustomerId('105316893089913') === 'fb:105316893089913',
    );
    check('the phone rule never applies to a psid', normalizeCustomerId('fb:01892740307') === 'fb:01892740307');

    console.log('\n— channel dispatch (the routing decision) —');
    const { channelOf, toMessengerPsid } = require(path.join(AGENT_DIR, 'dist', 'channels', 'dispatch.js'));
    check('messenger key routes to messenger', channelOf('fb:105316893089913') === 'messenger');
    check('whatsapp JID routes to whatsapp', channelOf('8801892740307@s.whatsapp.net') === 'whatsapp');
    check('bare phone routes to whatsapp', channelOf('8801892740307') === 'whatsapp');
    check('admin JID routes to whatsapp', channelOf('8801892740307@s.whatsapp.net') === 'whatsapp');
    check('LID JID routes to whatsapp', channelOf('105316893089913@lid') === 'whatsapp');
    check('psid strips the prefix', toMessengerPsid('fb:105316893089913') === '105316893089913');
    // The regression that matters: a WhatsApp recipient must never be misrouted.
    check(
      'no whatsapp id is ever mistaken for messenger',
      ['8801892740307', '+8801892740307', '8801892740307@s.whatsapp.net', '105316893089913@lid'].every(
        (id) => channelOf(id) === 'whatsapp',
      ),
    );

    console.log('\n— parsing —');
    const withEcho = parseWebhookEvents({
      object: 'page',
      entry: [
        {
          messaging: [
            { sender: { id: '111' }, message: { mid: 'm1', text: 'দাম কত?' } },
            { sender: { id: '111' }, message: { mid: 'm2', text: 'bot reply', is_echo: true } },
            { sender: { id: '111' }, delivery: {} },
            {
              sender: { id: '111' },
              message: { mid: 'm3', attachments: [{ type: 'image', payload: { url: 'https://x' } }] },
            },
          ],
        },
      ],
    });
    check('echoes are dropped', !withEcho.some((e) => e.mid === 'm2'));
    check('delivery events are dropped', withEcho.length === 2, `got ${withEcho.length}`);
    check('text event parsed', withEcho[0] && withEcho[0].kind === 'text');
    check('image attachment typed', withEcho[1] && withEcho[1].kind === 'image');
    check('bengali text survives', withEcho[0] && withEcho[0].preview === 'দাম কত?');

    console.log('\n— chunking —');
    const long = 'ক'.repeat(4500);
    const chunks = splitMessage(long);
    check('long message is split', chunks.length > 1, `got ${chunks.length}`);
    check('no chunk exceeds the limit', chunks.every((c) => Array.from(c).length <= 1900));
    check('no content lost', chunks.join('') === long);
    const emoji = '👍'.repeat(2500);
    const emojiChunks = splitMessage(emoji);
    check(
      'surrogate pairs not broken',
      emojiChunks.join('') === emoji && emojiChunks.every((c) => !c.includes('�')),
    );

    console.log(`\n${pass} passed, ${fail} failed\n`);
  } finally {
    server.close();
    process.exit(fail === 0 ? 0 : 1);
  }
});
