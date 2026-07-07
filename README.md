# 🤖 agents-system — Gemini дээр суурилсан олон агенттай систем

Google Gemini API ашигладаг, тус бүрдээ бие даан ажиллах чадвартай **6 CLI агент** бүхий Node.js monorepo.
Бүх агент `@google/genai` SDK-гээр Gemini загварыг (default: `gemini-2.5-flash`, `GEMINI_MODEL`-оор солино) дууддаг бөгөөд үр дүнгээ `/output` хавтсанд timestamp-тай нэрээр хадгална.

Агентууд **Firebase Realtime Database** дээр суурилсан хуваалцсан санах ойтой: ажлаа алхам алхмаар бүртгэж, олж мэдсэн зүйлээ context-д хуримтлуулж, тасарсан session-ээ үргэлжлүүлж чадна. Firebase тохируулаагүй бол санах ойгүйгээр хэвийн ажиллана.

## 📁 Бүтэц

```
agents-system/
├── package.json          # shared dependencies (ES Modules)
├── .env.example          # API түлхүүрүүдийн загвар
├── README.md
├── output/               # бүх агентын үр дүн энд хадгалагдана
└── src/
    ├── core/             # 🧠 хуваалцсан модулиуд
    │   ├── memory.js       # Firebase Realtime Database санах ой
    │   ├── runner.js       # алхмын гүйцэтгэл + session-ий амьдралын мөчлөг
    │   └── test-memory.js  # санах ойн тест
    ├── search-agent/     # 🔎 вэб хайлт (Tavily)
    ├── file-agent/       # 📂 файл хувиргалт
    ├── code-agent/       # 🛠  код үүсгэгч
    ├── data-agent/       # 📊 өгөгдлийн шинжилгээ
    ├── writer-agent/     # ✍️  контент бичигч
    └── db-agent/         # 🗄  өгөгдлийн сангийн дизайн
    # агент бүр index.js (CLI) + agent.js (логик) гэсэн 2 файлтай
```

## 🚀 Суулгах

```bash
cd agents-system
npm install
cp .env.example .env
# .env дотор GEMINI_API_KEY (заавал), TAVILY_API_KEY (search-agent-д) нэмнэ
```

Шаардлага: **Node.js 18+**

| Орчны хувьсагч | Хэрэглээ |
|---|---|
| `GEMINI_API_KEY` | Бүх агентад заавал — [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| `GEMINI_MODEL` | Ашиглах загвар (заавал биш; default: `gemini-2.5-flash`, ж: `gemini-2.5-pro`) |
| `TAVILY_API_KEY` | Search Agent-д заавал — [tavily.com](https://tavily.com) |
| `FIREBASE_DATABASE_URL`, `FIREBASE_SERVICE_ACCOUNT_PATH` | Санах ойд (заавал биш — доор үзнэ үү) |
| `GITHUB_TOKEN`, `GIT_REMOTE_URL` | Code Agent-ийн `--push` сонголтод (заавал биш) |
| `DB_CONNECTION_STRING` | DB Agent-д нөөцөлсөн (одоогоор файл л үүсгэнэ) |

## 🧠 Санах ой (Firebase Realtime Database) — сонголтоор

Firebase тохируулбал агент бүр өөрийн session-ийг `/agents` дор, дуусгасан ажлаа `/agent_history` дор бүртгэнэ. Алхам бүрийн статус, үргэлжлэх хугацаа, токены зарцуулалт болон агентын **хуримтлуулсан context** (олж мэдсэн зүйл, үүсгэсэн файл, гаргасан шийдвэрүүд) хадгалагдана. Энэ нь агентад «санах ой» өгч, `--resume <sessionId>`-ээр тасарсан ажлаа үргэлжлүүлэх (crash recovery) боломж олгоно.

**Тохируулаагүй бол** агентууд `⚠️ Firebase not configured — running without memory` гэж бичээд санах ойгүйгээр хэвийн ажиллана.

### Тохируулах алхмууд

1. [Firebase Console](https://console.firebase.google.com) руу орно
2. Шинэ project үүсгэнэ
3. **Realtime Database**-ийг идэвхжүүлнэ (Build → Realtime Database → Create Database)
4. **Project Settings → Service Accounts → Generate New Private Key** дарж JSON татна
5. Уг файлыг project-ийн үндэс дор `firebase-service-account.json` нэрээр хадгална
   (⚠️ энэ файл нууц — `.gitignore`-д орсон, git-д хэзээ ч бүү commit хий)
6. Database URL-ээ `.env` дотор хуулна:
   ```
   FIREBASE_DATABASE_URL=https://your-project-default-rtdb.firebaseio.com
   FIREBASE_SERVICE_ACCOUNT_PATH=./firebase-service-account.json
   ```

### Санах ойн бүтэц

```
/agents/agent_session_<UUID>
  ├── id, created_at, goal, agent_type
  ├── status: running | completed | failed | paused
  ├── current_step, total_steps
  ├── steps[]     — { index, action, description, status, started_at,
  │                   completed_at, result, error, duration_ms, tokens_used }
  ├── context     — { accumulated_knowledge, files_created[],
  │                   decisions_made[], last_gemini_response }
  └── metadata    — { total_tokens, total_api_calls, total_duration_ms, errors_count }

/agent_history/history_<UUID>
  └── { agent_id, agent_type, goal, status, completed_at, summary }
```

### Санах ойн тест

Firebase зөв ажиллаж буйг шалгах:

```bash
npm run test:memory          # эсвэл: node src/core/test-memory.js
```

Тест нь context нэгтгэх логикийг офлайн шалгаад, Firebase тохируулсан үед session
үүсгэх → 3 алхам → context хуримтлуулах → дуусгах → жагсаах → сэргээх бүх урсгалыг
шалгана. Бүгд амжилттай бол `✅ Memory system working!` гэж хэвлэнэ.
(Firebase тохируулаагүй бол офлайн шалгалтыг хийгээд integration хэсгийг алгасна.)

## 🤖 Агентууд — товч хүснэгт

| # | Агент | Зорилго | CLI тушаал |
|---|-------|---------|-----------|
| 1 | 🔎 **Search Agent** | Gemini хайлтын стратеги төлөвлөж, Tavily API-аар вэб хайлт хийгээд дүгнэлт бичнэ | `node src/search-agent/index.js "search for best React libraries"` |
| 2 | 📂 **File Agent** | CSV/JSON/TXT/MD файлуудыг уншиж, Gemini-ийн шийдсэн алхмаар хувиргана | `node src/file-agent/index.js "convert CSV to JSON" --file data.csv` |
| 3 | 🛠 **Code Agent** | Шаардлагаас бүрэн төслийн код + README үүсгэж, сонголтоор git push хийнэ | `node src/code-agent/index.js "generate React todo app with useState"` |
| 4 | 📊 **Data Agent** | CSV/JSON өгөгдөлд шинжилгээ хийж, ASCII chart бүхий тайлан гаргана | `node src/data-agent/index.js "analyze sales and find trends" --file sales.csv` |
| 5 | ✍️ **Writer Agent** | Блог, имэйл, сошиал пост, баримтжуулалт бичиж frontmatter-тай хадгална | `node src/writer-agent/index.js "write a blog post about AI" --tone professional` |
| 6 | 🗄 **DB Agent** | Өгөгдлийн сангийн schema/migration/query-г SQL, Prisma, TypeORM хэлбэрээр гаргана | `node src/db-agent/index.js "design ecommerce database schema" --format prisma` |

Агент бүр `--help` флагтай:

```bash
node src/search-agent/index.js --help
```

---

### 1. 🔎 Search Agent

**Зорилго:** Хэрэглэгчийн хүсэлтээр Gemini хэдэн query хэрэгтэйг өөрөө шийдэж, Tavily API-аар вэб хайлт хийгээд үр дүнг нэгтгэн дүгнэлт бичнэ.

```bash
node src/search-agent/index.js "search for best React libraries"
node src/search-agent/index.js "2026 оны JavaScript framework харьцуулалт"
```

- **Урсгал:** Gemini төлөвлөнө → Tavily хайна → Gemini дүгнэнэ → файлд хадгална
- **Үр дүн:** `output/search_YYYYMMDDHHmm.md` (дүгнэлт + түүхий үр дүн)
- **Шаардлага:** `GEMINI_API_KEY`, `TAVILY_API_KEY`

### 2. 📂 File Agent

**Зорилго:** Файл уншиж, хувиргалтын алхмуудыг Gemini шийдэж гүйцэтгээд шинэ файл болгож хадгална. CSV ↔ JSON, markdown heading задлах, JSON нэгтгэх г.м.

```bash
node src/file-agent/index.js "convert CSV to JSON" --file data.csv
node src/file-agent/index.js "extract headings from markdown" --file notes.md
node src/file-agent/index.js "merge two JSON files" --file a.json --file b.json
```

- **Дэмжих форматууд:** CSV (csv-parse), JSON, TXT, Markdown
- **Үр дүн:** `output/<нэр>_YYYYMMDDHHmm.<өргөтгөл>`

### 3. 🛠 Code Agent

**Зорилго:** Шаардлагаас бүрэн ажиллах төслийн код (бүх эх файл + README.md) үүсгэж, хүсвэл git commit + push хийнэ.

```bash
node src/code-agent/index.js "generate a React todo app with useState"
node src/code-agent/index.js "create a Node.js Express server with 3 routes" --name my-api
node src/code-agent/index.js "generate HTML/CSS landing page" --git --push
```

- **Сонголтууд:** `--name <нэр>`, `--git` (init+commit), `--push` (GIT_REMOTE_URL руу)
- **Үр дүн:** `output/PROJECT_NAME/` — бүх эх файл + суулгах зааварт README.md

### 4. 📊 Data Agent

**Зорилго:** CSV/JSON өгөгдлийг уншиж (papaparse), тоон баганын статистикийг бодож, Gemini-ээр чиг хандлага/дүгнэлт + ASCII chart, table бүхий тайлан гаргуулна.

```bash
node src/data-agent/index.js "analyze sales data and find trends" --file sales.csv
node src/data-agent/index.js "find top 10 products by revenue" --file products.csv
node src/data-agent/index.js "compare Q1 vs Q2 performance" --file quarters.json
```

- **Үр дүн:** `output/analysis_YYYYMMDDHHmm.md` — гол дүгнэлтүүд, ASCII chart/table
- Том өгөгдөл дээр эхний 100 мөрийн дээж + бүх мөрөөр бодсон статистикийг Gemini-д өгнө

### 5. ✍️ Writer Agent

**Зорилго:** Блог, имэйл, сошиал пост, техникийн баримтжуулалт бичиж, YAML frontmatter (title, date, format, tone, length)-тай Markdown болгож хадгална.

```bash
node src/writer-agent/index.js "write a 500-word blog post about AI" --tone professional
node src/writer-agent/index.js "write a technical tutorial on Node.js streams" --format docs --length long
node src/writer-agent/index.js "write 5 social media posts about Web3" --format social --tone casual
```

- **Сонголтууд:** `--tone casual|professional|humorous` · `--length short|medium|long` (≈200/≈500/1000+ үг) · `--format blog|email|social|docs`
- **Үр дүн:** `output/content_YYYYMMDDHHmm.md`

### 6. 🗄 DB Agent

**Зорилго:** Хүснэгтийн дизайн, migration, query-г Gemini-ээр зохиолгож SQL / Prisma / TypeORM хэлбэрээр файлд хадгална.

```bash
node src/db-agent/index.js "design a users table with authentication fields"
node src/db-agent/index.js "create database schema for ecommerce app" --format prisma
node src/db-agent/index.js "generate migration file for adding payments table"
node src/db-agent/index.js "write SQL query to get top 10 customers" --format sql
```

- **Сонголтууд:** `--format sql|prisma|typeorm` (default: sql)
- **Үр дүн:** `output/schema_YYYYMMDDHHmm.sql` / `.prisma` / `.ts` + консолд дизайны тэмдэглэл

---

## ⚡ npm товчлолууд

```bash
npm run search -- "search React frameworks"
npm run file   -- "convert to JSON" --file sample.csv
npm run code   -- "generate todo app"
npm run data   -- "find trends" --file sales.csv
npm run write  -- "blog post about AI" --tone casual
npm run db     -- "users table schema" --format prisma
npm run test:memory
```

## 🧰 Нийтлэг шинжүүд

- **ES Modules** (`"type": "module"`), Node.js 18+
- Бүх лог `[HH:MM:SS]` timestamp + алхмын дугаар + emoji-тэй
- Gemini API дуудлага бүрийн **хугацаа, токены тоо** (оролт/гаралт/thinking) логлогдоно
- Structured output: JSON хэрэгтэй газарт Gemini-ийн `responseSchema` ашигладаг тул хариу баталгаатай JSON байна
- Firebase бичилт бүр `💾 Firebase: …`, context шинэчлэлт `🧠 Context updated: …` гэж логлогдоно
- Санах ой (Firebase) **сонголтоор** — тохируулаагүй бол агент хэвийн ажиллана
- Тасарсан ажлыг `--resume <sessionId>`-ээр үргэлжлүүлнэ (crash recovery)
- Алдааг улаанаар хэвлэж `exit 1` (амжилттай бол `exit 0`); Firebase-ийн алдаа агентыг унагадаггүй
- Бүх үр дүнгийн файлын нэрэнд `YYYYMMDDHHmm` timestamp орно
- Хоосон/олдоогүй файл, буруу флагийг ойлгомжтой мессежээр зогсооно

## 📦 Shared dependencies

`@google/genai` · `axios` · `dotenv` · `papaparse` · `csv-parse` · `fs-extra` · `chalk` · `firebase-admin`
