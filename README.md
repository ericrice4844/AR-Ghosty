# AR-Ghosty

An augmented-reality ghost hunting game for phones. Point your camera around the room, follow the whispers and cold spots, photograph what shows itself, and talk to the dead. Some of them just want company. Some of them want revenge.

It's a plain web app (HTML + ES modules, no build step) that runs in a mobile browser and installs as a PWA.

> **Content warning:** jumpscares, sudden loud sounds, flashing images, vibration, and disturbing imagery and voices. You can turn jumpscares off in Settings.

## How to play

1. **Begin a hunt** → allow motion, test your sound, optionally test headphones and allow location.
2. **Look around slowly.** Hints appear on screen ("Muffled sobbing, behind you, to the left"). The **EMF meter** climbs when you face a presence, cold **mist** creeps in from the side it's on, and every ghost's sounds are placed in 3D, so headphones help a lot.
3. **Hold still on a presence** and it shows itself. **Tap anywhere to take a photo.** You only get a few exposures per hunt (6 by default). Photos score higher when the ghost is close, centred, enraged, or one you've never photographed before. Sometimes something turns up in a photo that wasn't visible on screen.
4. **Hold the 🎙 button to speak** (or ⌨ to type). Ask them who they are, what they want, what happened. Each ghost wants something. Give it what it wants and you'll be rewarded, often with extra film.
5. Your **nerve** drops when something attacks you or when dangerous things stay close. When it runs out, you flee and the hunt ends.

The ghosts in a hunt share a story. More than one of them was hurt by the same man, and some will tell you his name if you ask the right one the right way. Somebody else is very interested in that name.

### Conditions

| Icon | Condition | How |
|---|---|---|
| ◐ | **Darkness** | Lights off, or only your flashlight on. Tap the icon in a hunt to calibrate it for your room. |
| ♪ | **Sound** | Sound on and volume up. Some ghosts only appear if they can be heard. |
| 🎧 | **Headphones** | Confirmed with the left/right knock test. Some whispers are too quiet for a speaker. |

### The dead

Each one has its own death, and its own idea of what you owe it.

| Ghost | Origin | Needs | Behaviour | Wants |
|---|---|---|---|---|
| The Pale Lantern | Edith Marsh, 1887. Followed the marsh lights into the bog looking for her father. | — | Drifting light that hovers over furniture | Company. Be kind. |
| Little Wren | Wren Callow, 1918. Locked in the nursery with scarlet fever; knocked for nine days. | Sound | Hums a lullaby, plays hide and seek | A friend. Never say no to her twice. |
| The Weeping Widow | Honora Vane, 1894. Her baby died in the cradle while she slept. She never slept again. | Dark | Crouches beside beds and couches, sobbing. Light, the flash and loud voices enrage her | Grief. Whisper comfort. |
| The Hollow Man | Abel Ostrander, 1902. A debt collector bricked into a coal cellar by the man who owed him. | Dark | Impossibly tall; stands behind furniture, or behind people | **Revenge.** The others saw who laid the bricks. Give him the right name. |
| The Whisperer | Madame Sorrel, a 1920s séance fraud, until something real answered and came through her. | Sound + headphones | Invisible unless you face it exactly; circles you whispering | Your name. It trades secrets for names. |
| The Drowned | Winter 1951: went through the reservoir ice after his dog. The ice closed over him like a lid. | Dark | Seeps up out of sinks, cups, bottles and plants | To be found. Promise to tell his mother. |
| The Crawler | "The Boneless Boy", a carnival contortionist kept in a crate. Nobody let him out when the carnival burned. | Dark | Comes out from under couches, beds and chairs; only moves when you're not looking. Hold your light on it. | Hunger. Don't talk. |
| The Mimic | Never a person: something that lived in the static of an old party-line telephone exchange. | Sound | Plays your own recorded voice back at you, reversed | Your voice. Starve it with silence. |
| The Grinning Man | Dr. Lucius Penhallow, 1911. Drank his own strychnine-laced Joy Elixir; the poison locked his face in a grin. | — | Peeks out from behind things, only at the edge of the lens | Riddles. Answer right for film, wrong and lose some. |

Ghosts place themselves against what the camera sees: object detection finds beds, couches, chairs, tables, fridges and people, and each ghost stands beside, behind (with the furniture hiding its legs) or peeking around them, scaled to the object's real size and standing on the floor. With nothing recognisable in view, they stand in the darkest part of the room at a believable distance.

**Spirit radar** uses your GPS to show haunts within ~450 m. They're tied to the real map and shuffle every 3 hours, so people standing in the same place at the same time see the same ghosts. Get within ~70 m and a haunt joins your next hunt from its real compass direction. Play somewhere safe, and only go where you're allowed to be.

## Running it

Camera, motion and microphone access require **HTTPS** (or `localhost`).

- **GitHub Pages:** enable Pages for this repo (Settings → Pages → deploy from branch, root). Open the URL on your phone. Use "Add to Home Screen" for fullscreen.
- **Local (desktop):** `python3 -m http.server 8000` and open `http://localhost:8000`. With no motion sensors, drag the screen or use the arrow keys to look around. Space takes a photo.
- **Local (phone):** serve over HTTPS, e.g. `npx http-server -S` with a self-signed cert, or tunnel `localhost` with a tool like `cloudflared`/`ngrok`.

### Browser support notes

- **Flashlight control** works on Android Chrome. Where the torch can't be controlled (iOS), the 🔦 button switches on an in-app "lantern lens" instead. You can still use your phone's own flashlight from Control Center for darkness.
- **Speech recognition** works in Chrome (Android/desktop) and Safari. Elsewhere the ⌨ button lets you type.
- **iOS** asks for motion permission when you tap *Allow* / *Enter*.
- **Object detection** for ghosts emerging from objects uses TensorFlow.js COCO-SSD, loaded on demand from jsDelivr. Offline or on slow devices it falls back to the darkest shadow in the frame.
- **Headphone detection**: browsers can't reliably say whether headphones are plugged in, so the game uses a left/right knock test (device labels are used as a hint where available).

### Debug

Add `?debug` to the URL for an overlay showing ghost state, and keys **d** (force darkness), **h** (toggle headphones), **s** (trigger an attack). `?debug&ghosts=crawler,weeper` forces a specific line-up.

## How it's built

```
index.html, styles.css     screens and HUD
js/main.js                 app shell: preparation wizard, radar, journal, evidence, settings
js/hunt.js                 the hunt: spawning, conditions, behaviours, hints, photos, talking, attacks
js/ghosts.js               the roster, requirements, wants and dialogue (intent matching)
js/render.js               procedural canvas art for every ghost, glitch/grain/vignette FX, jumpscares
js/audio.js                Web Audio synthesis (sobbing, humming, whispers, skittering, shrieks) with HRTF 3D panning
js/sensors.js              camera, torch, light meter, device orientation/compass, GPS, headphone hints
js/voice.js                microphone level, speech recognition, voice recording (for the Mimic), ghost speech
js/detect.js               object detection for emerging ghosts, with a shadow fallback
js/world.js                deterministic GPS haunts, view/projection math
js/storage.js              photos in IndexedDB, settings and journal in localStorage
sw.js                      offline cache
```

No images or audio files are used. Every ghost is drawn procedurally and every sound is synthesized live. Photos stay on your device.
