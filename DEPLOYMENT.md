# دليل التشغيل والنشر السحابي 24/7 (يعمل دون الحاجة لبقاء هاتف الأندرويد متصلاً)

## 1. المتطلبات
- خادم VPS (مثل Ubuntu 22.04+ / Hetzner / DigitalOcean / Google Cloud Run) مع Docker و Docker Compose.
- بوت تيليجرام من `@BotFather` (احفظ `TELEGRAM_BOT_TOKEN` في ملف `.env` فقط، ولا ترفعه لمستودع عام).
- نطاق مع شهادة HTTPS (عبر Caddy أو Nginx + Let's Encrypt) لتشغيل Webhook تيليجرام وWebhooks المزودين وBinance Pay.

## 2. التشغيل السريع عبر Docker
```bash
cp .env.example .env
# عدّل .env وأضف TELEGRAM_BOT_TOKEN و TELEGRAM_OWNER_IDS و APP_ENCRYPTION_KEY
openssl rand -hex 32 # لتوليد APP_ENCRYPTION_KEY
docker compose up -d --build
```

## 3. تطبيق Migrations قاعدة البيانات
```bash
docker compose exec store-app npx drizzle-kit push --config=src/db/drizzle.config.ts
```

## 4. ربط Webhook بوت تيليجرام (يعمل 24 ساعة)
```bash
curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-domain.com/api/telegram/webhook",
    "secret_token": "YOUR_TELEGRAM_WEBHOOK_SECRET"
  }'
```
بعد الربط، أرسل `/admin` من حسابك المسجل في `TELEGRAM_OWNER_IDS` لإدارة المنتجات والأسعار والإيداعات والخوادم بالكامل من تيليجرام مباشرة.

## 5. التحديث الآمن
```bash
git pull origin main
docker compose up -d --build
```

## 6. النسخ الاحتياطي والاستعادة لقاعدة البيانات
```bash
# إنشاء نسخة احتياطية مضغوطة
docker compose exec -T postgres pg_dump -U postgres digital_store | gzip > backup_$(date +%F_%H%M).sql.gz

# استعادة نسخة احتياطية
gunzip -c backup_YYYY-MM-DD_HHMM.sql.gz | docker compose exec -T postgres psql -U postgres digital_store
```
