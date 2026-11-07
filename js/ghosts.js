// The roster. Each ghost has requirements to manifest, a behaviour, a want,
// and a conversation handler. Ghosts in one hunt share a story: the same
// villain (the "culprit") hurt several of them, and they'll tell you about
// him if you ask the right ones.
import { rand } from './util.js';

export const CULPRITS = ['Crane', 'Ashby', 'Morrow', 'Vell', 'Harlow', 'Pike', 'Graves', 'Lorne'];
const DROWNED_NAMES = ['Thomas', 'Elias', 'Samuel', 'Arthur', 'Henry', 'Walter'];
const DROWNED_PLACES = ['under the mill bridge', 'beneath the reservoir ice', 'in the flooded quarry', 'at the bottom of the old well', 'in the reeds by the weir'];
const LOST_CHILDREN = ['Rose', 'June', 'Abel', 'Clara', 'Eli', 'Mae'];
const RIDDLES = [
  { q: 'I have hands but cannot hold you. A face, but cannot see you. What am I?', a: /\b(clock|watch)\b/ },
  { q: 'The more of me you take, the more you leave behind. What am I?', a: /\b(foot ?steps?|steps?)\b/ },
  { q: 'I follow you all day, and vanish in the dark. What am I?', a: /\bshadows?\b/ },
  { q: 'I fill a room but take up no space. What am I?', a: /\b(light|darkness|dark|air|sound|silence)\b/ },
  { q: 'The one who makes me sells me. The one who buys me never uses me. The one who uses me never knows. What am I?', a: /\b(coffin|casket|grave)\b/ },
  { q: 'I am always coming, but I never arrive. What am I?', a: /\btomorrow\b/ },
];

export function newLore(r = rand) {
  return {
    culprit: r.pick(CULPRITS),
    drownedName: r.pick(DROWNED_NAMES),
    drownedPlace: r.pick(DROWNED_PLACES),
    lostChild: r.pick(LOST_CHILDREN),
    userName: null,
    clues: new Set(),
  };
}

// ---------------------------------------------------------------------------
// Intent recognition: crude, but spoken input is crude too.
const INTENTS = [
  ['myName', /\b(?:my name(?:'s| is)|i am called|i'm called|call me)\s+([a-z][a-z'-]+)/],
  ['dontKnow', /\b(i don'?t know|no idea|not sure|who knows)\b/],
  ['askWho', /\bwho (?:hurt|locked|did|killed|drowned|took|shut|was it)|\bwho did (?:this|it)|\bwhose fault\b/],
  ['askName', /\bwho are you\b|\bwhat(?:'s| is) your name\b|\byour name\b|\bwho is this\b/],
  ['askWant', /\bwhat do you (?:want|need)\b|\bwhy are you here\b|\bwhat(?:'s| is) wrong\b|\bhelp you\b|\bcan i help\b|\bhow can i\b/],
  ['askDeath', /\bhow did you die\b|\bwhat happened\b|\bhow did it happen\b|\bare you dead\b|\bdid you die\b/],
  ['promise', /\bi (?:promise|swear)\b|\bi(?:'ll| will) (?:tell|find|remember|let them know)\b/],
  ['sorry', /\bsorry\b|\bapologi|\bcondolence|\bit(?:'?s| is)(?: going to be| gonna be| will be)? (?:ok|okay|alright|all right|fine)\b|\bshh+\b|\bhush\b|\bthere,? there\b|\bdon'?t cry\b/],
  ['comfort', /\bi'?m here\b|\bnot alone\b|\byou(?:'re| are) safe\b|\bi(?:'ll| will) stay\b|\byour friend\b|\bi care\b|\bit'?s over\b/],
  ['bye', /\bgoodbye\b|\bbye\b|\bfarewell\b|\brest in peace\b|\bbe at peace\b|\bmove on\b|\bgo to the light\b|\brest now\b/],
  ['threat', /\bgo away\b|\bget out\b|\bbegone\b|\bbe gone\b|\bshut up\b|\bleave me\b|\bin the name of\b|\bi(?:'ll| will) (?:kill|destroy|banish)\b|\bdemon\b/],
  ['insult', /\bugly\b|\bstupid\b|\bfreak\b|\bmonster\b|\bnot real\b|\bfake\b|\bhate you\b|\bidiot\b/],
  ['play', /\bplay\b|\bhide and seek\b|\bgame\b/],
  ['no', /^(?:no|nope|nah|never)\b|\bno thanks\b|\bi won'?t\b|\bdon'?t want\b|\bnot now\b/],
  ['yes', /^(?:yes|yeah|yep|sure|ok|okay|alright|of course|fine)\b|\blet'?s\b|\bi will\b|\bi'?d love\b/],
  ['greet', /\bhello\b|\bhi\b|\bhey\b|\bgreetings\b|\banyone (?:here|there)\b|\banybody\b|\bwho'?s there\b|\bis someone\b/],
];

export function classify(text) {
  const t = ` ${text.toLowerCase().replace(/[^a-z' ]/g, ' ').replace(/\s+/g, ' ').trim()} `.trim();
  const found = [];
  let name = null;
  for (const [id, re] of INTENTS) {
    const m = t.match(re);
    if (m) {
      found.push(id);
      if (id === 'myName') name = m[1];
    }
  }
  return { text: t, intents: found, has: (id) => found.includes(id), name };
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const mentionsCulprit = (c, lore) => c.text.includes(lore.culprit.toLowerCase());
const mentionsWrongCulprit = (c, lore) => CULPRITS.some((n) => n !== lore.culprit && c.text.includes(n.toLowerCase()));

// ---------------------------------------------------------------------------
// Definitions.
// requires: dark (room lights out, or only a flashlight), sound (audio on),
// headphones (verified headphones).
// behavior: drift | emerge | peripheral | faced | weeper | stalker
export const GHOSTS = {
  lantern: {
    id: 'lantern',
    name: 'The Pale Lantern',
    epithet: 'a lost, flickering light',
    threat: 0,
    points: 40,
    weight: [30, 14],
    requires: {},
    behavior: 'drift',
    want: 'company',
    wantText: 'Wants company. Be kind and stay a while.',
    lore: 'Most of the dead are not monsters. Some are just tired lights that forgot the way home. They drift toward the warmth of the living.',
    voice: { pitch: 1.6, rate: 0.85, volume: 0.8 },
    hue: 190,
    hints: ['A faint glow flickers {dir}.', 'Warm air drifts {dir}, the wrong kind of warm.', 'A soft chime rings {dir}.'],
    sounds: ['chime'],
    talk(g, c, lore) {
      const m = g.mem;
      if (c.has('threat') || c.has('insult')) return { say: '...oh. I am sorry I bothered you.', trust: -1, relocate: true };
      if (c.has('askWho')) { lore.clues.add('culprit'); return { say: `The tall one in the dark... he waits for a man named ${lore.culprit}.` }; }
      if (c.has('askName')) return { say: "I don't remember my name. Only the light. Only the cold." };
      if (c.has('askWant')) return { say: 'Just... stay. A little while. It is so cold out here.' };
      if (c.has('askDeath')) return { say: 'I walked into the fog, and the fog never ended.' };
      if (c.has('comfort') || c.has('sorry') || c.has('yes') || c.has('greet') || c.has('promise')) {
        m.trust = (m.trust || 0) + 1;
        if (m.trust >= 2) return { say: 'I think... I can see the way now. Thank you, warm one.', resolve: 'peace', film: 1 };
        return { say: c.has('greet') ? 'Oh... you can see me? Hello, warm one.' : 'That is kind. No one is kind anymore.' };
      }
      if (c.has('bye')) return { say: 'Wait... not yet... stay...' };
      return { say: rand.pick(['The lights here used to be so bright.', 'Do you hear her crying too? She never stops.', 'Be careful of the low places. Something crawls there.']) };
    },
  },

  wren: {
    id: 'wren',
    name: 'Little Wren',
    epithet: 'the lonely child',
    threat: 2,
    points: 70,
    weight: [18, 13],
    requires: { sound: true },
    behavior: 'drift',
    want: 'play',
    wantText: 'Wants a friend to play hide and seek. Never tell her no.',
    lore: 'You hear her humming before you see her. A little girl in a nightgown who has been waiting a very long time for someone to play with. She does not like being refused.',
    voice: { pitch: 1.9, rate: 0.82, volume: 0.9 },
    hue: 210,
    hints: ['A child is humming {dir}.', 'Small footsteps patter {dir}.', 'A giggle, {dir}. Then nothing.'],
    blockedHint: 'You feel a tune in your teeth, {dir}. She only comes if you can hear her — turn your sound on.',
    sounds: ['hum', 'giggle'],
    talk(g, c, lore) {
      const m = g.mem;
      if (m.hiding) return { say: "No peeking! You have to FIND me." };
      if (c.has('askWho')) { lore.clues.add('culprit'); return { say: `Mister ${lore.culprit}. He locks the doors. He locked me in the cellar. He locked the tall man too.` }; }
      if (c.has('askName')) return { say: 'Wren. Mama called me her little Wren.' };
      if (c.has('askDeath')) return { say: 'I was hiding in the cellar, and the door went click. I waited and waited and waited and waited and waited.' };
      if (m.asked && (c.has('yes') || c.has('play'))) {
        m.hiding = true; m.asked = false;
        return { say: 'Hide and seek! Close your eyes and count to ten. Then come find me. No peeking...', hide: true };
      }
      if (m.asked && c.has('no')) {
        m.refusals = (m.refusals || 0) + 1;
        m.asked = false;
        if (m.refusals >= 2) return { say: 'THEN YOU CAN STAY DOWN HERE WITH ME. FOREVER.', attack: true };
        return { say: '...nobody ever wants to play with me.', agitation: 35 };
      }
      if (c.has('threat') || c.has('insult')) return { say: "That's not nice. Mama says not nice people go in the cellar.", agitation: 40 };
      if (c.has('askWant') || c.has('greet') || c.has('play') || c.has('comfort')) {
        m.asked = true;
        return { say: c.has('greet') ? 'Hi! Did you come to play with me?' : 'Will you play with me? Please? Hide and seek?' };
      }
      m.asked = true;
      return { say: rand.pick(['Do you want to play?', 'Are you going to be my friend?', 'Want to play a game?']) };
    },
  },

  weeper: {
    id: 'weeper',
    name: 'The Weeping Widow',
    epithet: 'grief that never ends',
    threat: 5,
    points: 160,
    weight: [5, 12],
    requires: { dark: true },
    behavior: 'weeper',
    want: 'grief',
    wantText: 'Grieving a lost child. Do NOT shine light on her. Whisper comfort. Never shout.',
    lore: 'She crouches in the dark with her face in her hands and she sobs. She has been sobbing for a hundred years. Light startles her. Noise startles her. You do not want to startle her.',
    voice: { pitch: 0.75, rate: 0.6, volume: 0.7 },
    hue: 0,
    hints: ['Muffled sobbing, {dir}.', 'Someone is crying {dir}. Keep your light down.', 'A wet, broken breath {dir}.'],
    blockedHint: 'Faint sobbing {dir}... she will not show herself in the light. Turn the lights out.',
    sounds: ['sob'],
    talk(g, c, lore, ctx) {
      const m = g.mem;
      if (ctx.loud) return { say: '*the sobbing stops*', agitation: 55 };
      if (c.has('threat') || c.has('insult')) return { say: 'GET. OUT.', attack: true };
      if (c.has('sorry') || c.has('comfort')) {
        m.trust = (m.trust || 0) + 1;
        if (m.trust === 1) return { say: `...he took her... my ${lore.lostChild}... my little ${lore.lostChild}...`, agitation: -25 };
        if (m.trust === 2) { lore.clues.add('culprit'); return { say: `${lore.culprit}... ${lore.culprit} took her down into the cellar and she never... came... back... up...`, agitation: -25 }; }
        return { say: `${lore.lostChild}? ...I hear her. I hear her calling me. I'm coming, darling...`, resolve: 'peace', film: 1 };
      }
      if (c.has('askWho') && (m.trust || 0) >= 1) { lore.clues.add('culprit'); return { say: `${lore.culprit}...`, agitation: 5 }; }
      if (c.has('greet')) return { say: '*sob*... go... away...', agitation: 12 };
      return { say: '*sobbing*', agitation: 10 };
    },
  },

  hollow: {
    id: 'hollow',
    name: 'The Hollow Man',
    epithet: 'he wants a name',
    threat: 4,
    points: 140,
    weight: [7, 12],
    requires: { dark: true },
    behavior: 'drift',
    want: 'revenge',
    wantText: 'Wants revenge on whoever locked him in the cellar. Learn the culprit\'s name from the others. Do not guess.',
    lore: 'Far too tall, far too thin, standing perfectly still where the shadows are thickest. He starved behind a locked door. He has not forgotten, and he has not forgiven.',
    voice: { pitch: 0.1, rate: 0.55, volume: 1 },
    hue: 260,
    hints: ['The dark feels deeper {dir}.', 'Something very tall is standing {dir}.', 'Slow, heavy breathing {dir}.'],
    blockedHint: 'Something very tall waits {dir}, but only in the dark. Lights off.',
    sounds: ['groan'],
    talk(g, c, lore) {
      if (mentionsCulprit(c, lore)) {
        return { say: `${lore.culprit}. Yes. YES. I remember the smell of him now. ...I will pay him a visit.`, resolve: 'revenge', film: 1 };
      }
      if (mentionsWrongCulprit(c, lore) || c.name) return { say: 'LIAR.', agitation: 50 };
      if (c.has('dontKnow') || c.has('askWho')) return { say: 'Then find out. Ask the others. The child saw everything.', agitation: 8 };
      if (c.has('askWant')) return { say: 'The one who shut the cellar door. Give me his name, and I will leave you be.' };
      if (c.has('askName')) return { say: 'I had a name. It rotted with me.' };
      if (c.has('askDeath')) return { say: 'Nine days in the dark. I clawed at the door until I had no fingers left to claw with.' };
      if (c.has('sorry') || c.has('comfort')) return { say: 'Your pity is worthless to me.' };
      if (c.has('threat') || c.has('insult')) return { say: 'You first, then.', agitation: 40 };
      if (c.has('bye')) return { say: 'You will leave when I say.', agitation: 15 };
      return { say: rand.pick(['A name.', 'Tell me his name.', 'You. Living thing. Give me a name.']) };
    },
  },

  whisperer: {
    id: 'whisperer',
    name: 'The Whisperer',
    epithet: 'it collects names',
    threat: 3,
    points: 130,
    weight: [9, 10],
    requires: { sound: true, headphones: true },
    behavior: 'faced',
    want: 'name',
    wantText: 'Invisible until you face it exactly. Follow its whispers with headphones. It wants your name, and pays in secrets.',
    lore: 'You will never see it unless you are looking straight at it. You find it by sound alone — whispering in your left ear, then your right, then right behind you. It collects names.',
    voice: { pitch: 0.4, rate: 0.7, volume: 0.6 },
    hue: 120,
    hints: ['Whispering, {dir}.', 'Something breathes against your ear, {dir}.', 'It says your name, {dir}. Or something like it.'],
    blockedHint: 'Something is whispering {dir}, too faint for a speaker. Put on headphones.',
    sounds: ['whisper'],
    talk(g, c, lore) {
      const m = g.mem;
      if (c.name) {
        const n = cap(c.name);
        lore.userName = n;
        lore.clues.add('culprit');
        return { say: `${n}. ${n}. ${n}... we will remember you, ${n}. A secret, for a name: the tall one hungers for ${lore.culprit}.`, resolve: 'bargain', reveal: true };
      }
      if (c.has('no')) {
        m.refusals = (m.refusals || 0) + 1;
        if (m.refusals >= 2) return { say: 'Then we will TAKE it.', attack: true };
        return { say: 'Such a small thing... a name... give it...', agitation: 30 };
      }
      if (c.has('threat') || c.has('insult')) return { say: 'shhhhhhhhhhhhhhhh', attack: true };
      if (c.has('askWant') || c.has('greet') || c.has('askName')) return { say: 'Closer... closer... tell us your name...' };
      return { say: rand.pick(['your name... your name...', 'we can hear your heart', 'say it... say your name...']) };
    },
  },

  drowned: {
    id: 'drowned',
    name: 'The Drowned',
    epithet: 'he wants to be found',
    threat: 3,
    points: 120,
    weight: [9, 10],
    requires: { dark: true },
    behavior: 'emerge',
    emergeFrom: ['sink', 'toilet', 'bottle', 'cup', 'bowl', 'wine glass', 'vase', 'refrigerator', 'potted plant'],
    want: 'remembered',
    wantText: 'Seeps out of anything that holds water. Ask where he is, then promise to tell his mother.',
    lore: 'Water collects where he has been. He seeps up out of sinks and bottles and cups, bloated and grey, and he is so, so cold. Nobody ever found him.',
    voice: { pitch: 0.35, rate: 0.55, volume: 0.9 },
    hue: 175,
    hints: ['Dripping, {dir}.', 'You smell stagnant water {dir}.', 'A wet gurgle, {dir}.'],
    blockedHint: 'Water drips {dir}. He waits for the dark.',
    sounds: ['drip', 'gurgle'],
    talk(g, c, lore) {
      const m = g.mem;
      if (c.text.includes(lore.drownedName.toLowerCase())) { m.trust = (m.trust || 0) + 1; return { say: 'You... remember me... ' + lore.drownedName + '...', agitation: -15 }; }
      if (c.has('promise')) {
        if (m.toldPlace) return { say: '...tell her... tell her I am sorry I was late home... ...warm... finally... warm...', resolve: 'peace', film: 1 };
        return { say: 'Promise what? You don\'t even know where I am...' };
      }
      if (c.has('askName')) return { say: `${lore.drownedName}... my name was ${lore.drownedName}...` };
      if (c.has('askWho')) { lore.clues.add('culprit'); return { say: `${lore.culprit}... held me under... until the bubbles stopped...` }; }
      if (c.has('askDeath') || c.has('askWant') || c.has('greet')) {
        m.toldPlace = true;
        return { say: `I'm ${lore.drownedPlace}. Nobody looked. Tell my mother where I am. Promise me.` };
      }
      if (c.has('threat') || c.has('insult')) return { say: '*water pours from his mouth*', agitation: 35 };
      return { say: rand.pick(['*gurgle* ...cold... so cold...', '...can\'t breathe... can\'t...', '*water pours from his mouth*']) };
    },
  },

  crawler: {
    id: 'crawler',
    name: 'The Crawler',
    epithet: 'do not look away',
    threat: 5,
    points: 200,
    weight: [3, 10],
    requires: { dark: true },
    behavior: 'stalker',
    emergeFrom: ['couch', 'bed', 'chair', 'bench', 'dining table', 'toilet', 'suitcase'],
    want: 'hunger',
    wantText: 'Comes out from under furniture. It only moves when you are not looking. Hold your flashlight on it to drive it off. Do not talk — it finds you by your voice.',
    lore: 'It lives in the space under beds and couches. Its arms bend the wrong way. It only moves when you are not looking at it — and every time you look back, it is closer.',
    voice: { pitch: 0.05, rate: 1.3, volume: 1 },
    hue: 340,
    hints: ['Skittering, {dir}.', 'Something knocks under the furniture {dir}.', 'Clicking, like knuckles, {dir}. Closer.'],
    blockedHint: 'Something scratches under the furniture {dir}... it waits for the dark.',
    sounds: ['skitter'],
    talk(g, c) {
      g.approach = Math.min(1, (g.approach || 0) + 0.2);
      return { say: rand.pick(['*clicking*', 'hhhhhhungry', 'more... talk more... I can find you by your voice', '*it giggles with your voice*']), agitation: 20 };
    },
  },

  mimic: {
    id: 'mimic',
    name: 'The Mimic',
    epithet: 'it wants your voice',
    threat: 4,
    points: 150,
    weight: [7, 9],
    requires: { sound: true },
    behavior: 'drift',
    want: 'voice',
    wantText: 'Feeds on your voice and plays it back. Stay completely silent and it will starve.',
    lore: 'It has no voice of its own, so it wears yours. Whatever you say, it says back — wrong, backwards, from just behind you. The more you talk, the more it looks like you.',
    voice: { pitch: 1.0, rate: 0.85, volume: 0.9 },
    hue: 30,
    hints: ['Someone repeats a word you said, {dir}.', 'Your own voice, {dir}.', 'Something laughs your laugh, {dir}.'],
    blockedHint: 'Something {dir} is trying to say something. You can\'t hear it with the sound off.',
    sounds: ['echo'],
    talk(g, c) {
      const words = c.text.split(' ').filter(Boolean);
      const echo = words.length ? words.slice(-3).join(' ') : 'hello';
      return { say: `${echo}... ${echo}... ${echo.split('').reverse().join('')}...`, agitation: 25, echo: true };
    },
  },

  grinner: {
    id: 'grinner',
    name: 'The Grinning Man',
    epithet: 'only in the corner of your eye',
    threat: 3,
    points: 150,
    weight: [6, 8],
    requires: {},
    behavior: 'peripheral',
    want: 'riddle',
    wantText: 'Only visible at the edge of the lens; looking straight at him makes him vanish. Asks riddles. Right answers earn film, wrong ones cost it.',
    lore: 'A man in an old suit with a smile far too wide for his face. You only ever see him from the corner of your eye. He loves games, and he cheats.',
    voice: { pitch: 0.7, rate: 0.78, volume: 0.9 },
    hue: 50,
    hints: ['Someone is giggling {dir}.', 'In the corner of your eye, {dir}, something smiles.', 'A soft, delighted laugh {dir}.'],
    sounds: ['giggle'],
    talk(g, c) {
      const m = g.mem;
      if (m.riddle) {
        const r = m.riddle;
        m.riddle = null;
        if (r.a.test(c.text)) return { say: 'Clever, clever, CLEVER. Take a gift. Hee hee hee.', resolve: 'gift', film: 1 };
        return { say: 'Wrong! I\'ll take one of your pictures for that. Hee hee.', film: -1, agitation: 20 };
      }
      if (c.has('threat') || c.has('insult')) return { say: 'Oh, I like you. I like you very much.', agitation: 25 };
      m.riddle = rand.pick(RIDDLES);
      const intro = c.has('greet') ? 'Don\'t look right at me. It\'s rude. ' : c.has('askWant') ? 'A game! A riddle! Answer true and I gift you. Answer false and I take. ' : '';
      return { say: intro + m.riddle.q };
    },
  },
};

export const GHOST_LIST = Object.values(GHOSTS);

export function pickGhostType(r, night) {
  const total = GHOST_LIST.reduce((s, g) => s + g.weight[night ? 1 : 0], 0);
  let x = r() * total;
  for (const g of GHOST_LIST) {
    x -= g.weight[night ? 1 : 0];
    if (x <= 0) return g.id;
  }
  return 'lantern';
}

export const REQ_LABELS = {
  dark: { icon: '◐', label: 'Darkness' },
  sound: { icon: '♪', label: 'Sound on' },
  headphones: { icon: '🎧', label: 'Headphones' },
};

// Direction words, deliberately a little vague.
export function dirPhrase(rel, el) {
  const a = Math.abs(rel);
  const side = rel < 0 ? 'left' : 'right';
  let p;
  if (a < 20) p = 'right in front of you';
  else if (a < 60) p = `slightly to your ${side}`;
  else if (a < 115) p = `to your ${side}`;
  else if (a < 160) p = `behind you, to the ${side}`;
  else p = 'directly behind you';
  if (el < -15) p += ', low, near the floor';
  else if (el > 22) p += ', up high';
  return p;
}

export const OUTCOME_TEXT = {
  peace: 'Laid to rest',
  revenge: 'Unleashed for revenge',
  bargain: 'Bargained with',
  gift: 'Outwitted',
  starved: 'Starved of your voice',
  repelled: 'Driven off with light',
  attacked: 'Attacked you',
  fled: 'Slipped away',
};
