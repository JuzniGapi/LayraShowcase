/* Regenerates the demo-call recordings for design/glas2.html.
 *
 *   node design/assets/audio/gen-voices.mjs        (from the repo root)
 *
 * Writes demo-<id>.mp3 next to this file — one per voice — and prints the cue
 * table to paste into the VOICES registry in glas2.html. Needs SONIOX_API_KEY
 * in .env and ffmpeg on PATH.
 *
 * The same five-line conversation every time. The caller's two lines are
 * synthesised once and reused, so only Layra's voice changes between files;
 * that is what makes the four recordings comparable.
 *
 * Two things about `say` vs `text`. Slovene reads clock times out loud ("ob
 * dveh"), not as digits, and the brand's English spelling makes every voice
 * read the name as English — Soniox's Nina went as far as "Ja sam Lejra",
 * which is Serbo-Croatian. Spelled "Lajra" they all say it the Slovene way.
 * The transcript on the page keeps the real spelling and the digits.
 */

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const SR = 24000;                 // 24 kHz mono: clearer than the 16 kHz phone path
const SPEED = 1.05;               // same as CONF.SPEED, so it sounds like the product
const MODEL = 'tts-rt-v1';
const LANG = 'sl';
const BITRATE = '48k';

const API_KEY = readFileSync(join(HERE, '../../../.env'), 'utf8')
  .match(/^SONIOX_API_KEY=(.+)$/m)?.[1].trim();
if (!API_KEY) throw new Error('SONIOX_API_KEY missing from .env');

const LINES = [
  {
    who: 'layra',
    text: 'Jaz sem Layra. Oglasim se, ko se vi ne morete.',
    say: 'Jaz sem Lajra. Oglasim se, ko se vi ne morete.',
  },
  {
    who: 'caller',
    text: 'Dober dan … a imate jutri kaj prostega za striženje?',
    say: 'Dober dan, a imate jutri kaj prostega za striženje?',
  },
  {
    who: 'layra',
    text: 'Dober dan! Seveda — jutri je prosto ob 14.00 in ob 16.30. Kaj vam bolj ustreza?',
    say: 'Dober dan! Seveda, jutri je prosto ob dveh popoldne in ob pol petih. Kaj vam bolj ustreza?',
  },
  {
    who: 'caller',
    text: 'Ob dveh, prosim. Ana Kovač.',
  },
  {
    who: 'layra',
    text: 'Zapisala sem vas: jutri ob 14.00, striženje. Termin je rezerviran. Se vidimo!',
    say: 'Zapisala sem vas: jutri ob dveh, striženje. Termin je rezerviran. Se vidimo!',
  },
];

const CALLER_VOICE = 'Sofia';     // the customer — one person across all four files

/* Slovene name → Soniox voice. Nina is also the VOICE= default in .env. */
const LAYRA_VOICES = [
  { id: 'nina',  soniox: 'Nina'   },
  { id: 'maja',  soniox: 'Maya'   },
  { id: 'klara', soniox: 'Claire' },
  { id: 'jaka',  soniox: 'Jack'   },
];

/* pauses that make it sound like a call rather than a queue of clips */
const LEAD_IN = 0.30;
const GAP_AFTER = { layra: 0.55, caller: 0.40 };
const TAIL = 0.70;

/** One Soniox TTS stream per line, in order, over a single socket. */
function synth(voice, texts) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('wss://tts-rt.soniox.com/tts-websocket');
    const out = [];
    let i = 0;
    let chunks = [];

    const start = () => {
      const id = `line-${i}`;
      ws.send(JSON.stringify({
        api_key: API_KEY,
        stream_id: id,
        model: MODEL,
        language: LANG,
        voice,
        audio_format: 'pcm_s16le',
        sample_rate: SR,
        speed: SPEED,
      }));
      ws.send(JSON.stringify({ text: texts[i] + ' ', text_end: false, stream_id: id }));
      ws.send(JSON.stringify({ text: '', text_end: true, stream_id: id }));
    };

    ws.onopen = () => start();

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data.toString()); } catch { return; }

      if (msg.error_code) {
        ws.close();
        reject(new Error(`${voice}: ${msg.error_code} ${msg.error_message}`));
        return;
      }
      if (msg.audio) chunks.push(Buffer.from(msg.audio, 'base64'));
      if (msg.terminated) {
        out.push(Buffer.concat(chunks));
        chunks = [];
        process.stdout.write(`  ${voice} ${i + 1}/${texts.length}\n`);
        if (++i < texts.length) start();
        else { ws.close(); resolve(out); }
      }
    };

    ws.onerror = (e) => reject(new Error(`${voice}: socket ${e.message || 'error'}`));
  });
}

const silence = (sec) => Buffer.alloc(Math.round(sec * SR) * 2);
const seconds = (buf) => buf.length / 2 / SR;

function wav(pcm) {
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);            // PCM
  head.writeUInt16LE(1, 22);            // mono
  head.writeUInt32LE(SR, 24);
  head.writeUInt32LE(SR * 2, 28);       // byte rate
  head.writeUInt16LE(2, 32);            // block align
  head.writeUInt16LE(16, 34);           // bits
  head.write('data', 36);
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

const callerPcm = await synth(CALLER_VOICE, LINES.filter((l) => l.who === 'caller').map((l) => l.say ?? l.text));
const layraTexts = LINES.filter((l) => l.who === 'layra').map((l) => l.say ?? l.text);

const registry = [];

for (const v of LAYRA_VOICES) {
  const layraPcm = await synth(v.soniox, layraTexts);

  const parts = [silence(LEAD_IN)];
  const cues = [];
  let t = LEAD_IN;
  let li = 0, ci = 0;

  for (const line of LINES) {
    const pcm = line.who === 'layra' ? layraPcm[li++] : callerPcm[ci++];
    cues.push(t.toFixed(2));
    parts.push(pcm, silence(GAP_AFTER[line.who]));
    t += seconds(pcm) + GAP_AFTER[line.who];
  }
  parts.push(silence(TAIL));
  t += TAIL;

  const tmp = join(HERE, `demo-${v.id}.wav`);
  const mp3 = join(HERE, `demo-${v.id}.mp3`);
  writeFileSync(tmp, wav(Buffer.concat(parts)));
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', tmp,
    '-codec:a', 'libmp3lame', '-b:a', BITRATE, '-ac', '1', '-ar', String(SR), mp3]);
  unlinkSync(tmp);

  console.log(`  → demo-${v.id}.mp3  ${t.toFixed(1)}s`);
  registry.push(`  { id: '${v.id}',${' '.repeat(6 - v.id.length)} name: '${v.id[0].toUpperCase() + v.id.slice(1)}',`
    + `${' '.repeat(6 - v.id.length)} soniox: '${v.soniox}',${' '.repeat(7 - v.soniox.length)} cues: [${cues.join(', ')}] },`);
}

console.log('\nPaste into the VOICES registry in glas2.html:\n');
console.log('const VOICES = [\n' + registry.join('\n') + '\n];');
