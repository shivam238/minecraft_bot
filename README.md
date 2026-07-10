# Lite AFK Bot

Ek bahut halka (lightweight) Minecraft bot — `mineflayer` ke upar bana hua.
Sirf 2 dependencies hain (`mineflayer`, `dotenv`), koi pathfinding/AI/farming library nahi — isliye RAM/CPU bahut kam use hota hai.

## Kya karta hai
- Server se connect hota hai
- Har 8–20 second mein random jump/turn/walk karta hai (perfectly still nahi khada rehta)
- Disconnect/kick hone par 10 second baad khud reconnect karta hai
- Ek chhota web server (`/`) bhi chalata hai jise UptimeRobot jaisi free service ping kar sake

## Setup (Pterodactyl-style panel — 128 MiB RAM / 25% CPU jaisa)
1. `bot.js` file kholo aur upar wale Config section mein apni values daalo:
   - `HOST` → tumhara server address
   - `PORT` → server port
   - `USERNAME` → bot ka in-game naam
2. Files (`bot.js`, `package.json`) panel pe upload karo
3. Startup command: `npm install && npm start`
   (`package.json` ka `start` script already `--max-old-space-size=96` ke saath hai, taaki Node heap 128 MiB limit ke andar rahe)
4. Container ko "Start" karo — bot khud connect ho jayega aur crash/disconnect hone par khud restart/reconnect karega

Is setup mein koi background web server nahi hai (uski zaroorat nahi thi), isliye Memory/CPU usage bahut kam rehta hai — normally kuch MB RAM aur near-zero CPU jab bot idle khada AFK actions kar raha ho.

## Disk space fix (important)
`mineflayer` apne aap `minecraft-data` naam ka package laata hai jisme Bedrock edition ka pura data bundled hota hai (~280 MB) — jo ek Java-edition AFK bot ko kabhi chahiye hi nahi. Isi wajah se pehle `node_modules` ~410 MB ka ban raha tha aur 250 MiB disk limit cross ho raha tha.

Fix: `npm install` ke baad ek `postinstall` script (`scripts/prune-minecraft-data.js`) automatically Bedrock ka unused data delete kar deta hai. Isse `node_modules` ~130 MB tak aa jata hai — 250 MiB limit ke andar comfortably.
Ye khud-ba-khud chalta hai, koi manual step nahi — bas `npm install` karo.

## ⚠️ Zaroori baat
Aternos (aur zyadatar free Minecraft hosts) ka **Terms of Service AFK bots ko allow nahi karta** —
unka system detect karta hai ki player real hai ya bot, aur repeated violation par server suspend/ban ho sakta hai.
Ye code sirf normal, human-jaisi halki movement karta hai — koi detection-evasion trick (packet spoofing, fingerprint fake karna, etc.) isme nahi hai, aur main wo add nahi karunga.
Agar genuinely 24/7 server chahiye, better long-term option ek sasta VPS (jaise low-cost Indian VPS providers) hai — wahan ye hi bot bina kisi ToS risk ke normal Minecraft server ke saath chalega.
