# TogetherWatch

TogetherWatch — do‘stlar bilan masofadan birga tomosha qilish uchun watch-party platformasi: xona kodlari, sinxron video, chat, akkauntlar, ovoz/video qo‘ng‘iroqlar, ekran ulashish, whiteboard, havolalar kutubxonasi va umumiy masofaviy Chromium brauzeri.

## Tez ishga tushirish (Node.js)

Talablar: Node.js 18+.

    npm install
    npm start

Brauzerda http://localhost:3000 ni oching. Ikki brauzer oynasi yoki ikki qurilmada tekshiring.

## To‘liq Docker deployment (tavsiya)

Docker Engine va Docker Compose v2 kerak. VPS’da domenning DNS A/AAAA yozuvini server IP manziliga yo‘naltiring; 80 va 443-portlar ochiq bo‘lsin.

1. Repozitoriyani oling va maxfiy kalitlarni yarating:

    git clone https://github.com/SmartBot702/TogetherWatch.git
    cd TogetherWatch
    umask 077
    printf 'BROWSER_TOKEN=%s\nPOSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > .env

2. Avval mahalliy sinov uchun ishga tushiring:

    docker compose up --build -d
    docker compose ps
    docker compose logs -f togetherwatch

Mahalliy manzil: http://localhost:3000. Ilova PostgreSQL, Browserless/Chromium va doimiy Docker volume bilan ishlaydi. Brauzer servisi internetga ochiq port sifatida chiqarilmaydi; PostgreSQL alohida ichki tarmoqda turadi.

3. VPS’da HTTPS bilan chiqarish uchun .env fayliga domeningizni qo‘shing:

    echo 'DOMAIN=watch.example.com' >> .env

watch.example.com o‘rniga o‘zingizning domeningizni yozing, so‘ng:

    docker compose --profile production up --build -d

Caddy HTTPS sertifikatini avtomatik oladi. Domen DNS’i serverga qaragan va 80/443-portlar ochiq bo‘lishi shart. Sayt https://watch.example.com manzilida ishlaydi.

## Render

render.yaml Node.js xizmatining asosiy qismini joylashtiradi, lekin Docker Compose’dagi Browserless va PostgreSQL servislarini avtomatik ishga tushirmaydi. Render Free disk doimiy emas: qayta deploy/restart bo‘lsa yuklangan kinolar yo‘qolishi mumkin. Kinolarni saqlab qolish uchun doimiy disk biriktirilgan hosting yoki yuqoridagi Docker Compose volume’idan foydalaning. To‘liq umumiy brauzer va saqlanadigan akkauntlar uchun Docker stack yoki xususiy Chromium endpoint va PostgreSQL bilan alohida sozlash kerak.

## Imkoniyatlar

- Xona yaratish/qo‘shilish, taklif kodi va havola, 20 tagacha ishtirokchi.
- YouTube, Vimeo, VK Video, OK.ru, Rutube va Google Drive video havolalari; MP4/WebM/M4V/OGV hamda HLS uchun playback. YouTube/Vimeo va yuklangan videolarda sinxron boshqaruv mavjud; tashqi player imkoniyatlari platformaga bog‘liq.
- Xonaga 4 GB gacha bo‘lgan MP4/WebM/M4V/OGV kinoni bo‘laklab yuklash, HTTP Range orqali oqimli ijro va sinxron Play/Pause/seek. MAX_VIDEO_UPLOAD_MB bilan bitta video limitini, MAX_ROOM_VIDEO_GB bilan xona jami limitini sozlash mumkin.
- Qo‘llab-quvvatlanadigan video playerlarda 0.5×–2× ijro tezligini tanlash (tezlik har bir tomoshabinda alohida sozlanadi).
- Mahalliy `.srt` va `.vtt` subtitr fayllarini MP4/WebM/HLS yoki yuklangan videoga ulash. Xona egasi VTT subtitrni 512 KB gacha barcha ishtirokchilarga ulashishi mumkin; xona keyin qo‘shilganlar ham uni oladi. Subtitr YouTube/Vimeo/Drive iframe’larida ishlamaydi.
- Ovozli/video suhbatda aloqa uzilganda ulanish holati kuzatiladi; tiklanmasa, belgilangan tomon 1.2, 2.4 va 4.8 soniyalik oraliqlarda ko‘pi bilan 3 marta qayta urinadi. Muvaffaqiyatli ulanishda urinishlar hisoblagichi tozalanadi.
- Xona chatida xabarlarni qidirish, `@Ism_Familiya` ko‘rinishida ishtirokchini eslatish, xabarga javob berish va o‘z xabarini tahrirlash/o‘chirish mumkin; tahrirlash va o‘chirishni server muallif bilan tekshiradi.
- Umumiy chat, akkaunt/profil, do‘stlar va shaxsiy xabarlar.
- Ovoz/video qo‘ng‘iroqlari va WebRTC ekran ulashish.
- Bir xil masofaviy Chromium sahifasini hamma birga boshqaradigan umumiy brauzer.
- Umumiy havolalar, fayl ulashish va hamkorlikdagi doska.
- PostgreSQL’da akkauntlar va xona holatini saqlash; /health sog‘liq endpoint’i.

## Muhim cheklovlar va xavfsizlik

- Umumiy brauzerda barcha ishtirokchilar bir sahifani ko‘radi va boshqarishi mumkin. Parol, bank yoki boshqa maxfiy ma’lumotlarni kiritmang.
- Havolani tekshirish sahifadagi ochiq video teglarini va umumiy brauzerning ochiq tarmoq javoblarini aniqlashga urinadi. Video faqat Play bosilgandan keyin so‘raladigan ayrim saytlarda umumiy brauzerda Play bosib ko‘ring; mos ochiq MP4/WebM/HLS oqimi topilsa, xona egasiga sinxron playerga ulash tugmasi ko‘rinadi. Aniqlash barcha saytlar uchun kafolatlanmaydi; blob URL, DRM, login talab qiluvchi yoki faqat brauzer cookie’si bilan ochiladigan oqimlar ishlamasligi mumkin.
- Ovoz/video va ekran ulashish uchun HTTPS hamda brauzer ruxsatlari kerak. Ayrim tarmoqlarda TURN_URLS, TURN_USERNAME, TURN_CREDENTIAL sozlash talab etiladi.
- .env faylini GitHub’ga yuklamang. Docker volume’lar ma’lumotni saqlaydi; muntazam PostgreSQL backup ham sozlang.
- Google Drive preview iframe’ining ichki Play/Pause va vaqtini TogetherWatch bevosita boshqara olmaydi. Drive havolasini umumiy masofaviy brauzerda ochib, video ijrosini boshlash orqali ochiq media oqimini aniqlashga urinib ko‘rish mumkin, ammo Drive’ning vaqtinchalik yoki cookie talab qiladigan oqimi ko‘pincha umumiy playerga ko‘chmaydi. Bunday holatda Drive ruxsatini “Havolaga ega har kim — Viewer” qilib, Drive oynasida har bir tomoshabin o‘zi Play bosishi kerak.
- Katta video fayllari server diskida joy egallaydi va har bir tomoshabinga serverdan oqim uzatiladi; tashqi videolarni relay qilishda ham har bir tomoshabin uchun serverdan tashqi manbaga so‘rov tushishi mumkin. Bu CORS muammolarini kamaytiradi, lekin internet tezligini kafolatlamaydi; VPS bandwidth va trafik limitlarini hisobga oling. Docker Compose’da yuklangan videolar `togetherwatch_uploads` volume’ida saqlanadi.
- Kontentni qayta tarqatmang; video platformalarining mualliflik huquqi va foydalanish shartlariga rioya qiling.


## Telefon orqali foydalanish

- Xonaga telefon brauzeridan kiring. “Sayt” bo‘limidagi umumiy brauzerda manzil maydoniga URL yozib, “Umumiy brauzerni ochish”ni bosing.
- Sahifani bosish va surish sensorli boshqaruvni ishlatadi. “Sayt ichiga yozish” maydoni mobil klaviatura orqali matn yuboradi.
- Agar umumiy brauzer “xizmat sozlanmagan” desa, ilova serveriga BROWSER_WS_ENDPOINT maxfiy sozlamasi va ishlayotgan xususiy Chromium/Browserless xizmati kerak.
- Android/iOS brauzerlari qurilmaning butun ekranini har doim ham veb-saytga uzatishga ruxsat bermaydi. Bu holatni oddiy JavaScript bilan chetlab o‘tib bo‘lmaydi; native mobil ilova va tizim ekran capture ruxsati talab qilinishi mumkin.
- Telefon orqali video ko‘rsatish uchun “Video” bo‘limida YouTube/Vimeo yoki to‘g‘ridan-to‘g‘ri video URL’ni ulashish mumkin. DRM himoyasi va sayt qoidalari cheklov bo‘lishi mumkin.
