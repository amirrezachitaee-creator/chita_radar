# کرون بیرونی برای اسلات‌ها

کرون داخلی گیت‌هاب در عمل بین ۵۰ تا ۶۰ دقیقه دیر اجرا می‌شود. برای همین یک زمان‌بند بیرونی رایگان، رویداد `repository_dispatch` را در همان شش ساعت تهران صدا می‌زند و کرون داخلی فقط نقش پشتیبان را دارد.

## چه چیزی امن است

- محرک بیرونی هیچ‌وقت `force` نمی‌فرستد و گردش‌کار هم آن را از مسیر `repository_dispatch` نادیده می‌گیرد. اگر روزی کسی `force` بفرستد، اجرا با `DISPATCH_FORCE_REJECTED` رد می‌شود.
- پنجره زودهنگام ۵ دقیقه و پنجره دیرهنگام ۹۰ دقیقه است. ارسال دیرهنگام‌تر از ۹۰ دقیقه با `SLOT_EXPIRED` رد می‌شود و پستی نمی‌رود.
- قفل هم‌زمانی `slot-runner` از اجرای موازی جلوگیری می‌کند.
- وضعیت اسلات در `data/state.json` ثبت می‌شود؛ اجرای تکراری همان اسلات با `SLOT_ALREADY_DONE` رد می‌شود.
- کرون داخلی به‌عنوان پشتیبان سر جایش می‌ماند.

## پیش‌نیاز

یک توکن گیت‌هاب که اجازه نوشتن محتوا روی همین مخزن را داشته باشد. اگر توکن فعلی می‌تواند endpoint زیر را صدا بزند، همان کافی است و توکن دوم نساز. در غیر این صورت یک توکن محدود به همین مخزن با دسترسی زیر بساز:

- Contents: Read and write

توکن فقط در زمان‌بند بیرونی ذخیره می‌شود. آن را در چت، فایل مخزن یا آدرس ریموت نگذار.

## درخواست

```text
POST https://api.github.com/repos/amirrezachitaee-creator/chita_radar/dispatches
Accept: application/vnd.github+json
Authorization: Bearer <TOKEN>
Content-Type: application/json
```

بدنه:

```json
{
  "event_type": "slot-tick",
  "client_payload": {
    "mode": "send",
    "target": "main"
  }
}
```

هیچ `slot` و هیچ `force` در بدنه نباشد. انتخاب اسلات خودکار است.

## راه‌اندازی در cron-job.org

1. ثبت‌نام رایگان و ساخت یک job تازه.
2. آدرس بالا را در فیلد URL بگذار.
3. روش را روی `POST` بگذار.
4. دو هدر `Accept: application/vnd.github+json` و `Authorization: Bearer <TOKEN>` و هدر `Content-Type: application/json` را اضافه کن.
5. بدنه JSON بالا را در بخش body بگذار.
6. منطقه زمانی را `UTC` انتخاب کن و شش زمان زیر را بساز:

```text
05:00
08:00
10:30
13:30
17:00
19:30
```

اگر زمان‌بند منطقه زمانی تهران را پشتیبانی می‌کند، مستقیم این شش زمان را بگذار:

```text
08:30
11:30
14:00
17:00
20:30
23:00
```

7. بعد از ذخیره، از صفحه job یک اجرای آزمایشی بزن و در تب Actions مخزن، اجرای `slot-runner` با رویداد `repository_dispatch` را ببین.

## تست دستی از ویندوز

توکن را فقط در همان نشست پوور‌شل نگه دار و در تاریخچه یا فایل ذخیره نکن:

```powershell
$token = Read-Host "GitHub token"
$body = '{"event_type":"slot-tick","client_payload":{"mode":"dry","target":"review"}}'
Invoke-RestMethod -Method Post `
  -Uri "https://api.github.com/repos/amirrezachitaee-creator/chita_radar/dispatches" `
  -Headers @{ Accept = "application/vnd.github+json"; Authorization = "Bearer $token" } `
  -ContentType "application/json" `
  -Body $body
Remove-Variable token
```

پاسخ موفق `204` است. برای تست، حالت `dry` بفرست تا پستی ارسال نشود.

## اگر زمان‌بند بیرونی از کار افتاد

کرون داخلی هر شش ساعت اجرا می‌شود. اگر تأخیرش از ۹۰ دقیقه بیشتر شود، اسلات با `SLOT_EXPIRED` رد می‌شود و پستی نمی‌رود؛ این رفتار عمدی است تا خبر کهنه منتشر نشود. در این حالت job بیرونی را بررسی کن و یک بار `workflow_dispatch` دستی با حالت `send` بزن.
