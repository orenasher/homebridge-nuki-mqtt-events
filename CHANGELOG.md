# What's new · מה חדש

Every version in English and in Hebrew. The settings page of the plugin shows the latest ones under **What's new**.

## 1.19.0

### English
- New **"Lock Battery Low" sensor**: opens when the lock battery is at 20% or less and not charging, and alerts again every 2 hours until it is charged. Starting to charge stops the alerts. Percent, hours, night mode and name are in the settings page, with a test button.
- The **"Keypad Battery Low"** sensor now repeats every 2 hours (was every hour).
- No repeated alerts at night (23:00–07:00) for both.
- **Alerts in the settings page are now one card per sensor**, grouped by door, lock and keypad, each with its own settings and its own test button.

### עברית
- **חיישן "סוללת המנעול חלשה"** חדש: נפתח כשהסוללה של המנעול ב‑20% או פחות ולא בטעינה, ומתריע שוב כל שעתיים עד שמטעינים. ברגע שמתחילים לטעון — ההתראות נפסקות. את האחוז, הזמן, מצב הלילה והשם קובעים בדף ההגדרות, וכולל כפתור בדיקה.
- חיישן **"סוללת הקודן חלשה"** מתריע עכשיו כל שעתיים (במקום כל שעה).
- בלילה (23:00–07:00) אין התראות חוזרות בשניהם.
- **ההתראות בדף ההגדרות מסודרות עכשיו בכרטיס נפרד לכל חיישן**, בקבוצות של דלת, מנעול וקודן — לכל אחד ההגדרות שלו וכפתור בדיקה משלו.

## 1.18.0

### English
- New **"Keypad Battery Low" sensor**: opens when Nuki reports the keypad battery is low and alerts again every hour (a new notification each time) until the batteries are replaced. No repeats at night (23:00–07:00). Minutes, night mode and name are in the settings page, with a test button.

### עברית
- **חיישן "סוללת הקודן חלשה"** חדש: נפתח כשנוקי מדווחים שהסוללה של הקודן חלשה ומתריע שוב כל שעה (התראה חדשה בכל פעם) עד שמחליפים סוללות. בלילה (23:00–07:00) אין התראות חוזרות. את הדקות, מצב הלילה והשם קובעים בדף ההגדרות, וכולל כפתור בדיקה.

## 1.17.3

### English
- New **"Lock Jammed" sensor**: opens when the lock jams and closes when it works again. Build Home automations on it (e.g. a HomePod announcement) — an automation on the lock's own "jammed" state may not run. Test button included.

### עברית
- **חיישן "המנעול נתקע"** חדש: נפתח כשהמנעול נתקע ונסגר כשהוא חוזר לעבוד. בונים עליו אוטומציות ב‑Home (למשל הכרזה ב‑HomePod) — אוטומציה על מצב "נתקע" של המנעול עצמו לפעמים לא רצה. כולל כפתור בדיקה.

## 1.17.2

### English
- The "Keypad moved" alert is now off by default — turn it on in the settings page only if you have Nuki's theft-detection battery cover. Without it the sensor is removed from Home.

### עברית
- ההתראה "הקודן הוזז" כבויה עכשיו כברירת מחדל — מפעילים אותה בדף ההגדרות רק אם יש לכם את מכסה הסוללה של נוקי לזיהוי גניבה. בלעדיה החיישן מוסר מ‑Home.

## 1.17.1

### English
- New versions are now published to npm straight from GitHub (verified, with provenance). Nothing changes in the plugin itself.

### עברית
- גרסאות חדשות מתפרסמות עכשיו ל‑npm ישירות מ‑GitHub (מאומת, עם מקור מוצהר). בפלאגין עצמו לא השתנה כלום.

## 1.17.0

### English
- **Keypad moved alert** (Keypad 2 NFC with Nuki's theft-detection battery cover): when the keypad is moved or pulled off, a "Keypad Moved" sensor opens in Home and the lock reports tampering. Picked up from the Nuki activity log, and from MQTT if Nuki sends it there.
- **Activity history** in the settings page: the last 20 actions — who, what, when and how (fingerprint, code, app, Home, button). Wrong keypad codes are marked.
- **Test buttons** for the alerts (keypad moved, forced open, door left open): a real notification goes to Home and clears after 15 seconds.
- **What's new** box in the settings page, in English and Hebrew.

### עברית
- **התראה כשמזיזים את הקודן** (קודן Keypad 2 NFC עם מכסה הסוללה של נוקי לזיהוי גניבה): כשמזיזים או עוקרים את הקודן, נפתח ב‑Home חיישן "הקודן הוזז" והמנעול מדווח על חבלה. הזיהוי מגיע מיומן הפעילות של נוקי, ומ‑MQTT אם נוקי ישלחו את זה גם שם.
- **היסטוריית פתיחות** בדף ההגדרות: 20 הפעולות האחרונות — מי, מה, מתי ואיך (טביעת אצבע, קוד, אפליקציה, Home, כפתור). קוד שגוי בקודן מסומן.
- **כפתורי בדיקה** להתראות (קודן הוזז, פריצה, דלת פתוחה): התראה אמיתית נשלחת ל‑Home ונעלמת אחרי 15 שניות.
- **"מה חדש"** בדף ההגדרות, בעברית ובאנגלית.

## 1.16.8

### English
- "Who opened" sensors also for people who open with the Nuki app, named "<name> (app)".

### עברית
- חיישני "מי פתח" גם למי שפותח עם אפליקציית נוקי, בשם "<שם> (app)".

## 1.16.7

### English
- The forced-open alert waits 10 seconds for the lock's report and clears itself if an unlock arrives late — no more false alerts when opening from inside.

### עברית
- התראת הפריצה מחכה 10 שניות לדיווח של המנעול ומתבטלת לבד אם פתיחת הנעילה מגיעה באיחור — בלי התראות שווא כשפותחים מבפנים.

## 1.16.0 – 1.16.6

### English
- A "who opened" sensor for each person on the Nuki Keypad, with a name of your choice for Apple Home and a tick for who gets a sensor.
- People Nuki Web does not know yet are learned from the first time they open.
- Renaming the alert sensors in the settings page renames them in Home.

### עברית
- חיישן "מי פתח" לכל אדם בקודן של נוקי, עם שם לבחירתכם ב‑Apple Home וסימון למי ליצור חיישן.
- מי ש‑Nuki Web עוד לא מכיר נלמד מהפעם הראשונה שהוא פותח.
- שינוי שם של חיישני ההתראות בדף ההגדרות משנה אותו גם ב‑Home.
