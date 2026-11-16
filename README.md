# Prison Monitor Discord Bot

بوت دسكورد لاعدادات خاصة ومراقبة السجناء.

## التشغيل

1. انسخ `.env.example` إلى `.env`.
2. حط توكن البوت في `DISCORD_TOKEN`.
3. حط Discord ID حقك في `OWNER_IDS`.
4. فعل من بوابة دسكورد للبوت:
   - Message Content Intent
   - Server Members Intent
5. ثبت وشغل:

```bash
npm install
npm start
```

## الاوامر

الافتراضي:

```text
%settings
%اعدادات
```

اذا غيرت البرفكس مثلاً إلى `!` تصير:

```text
!settings
!اعدادات
```

كل اعدادات البوت محصورة على مالك التطبيق، و IDs الموجودة في `OWNER_IDS`، والمصرحين اللي تضيفهم من زر `اضافة مصرح`.
