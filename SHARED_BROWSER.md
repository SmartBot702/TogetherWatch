# Umumiy masofaviy brauzer

Xonadagi Umumiy brauzer — bitta masofaviy Chromium sahifasi. Barcha ishtirokchilar bir xil sahifani ko‘radi; bosish, yozish, aylantirish va navigatsiya umumiy sessiyaga ta’sir qiladi. Tasvirlar taxminan sekundiga bir marta yangilanadi, bu yuqori FPS video oqimi emas.

## To‘liq stackni ishga tushirish

Talablar: Docker Engine, Docker Compose v2 va (VPS uchun) ochiq 80/443-portli domen.

    git clone https://github.com/SmartBot702/TogetherWatch.git
    cd TogetherWatch
    umask 077
    printf 'BROWSER_TOKEN=%s\nPOSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > .env
    docker compose up --build -d
    docker compose ps

Mahalliy: http://localhost:3000. Bu konfiguratsiya PostgreSQL ma’lumotlarini Docker volume’da saqlaydi, Browserless’ni faqat ichki Docker tarmog‘ida ushlab turadi va DB’ni brauzer konteyneridan alohida ichki tarmoqqa joylaydi.

### VPS’da HTTPS

1. Domeningizning DNS A/AAAA yozuvini VPS IP manziliga yo‘naltiring.
2. .env ichiga DOMAIN=watch.example.com qo‘shing (o‘z domeningizni yozing).
3. 80 va 443-portlarni ochib ishga tushiring:

    docker compose --profile production up --build -d

Caddy sertifikatni avtomatik oladi. Ilovaning 3000-porti host’da faqat 127.0.0.1 ga bog‘langan; tashqariga HTTPS reverse proxy orqali chiqadi.

## Mavjud hostingga ulash

Agar ilova boshqa joyda ishlasa, xususiy Browserless/Playwright-compatible Chromium endpoint’ni yarating va BROWSER_WS_ENDPOINT ni ilovaning secret/environment sozlamasiga kiriting. Endpoint va tokenni ommaga ochmang. Oddiy Node-only Render xizmati Browserless konteynerini o‘zi ishga tushirmaydi.

## Xavfsizlik

- .env faylini repozitoriyga commit qilmang; BROWSER_TOKEN va POSTGRES_PASSWORD maxfiy.
- Umumiy brauzerga kirgan har bir ishtirokchi sahifani boshqarishi mumkin. Login, to‘lov va shaxsiy ma’lumotlarni kiritmang.
- URL va resurslar uchun public HTTP/HTTPS tekshiruvi qo‘llanadi. Bu yagona himoya qatlami emas: browser konteynerini ichki xizmatlar va maxfiy ma’lumotlardan ajratilgan tarmoqda saqlang.
- CAPTCHA, DRM, sayt loginlari va bot-himoya sabab ayrim sahifalar ishlamasligi mumkin.
