# 🤖 agents-system — Claude дээр суурилсан олон агенттай систем

Claude API ашигладаг, тус бүрдээ бие даан ажиллах чадвартай **6 CLI агент** бүхий Node.js monorepo.
Бүх агент `@anthropic-ai/sdk`-ээр `claude-opus-4-8` загварыг дууддаг бөгөөд үр дүнгээ `/output` хавтсанд timestamp-тай нэрээр хадгална.

## 📁 Бүтэц

```
agents-system/
├── package.json          # shared dependencies (ES Modules)
├── .env.example          # API түлхүүрүүдийн загвар
├── README.md
├── output/               # бүх агентын үр дүн энд хадгалагдана
└── src/
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
# .env дотор ANTHROPIC_API_KEY (заавал), TAVILY_API_KEY (search-agent-д) нэмнэ
```

Шаардлага: **Node.js 18+**

| Орчны хувьсагч | Хэрэглээ |
|---|---|
| `ANTHROPIC_API_KEY` | Бүх агентад заавал — [platform.claude.com](https://platform.claude.com) |
| `TAVILY_API_KEY` | Search Agent-д заавал — [tavily.com](https://tavily.com) |
| `GITHUB_TOKEN`, `GIT_REMOTE_URL` | Code Agent-ийн `--push` сонголтод (заавал биш) |
| `DB_CONNECTION_STRING` | DB Agent-д нөөцөлсөн (одоогоор файл л үүсгэнэ) |

## 🤖 Агентууд — товч хүснэгт

| # | Агент | Зорилго | CLI тушаал |
|---|-------|---------|-----------|
| 1 | 🔎 **Search Agent** | Claude хайлтын стратеги төлөвлөж, Tavily API-аар вэб хайлт хийгээд дүгнэлт бичнэ | `node src/search-agent/index.js "search for best React libraries"` |
| 2 | 📂 **File Agent** | CSV/JSON/TXT/MD файлуудыг уншиж, Claude-ийн шийдсэн алхмаар хувиргана | `node src/file-agent/index.js "convert CSV to JSON" --file data.csv` |
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

**Зорилго:** Хэрэглэгчийн хүсэлтээр Claude хэдэн query хэрэгтэйг өөрөө шийдэж, Tavily API-аар вэб хайлт хийгээд үр дүнг нэгтгэн дүгнэлт бичнэ.

```bash
node src/search-agent/index.js "search for best React libraries"
node src/search-agent/index.js "2026 оны JavaScript framework харьцуулалт"
```

- **Урсгал:** Claude төлөвлөнө → Tavily хайна → Claude дүгнэнэ → файлд хадгална
- **Үр дүн:** `output/search_YYYYMMDDHHmm.md` (дүгнэлт + түүхий үр дүн)
- **Шаардлага:** `ANTHROPIC_API_KEY`, `TAVILY_API_KEY`

### 2. 📂 File Agent

**Зорилго:** Файл уншиж, хувиргалтын алхмуудыг Claude шийдэж гүйцэтгээд шинэ файл болгож хадгална. CSV ↔ JSON, markdown heading задлах, JSON нэгтгэх г.м.

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

**Зорилго:** CSV/JSON өгөгдлийг уншиж (papaparse), тоон баганын статистикийг бодож, Claude-оор чиг хандлага/дүгнэлт + ASCII chart, table бүхий тайлан гаргуулна.

```bash
node src/data-agent/index.js "analyze sales data and find trends" --file sales.csv
node src/data-agent/index.js "find top 10 products by revenue" --file products.csv
node src/data-agent/index.js "compare Q1 vs Q2 performance" --file quarters.json
```

- **Үр дүн:** `output/analysis_YYYYMMDDHHmm.md` — гол дүгнэлтүүд, ASCII chart/table
- Том өгөгдөл дээр эхний 100 мөрийн дээж + бүх мөрөөр бодсон статистикийг Claude-д өгнө

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

**Зорилго:** Хүснэгтийн дизайн, migration, query-г Claude-оор зохиолгож SQL / Prisma / TypeORM хэлбэрээр файлд хадгална.

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
```

## 🧰 Нийтлэг шинжүүд

- **ES Modules** (`"type": "module"`), Node.js 18+
- Бүх лог `[HH:MM:SS]` timestamp + алхмын дугаар + emoji-тэй
- Claude API дуудлага бүрийн **хугацаа, токены тоо** логлогдоно
- Алдааг улаанаар хэвлэж `exit 1` (амжилттай бол `exit 0`)
- Бүх үр дүнгийн файлын нэрэнд `YYYYMMDDHHmm` timestamp орно
- Хоосон/олдоогүй файл, буруу флагийг ойлгомжтой мессежээр зогсооно

## 📦 Shared dependencies

`@anthropic-ai/sdk` · `axios` · `dotenv` · `papaparse` · `csv-parse` · `fs-extra` · `chalk`
