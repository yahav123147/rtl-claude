# RTL Claude — צ׳אט עברי לקלוד בתוך VS Code / Antigravity

תוסף שמוסיף פאנל צ'אט עברי מלא ל-VS Code או Antigravity, עם תמיכה ב-RTL מושלמת.
**אותו Claude, אותם כלים, ממשק שמכבד עברית.**

> **למה זה קיים?** הפאנל המקורי של Claude Code לא תומך ב-RTL — כל הטקסט העברי
> נדחף לצד שמאל ונראה הפוך. התוסף הזה בונה פאנל webview משלו עם RTL טבעי,
> תוך שימוש ב-Claude Agent SDK הרשמי כדי לקבל בדיוק את אותן יכולות.

![RTL Claude screenshot placeholder]

## תכונות

- ✅ **עברית מימין לשמאל מושלמת** — HTML טבעי, פונט Assistant
- ✅ **סיידבר ייעודי** עם אייקון בסרגל הפעילות
- ✅ **גישה מלאה לפרויקט** דרך Claude Agent SDK:
  - 📖 Read / Write / Edit — קריאה ועריכת קבצים
  - 🔍 Glob / Grep — חיפוש בקבצים
  - 💻 Bash — הרצת פקודות shell
  - 🌐 WebFetch / WebSearch — גישה לאינטרנט
- ✅ **קישורי קבצים לחיצים** בתשובות — קליק פותח את הקובץ בעורך עם הסמן בשורה הנכונה
- ✅ **שליחת קוד נבחר** — סמן קוד, `Cmd+Shift+L` שולח אותו לצ'אט
- ✅ **קונטקסט אוטומטי** של הקובץ הפתוח
- ✅ **שיחה ממשיכה** — היסטוריה נשמרת ב-workspace
- ✅ **סטרימינג בזמן אמת** של תשובות וקריאות לכלים
- ✅ **תצוגת כלים נוחה** — תראה כל פעולה, אפשר להרחיב לפרטים
- ✅ **theme-aware** — מתאים לכל theme של VS Code

## דרישות מקדימות

לפני שמתקינים, צריך:

1. **Node.js 18+**
   בדיקה: `node --version`
   התקנה: [nodejs.org](https://nodejs.org) או `brew install node`

2. **Claude Code CLI** מותקן ומאומת
   התקנה: `npm install -g @anthropic-ai/claude-code`
   אימות: `claude` (יבקש להתחבר ל-Claude.ai)

3. **VS Code, Antigravity, או Cursor**

## התקנה

```bash
git clone https://github.com/yahav123147/rtl-claude.git
cd rtl-claude
./install.sh
```

הסקריפט יזהה אוטומטית אם אתה משתמש ב-Antigravity, VS Code או Cursor, יתקין dependencies, יקמפל TypeScript, ויחבר את התוסף.

לאחר ההתקנה: `Cmd+Shift+P` → **"Reload Window"**.

עכשיו אתה אמור לראות **אייקון חדש בסרגל הפעילות** בצד. לחץ עליו או הקש `Cmd+Shift+H` כדי לפתוח את הצ'אט.

## קיצורי מקלדת

| קיצור | פעולה |
|------|--------|
| `⌘⇧H` | פתח את הצ׳אט |
| `⌘⇧L` | שלח קוד נבחר לצ׳אט |
| `Enter` | שלח הודעה |
| `Shift+Enter` | שורה חדשה |

## הגדרות

ב-Settings (`Cmd+,`) → חפש **"RTL Claude"**:

| הגדרה | ברירת מחדל | תיאור |
|--------|------------|-------|
| `rtlClaude.model` | `claude-opus-4-6` | מודל לשימוש (Opus / Sonnet / Haiku) |
| `rtlClaude.maxTurns` | `50` | מקסימום turns בכל בקשה |
| `rtlClaude.includeActiveFile` | `true` | כלול אוטומטית את שם הקובץ הפתוח כקונטקסט |

## פיתוח

```bash
npm install        # התקנת תלויות
npm run build      # קומפילציה חד-פעמית
npm run watch      # קומפילציה רציפה
```

לאחר שינויים: `Cmd+Shift+P` → **"Reload Window"**.

## מבנה הפרויקט

```
rtl-claude-extension/
├── src/
│   ├── extension.ts       # נקודת כניסה, רישום commands ו-views
│   ├── chatProvider.ts    # WebviewViewProvider, ניתוב הודעות
│   └── claudeClient.ts    # עטיפה ל-Claude Agent SDK
├── media/
│   ├── chat.html          # ה-UI של ה-webview
│   ├── chat.css           # עיצוב (RTL, theme-aware)
│   ├── chat.js            # לוגיקה client-side
│   ├── marked.min.js      # רנדור Markdown
│   └── sidebar-icon.svg   # אייקון בסרגל הפעילות
├── out/                   # פלט קומפילציה (gitignored)
├── package.json           # מניפסט התוסף
└── install.sh             # סקריפט התקנה
```

## פתרון תקלות

### "Claude Code process exited with code 1"
המשמעות: ה-SDK מזהה שאתה כבר רץ בתוך Claude Code. התוסף מנקה את המשתנים האלה אוטומטית, אבל אם זה קורה — תפתח issue עם הפלט המלא.

### לא רואה את האייקון בסרגל הצד
1. וודא שעשית `Reload Window` (`Cmd+Shift+P`)
2. בדוק ב-Output → "RTL Claude" אם יש שגיאות
3. פתח Developer Tools של ה-webview: `Cmd+Shift+P` → "Developer: Open Webview Developer Tools"

### השגיאה "claude not found"
התקן את Claude Code CLI: `npm install -g @anthropic-ai/claude-code`

## רישיון

MIT — ראה [LICENSE](LICENSE)

## תרומה

PRs יתקבלו בברכה. רעיונות לפיצ'רים? פתח issue.

---

נבנה באהבה עם Claude Code 🧡
